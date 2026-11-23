'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../sync.js');

const UID = '00000000-0000-4000-8000-000000000091';
const OTHER = '00000000-0000-4000-8000-000000000092';
const KEY = id => 'worklog.yandex.test.v1:' + id;
const DAY = '2026-11-23';
const data = hours => ({
  version: 1,
  settings: {
    anchor: DAY, th1: 3, th2: 13, coef: 1.5, p1: 3, p2: 3, p3: 3,
    rates: {'1': 280, '2': 322, '3': 350}
  },
  days: {[DAY]: {date: DAY, main: {hours: String(hours), route: 1}}}
});
function storage() {
  const items = new Map(), writes = [];
  return {
    items,writes,
    getItem:key => items.get(key)??null,
    setItem:(key,value) => {writes.push([key,value]);items.set(key,value);}
  };
}
function fixture(disk, {id=UID, snapshot, revision, pending=null, conflict=null, omitOptional=false}) {
  disk.items.set(KEY(id), JSON.stringify(omitOptional?{data:snapshot,revision}:
    {data:snapshot,revision,pending,conflict}));
}
function makeApi(remote={data:null,revision:0}) {
  const writes=[], receipts=new Map();
  return {
    writes,remote,
    getWorklog:async()=>structuredClone(remote),
    putWorklog:async body => {
      writes.push(structuredClone(body));
      if(receipts.has(body.mutationId)) return receipts.get(body.mutationId);
      if(body.expectedRevision!==remote.revision) throw Object.assign(
        new Error('stale_revision'), {code:'stale_revision',status:409});
      remote.data=structuredClone(body.data);
      remote.revision++;
      const receipt={revision:remote.revision};
      receipts.set(body.mutationId,receipt);
      return receipt;
    },
    seedReceipt:(id,revision)=>receipts.set(id,{revision})
  };
}

test('pre-upgrade clean v1 cache without optional fields remains readable and is not rewritten on initial load', async()=>{
  const disk=storage(), legacy=data(2), server=makeApi({data:legacy,revision:3});
  fixture(disk,{snapshot:legacy,revision:3,omitOptional:true});
  const before=disk.items.get(KEY(UID));
  const app=create({uid:UID,storage:disk,api:server});
  assert.equal(app.load().error,null);
  assert.deepEqual(app.load().data,legacy);
  assert.equal(app.load().revision,3);
  assert.equal(app.load().pending,null);
  assert.equal(app.load().conflict,null);
  assert.equal(disk.items.get(KEY(UID)),before,'upgrade must not silently rewrite historical cache');
  await app.refresh();
  assert.equal(server.writes.length,0);
  assert.equal(disk.items.get(KEY(UID)),before);
});

test('pre-upgrade offline pending draft with unknown revision conflicts instead of overwriting server',async()=>{
  const disk=storage(),draft=data(5),serverData=data(3);
  const server=makeApi({data:serverData,revision:1});
  const pending={data:draft,expectedRevision:null,mutationId:'a'.repeat(32),
    sent:false,next:null};
  fixture(disk,{snapshot:draft,revision:null,pending});
  const app=create({uid:UID,storage:disk,api:server});
  assert.equal(app.load().error,null);
  await app.flush();
  assert.equal(server.writes.length,0);
  assert.deepEqual(app.load().conflict.local,draft);
  assert.deepEqual(app.load().conflict.server,serverData);
  assert.equal(app.load().conflict.reason,'unknown_revision');
  assert.deepEqual(server.remote,{data:serverData,revision:1});
});

test('pre-upgrade pending request committed on server is retried using the identical mutation receipt',async()=>{
  const disk=storage(),saved=data(7),id='b'.repeat(32);
  const server=makeApi({data:saved,revision:1});
  server.seedReceipt(id,1);
  fixture(disk,{snapshot:saved,revision:0,
    pending:{data:saved,expectedRevision:0,mutationId:id,sent:true,next:null}});
  const app=create({uid:UID,storage:disk,api:server});
  await app.flush();
  assert.equal(app.load().revision,1);
  assert.equal(app.load().pending,null);
  assert.deepEqual(server.remote,{data:saved,revision:1});
  assert.deepEqual(server.writes.map(x=>x.mutationId),[id]);
});

test('pre-upgrade saved conflict survives restart and remains available for user decision',async()=>{
  const disk=storage(),local=data(6),remoteData=data(8),server=makeApi({data:remoteData,revision:2});
  fixture(disk,{snapshot:local,revision:1,conflict:{
    local,server:remoteData,revision:2,reason:'stale_revision',resolved:false}});
  const before=disk.items.get(KEY(UID));
  const app=create({uid:UID,storage:disk,api:server});
  assert.equal(app.load().error,null);
  assert.deepEqual(app.load().conflict.local,local);
  await app.refresh();
  assert.deepEqual(app.load().data,local);
  assert.equal(server.writes.length,0);
  assert.equal(disk.items.get(KEY(UID)),before);
  app.close();
  const reopened=create({uid:UID,storage:disk,api:server});
  assert.deepEqual(reopened.load().conflict.local,local);
  await reopened.resolveConflict('server');
  assert.deepEqual(reopened.load().data,remoteData);
  assert.deepEqual(reopened.load().conflict.local,local,
    'old draft remains recoverable for export even after choosing server');
});

test('account-specific original v1 cache key and old data cannot leak into a different user',async()=>{
  const disk=storage(),own=data(3),other=data(9);
  fixture(disk,{snapshot:own,revision:1});
  fixture(disk,{id:OTHER,snapshot:other,revision:2});
  const first=create({uid:UID,storage:disk,api:makeApi({data:own,revision:1})});
  assert.deepEqual(first.load().data,own);
  const second=create({uid:OTHER,storage:disk,api:makeApi({data:other,revision:2})});
  assert.deepEqual(second.load().data,other);
  first.close();
  assert.deepEqual(second.load().data,other);
  assert.equal(disk.writes.some(([key])=>key!==KEY(UID)&&key!==KEY(OTHER)),false);
});

test('future release gate: production app identity and remembered native session implementation are untouched',()=>{
  const fs=require('node:fs');
  const cfg=JSON.parse(fs.readFileSync('capacitor.config.json','utf8'));
  assert.equal(cfg.appId,'com.worklog.app.yandex.test');
  const account=fs.readFileSync('account.js','utf8');
  const api=fs.readFileSync('api.js','utf8');
  assert.match(account,/worklog\.yandex\.test\.v1:/);
  assert.match(api,/async function restore\(\)/);
  assert.match(api,/async function checkpointOffline\(\)/);
  assert.match(api,/async function renewSession\(/);
});
