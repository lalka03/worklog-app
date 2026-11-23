'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const QA_EMAIL = 'worklog.cache.qa.20261123@example.com';
const source = fs.readFileSync('scripts/cache-qa-guard.js', 'utf8');

function createHarness({roles={}}={}) {
  const calls = [];
  const app = {
    login: async email => {calls.push(['login', email]); return {email,role:roles[email] || 'employee'};},
    register: async email => {calls.push(['register', email]); return {email,role:roles[email] || 'employee'};},
    restore: async () => {calls.push(['restore']); return {email:QA_EMAIL,role:'employee'};},
    renew: async () => {calls.push(['renew']); return {email:QA_EMAIL,role:'employee'};},
    reconnect: async () => {calls.push(['reconnect']); return {email:QA_EMAIL,role:'employee'};},
    logout: async () => {calls.push(['logout']);},
    getWorklog: async () => {calls.push(['getWorklog']);return {data:null,revision:0};},
    putWorklog: async () => {calls.push(['putWorklog']);return {revision:1};},
    createInvite: async () => {calls.push(['createInvite']);}
  };
  const ctx=vm.createContext({WorklogApi:{create:()=>app},console});
  vm.runInContext(source,ctx,{timeout:1000});
  return {calls,api:ctx.WorklogApi.create()};
}

test('Cache QA uses a distinct Android package and contains a fail-closed account guard', () => {
  const qa=JSON.parse(fs.readFileSync('capacitor.cache-qa.config.json','utf8'));
  const prod=JSON.parse(fs.readFileSync('capacitor.config.json','utf8'));
  assert.equal(qa.appId,'com.worklog.app.yandex.cacheqa');
  assert.equal(qa.appName,'Worklog Cache QA');
  assert.notEqual(qa.appId,prod.appId);
  assert.notEqual(qa.appId,'com.worklog.app.yandex.offlineqa');
  const stage=fs.readFileSync('scripts/stage-cache-qa-assets.cjs','utf8');
  assert.match(stage,/CACHE_QA_OFFLINE_LAB_ASSETS_READY/);
  assert.match(stage,/cache-qa-lab\.html/);
  assert.match(stage,/CACHE_QA_UNEXPECTED_WEB_ASSETS/);
  assert.doesNotMatch(stage,/stage-pilot-assets/);
  assert.match(fs.readFileSync('scripts/stage-cache-qa-android.cjs','utf8'),/CACHE_QA_NATIVE_IDENTITY_GUARD_STOP/);
});

test('unapproved account cannot log in or register and causes zero remote calls', async () => {
  const h=createHarness();
  for(const email of ['real.user@gmail.com','admin@example.test','',null,'other@example.com']){
    await assert.rejects(h.api.login(email),/qa_account_only/);
    await assert.rejects(h.api.register(email),/qa_account_only/);
  }
  assert.equal(h.calls.length,0);
  await assert.rejects(h.api.getWorklog(),/qa_account_only/);
  await assert.rejects(h.api.putWorklog({data:{}}),/qa_account_only/);
});

test('the exact synthetic employee can use login, isolated worklog and logout', async () => {
  const h=createHarness();
  assert.equal((await h.api.login(QA_EMAIL)).email,QA_EMAIL);
  assert.equal((await h.api.getWorklog()).revision,0);
  assert.equal((await h.api.putWorklog({data:{}})).revision,1);
  await h.api.logout();
  await assert.rejects(h.api.getWorklog(),/qa_account_only/);
  assert.deepEqual(h.calls.map(row=>row[0]),['login','getWorklog','putWorklog','logout']);
});

test('even a synthetic admin role is refused and cannot read another employee', async () => {
  const h=createHarness({roles:{[QA_EMAIL]:'admin'}});
  await assert.rejects(h.api.login(QA_EMAIL),/CACHE_QA_UNEXPECTED_ACCOUNT/);
  assert.deepEqual(h.calls.map(x=>x[0]),['login','logout']);
  await assert.rejects(h.api.getWorklog(),/qa_account_only/);
  await assert.rejects(h.api.createInvite(),/qa_account_only/);
});

test('all sensitive administrative and password reset entry points stay disabled', async () => {
  const h=createHarness();
  await h.api.login(QA_EMAIL);
  for(const method of ['reset','redeemRecovery','employees','employee','createInvite',
                       'listInvites','recoveryStatus','issueRecovery','revokeRecovery',
                       'revokeInvite','issueReset']){
    await assert.rejects(h.api[method](),/qa_account_only/,method);
  }
  assert.deepEqual(h.calls.map(row=>row[0]),['login']);
});

test('cold restore, reconnect, and renew can resume only the synthetic employee', async () => {
  const h=createHarness();
  assert.equal((await h.api.restore()).email,QA_EMAIL);
  await h.api.getWorklog();
  assert.equal((await h.api.renew()).role,'employee');
  assert.equal((await h.api.reconnect()).role,'employee');
  assert.deepEqual(h.calls.map(x=>x[0]),['restore','getWorklog','renew','reconnect']);
});

test('never stage an APK from an unreviewed or ambiguous Android identity', () => {
  const script = fs.readFileSync('scripts/stage-cache-qa-android.cjs','utf8');
  assert.match(script,/qa\.appName !== 'Worklog Cache QA'/);
  assert.match(script,/active\.appId !== qaId/);
  assert.match(script,/source\.startsWith\(header\)/);
});
