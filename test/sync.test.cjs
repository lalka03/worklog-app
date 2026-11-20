const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../sync.js');

const uid='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
const key='worklog.yandex.test.v1:'+uid;
function storage(){
  const records=new Map();
  return {records,getItem:key=>records.get(key)??null,setItem:(key,value)=>records.set(key,value)};
}
function data(date){return {version:1,settings:{anchor:'2026-11-13',p1:3,p2:3,p3:3,th1:3,th2:13,coef:1.5,rates:{1:280,2:322,3:350}},days:{[date]:{date}}};}
const first=data('2026-11-20');
const second=data('2026-11-21');
const empty=async()=>({data:null,revision:0});
const conflict=code=>Object.assign(new Error(code),{status:409,code});
const save=revision=>({revision,updatedAt:'2026-11-20T12:00:00Z'});
const deferred=()=>{ let resolve; const promise=new Promise(value=>{resolve=value;}); return {promise,resolve}; };

function bind(device, overrides={}){
  return create({uid,storage:device,api:{getWorklog:empty,putWorklog:async()=>save(1)},...overrides});
}

test('test_pending_retries_same_mutation across restart after losing the successful response', async () => {
  const disk=storage(), writes=[];
  const api={getWorklog:empty,putWorklog:async body=>{
    writes.push(body);
    if(writes.length===1) throw new TypeError('lost response');
    return save(1);
  }};
  const original=bind(disk,{api});
  await original.refresh();
  original.edit(first);
  await original.flush();
  assert.equal(original.load().error,'network');
  const persisted=JSON.parse(disk.records.get(key));
  assert.equal(persisted.pending.expectedRevision,0);
  original.close();
  const reopened=bind(disk,{api});
  await reopened.flush();
  assert.deepEqual(writes[0],writes[1]);
  assert.match(writes[1].mutationId,/^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(reopened.load().revision,1);
  assert.equal(reopened.load().pending,null);
});

test('unsent edits coalesce and in-flight requests remain immutable',async()=>{
  const response=deferred(), writes=[];
  const latest=data('2026-11-22');
  const sync=bind(storage(),{api:{getWorklog:empty,putWorklog:async body=>{
    writes.push(body);
    return writes.length===1 ? response.promise : save(2);
  }}});
  await sync.refresh();
  sync.edit(first);
  sync.edit(second);
  const pending=sync.flush();
  await Promise.resolve();
  sync.edit(latest);
  response.resolve(save(1));
  await pending;
  assert.deepEqual(writes.map(write=>write.data),[second,latest]);
  assert.deepEqual(writes.map(write=>write.expectedRevision),[0,1]);
  assert.notEqual(writes[0].mutationId,writes[1].mutationId);
  assert.deepEqual(sync.load().data,latest);
});

test('test_two_devices_conflict_preserves_draft across rebind and server choice', async () => {
  const disk=storage(), writes=[];
  let remote={data:null,revision:0};
  const api={getWorklog:async()=>remote,putWorklog:async body=>{
    writes.push(body);
    if(body.expectedRevision!==remote.revision) throw conflict('stale_revision');
    remote={data:body.data,revision:remote.revision+1};
    return save(remote.revision);
  }};
  const phone=bind(storage(),{api}), laptop=bind(disk,{api});
  await Promise.all([phone.refresh(),laptop.refresh()]);
  phone.edit(first);
  laptop.edit(second);
  await phone.flush();
  await laptop.flush();
  laptop.close();
  const reopened=bind(disk,{api});
  const draft=reopened.load().conflict;
  assert.equal(draft.reason,'stale_revision');
  assert.deepEqual(draft.local,second);
  assert.deepEqual(draft.server,first);
  assert.equal(writes.length,2);
  await reopened.resolveConflict('server');
  assert.deepEqual(reopened.load().data,first);
  assert.deepEqual(reopened.load().conflict.local,second);
  assert.equal(reopened.load().conflict.resolved,true);
  await reopened.flush();
  assert.equal(writes.length,2);
});

test('explicit retry after a mutation conflict uses current server revision and a new ID', async () => {
  const writes=[];
  let remote={data:first,revision:1};
  const api={getWorklog:async()=>remote,putWorklog:async body=>{
    writes.push(body);
    if(writes.length===1) {remote={data:first,revision:2}; throw conflict('mutation_mismatch');}
    return save(3);
  }};
  const sync=bind(storage(),{api});
  await sync.refresh();
  sync.edit(second);
  await sync.flush();
  assert.equal(sync.load().conflict.reason,'mutation_mismatch');
  await sync.resolveConflict('retry-local');
  assert.deepEqual(writes.map(write=>write.expectedRevision),[1,2]);
  assert.notEqual(writes[0].mutationId,writes[1].mutationId);
  assert.deepEqual(sync.load().data,second);
});

test('test_empty_server_no_cross_account_upload', async () => {
  const disk=storage();
  disk.setItem('worklog.test.v1:legacy',JSON.stringify(first));
  const original=bind(disk);
  await original.refresh();
  original.edit(first);
  original.close();
  const next=bind(disk,{uid:other,api:{getWorklog:empty,putWorklog:async()=>assert.fail('must not upload another account')}});
  await next.refresh();
  await next.flush();
  assert.equal(next.load().data,null);
  assert.equal(next.load().revision,0);
});

test('test_switch_ignores_old_inflight and does not clear queued writes', async () => {
  const disk=storage(), response=deferred(), updates=[];
  const original=bind(disk,{api:{getWorklog:empty,putWorklog:()=>response.promise},onState:value=>updates.push(value)});
  await original.refresh();
  original.edit(first);
  const pending=original.flush();
  await Promise.resolve();
  original.close();
  const changes=updates.length;
  const next=bind(disk,{uid:other});
  await next.refresh();
  const before=disk.records.get(key);
  response.resolve(save(1));
  await pending;
  assert.equal(next.load().data,null);
  assert.equal(updates.length,changes);
  assert.equal(disk.records.get(key),before);
});

test('an offline edit with no known revision cannot replace an existing server snapshot',async()=>{
  const sync=bind(storage(),{api:{getWorklog:async()=>({data:first,revision:1}),putWorklog:async()=>assert.fail('unbased draft cannot overwrite')}});
  sync.edit(second);
  await sync.flush();
  assert.deepEqual(sync.load().conflict.local,second);
  assert.deepEqual(sync.load().conflict.server,first);
});


test('edits queued during a polling read flush promptly and write once',async()=>{
  const read=deferred(), writes=[];
  let reads=0;
  const sync=bind(storage(),{api:{getWorklog:async()=>++reads===1?empty():read.promise,putWorklog:async body=>{
    writes.push(body);
    return save(1);
  }}});
  await sync.refresh();
  const polling=sync.refresh();
  await Promise.resolve();
  assert.equal(reads,2);
  sync.edit(first);
  const editing=sync.flush();
  read.resolve(await empty());
  await Promise.all([polling,editing]);
  assert.deepEqual(writes.map(write=>write.data),[first]);
  assert.equal(sync.load().pending,null);
});

test('permanently rejected writes keep the draft without retrying the same payload, including after rebind',async()=>{
  for(const status of [400,413,422]){
    const disk=storage(), writes=[];
    const api={getWorklog:empty,putWorklog:async body=>{
      writes.push(body);
      if(writes.length===1) throw Object.assign(new Error('rejected'),{status,code:'invalid_request'});
      return save(1);
    }};
    const sync=bind(disk,{api});
    await sync.refresh();
    sync.edit(first);
    await sync.flush();
    assert.deepEqual(sync.load().data,first);
    assert.match(sync.load().error,/^(invalid_worklog|worklog_too_large)$/);
    sync.close();
    const reopened=bind(disk,{api});
    assert.equal(reopened.load().error,sync.load().error);
    await reopened.refresh();
    await reopened.flush();
    assert.equal(writes.length,1);
    reopened.edit(second);
    await reopened.refresh();
    assert.deepEqual(writes.map(write=>write.data),[first,second]);
    assert.equal(writes[1].expectedRevision,0);
    assert.equal(reopened.load().pending,null);
  }
});

function reordered(snapshot){
  return {...snapshot,settings:Object.fromEntries(Object.entries(snapshot.settings).reverse())};
}

test('saving the in-flight snapshot again never retries its definitive rejection',async()=>{
  const writes=[], response=deferred();
  const sync=bind(storage(),{api:{getWorklog:empty,putWorklog:async body=>{
    writes.push(body);
    if(writes.length===1) await response.promise;
    throw Object.assign(new Error('invalid worklog'),{status:422});
  }}});
  await sync.refresh();
  sync.edit(first);
  const inFlight=sync.flush();
  await Promise.resolve();
  assert.equal(writes.length,1);
  const identical=reordered(first);
  assert.notEqual(JSON.stringify(identical),JSON.stringify(first));
  sync.edit(identical);
  sync.edit(second);
  sync.edit(identical);
  response.resolve();
  await inFlight;
  assert.equal(writes.length,1);
  assert.equal(sync.load().pending.mutationId,writes[0].mutationId);
  assert.equal(sync.load().error,'invalid_worklog');
  assert.deepEqual(sync.load().data,first);
});

test('saving an unchanged blocked draft after rebind preserves the rejection until content changes',async()=>{
  const disk=storage(), writes=[];
  const api={getWorklog:empty,putWorklog:async body=>{
    writes.push(body);
    if(writes.length===1) throw Object.assign(new Error('invalid worklog'),{status:422});
    return save(1);
  }};
  const sync=bind(disk,{api});
  await sync.refresh();
  sync.edit(first);
  await sync.flush();
  sync.close();
  const reopened=bind(disk,{api});
  assert.equal(reopened.edit(reordered(first)),true);
  await reopened.flush();
  assert.equal(writes.length,1);
  assert.equal(reopened.load().pending.mutationId,writes[0].mutationId);
  assert.equal(reopened.load().error,'invalid_worklog');
  assert.equal(reopened.edit(second),true);
  await reopened.flush();
  assert.deepEqual(writes.map(write=>write.data),[first,second]);
  assert.notEqual(writes[1].mutationId,writes[0].mutationId);
  assert.equal(reopened.load().pending,null);
});

test('a duplicate follow-up from an older cache stays blocked with its original mutation',async()=>{
  const disk=storage(), writes=[];
  const sync=bind(disk,{api:{getWorklog:empty,putWorklog:async()=>{throw new TypeError('lost response');}}});
  await sync.refresh();
  sync.edit(first);
  await sync.flush();
  sync.close();
  const legacy=JSON.parse(disk.records.get(key));
  legacy.data=legacy.pending.next=reordered(first);
  disk.records.set(key,JSON.stringify(legacy));
  const reopened=bind(disk,{api:{getWorklog:empty,putWorklog:async body=>{
    writes.push(body);
    throw Object.assign(new Error('invalid worklog'),{status:422});
  }}});
  await reopened.flush();
  assert.equal(writes.length,1);
  assert.equal(reopened.load().pending.mutationId,legacy.pending.mutationId);
  assert.equal(reopened.load().pending.next,null);
  assert.equal(reopened.load().error,'invalid_worklog');
});
