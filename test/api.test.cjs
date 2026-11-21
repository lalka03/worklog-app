const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../api.js');

const baseUrl = 'https://worklog.example.test/gateway/';
const user = {uid:'00000000-0000-4000-8000-000000000001',email:'one@example.test',role:'employee'};
const auth = (value) => ({user,accessToken:`access-${value}`,refreshToken:`refresh-${value}`,expiresAt:'2026-11-20T12:00:00Z'});
const ok = (value) => Response.json(value);
const error = (status, code) => Response.json({error:code}, {status});
const deferred = () => { let resolve; const promise = new Promise(value=>{resolve=value;}); return {promise,resolve}; };

function protectedStore(initial=null){
  let value=initial;
  return {get:async()=>value,set:async token=>{assert.equal(typeof token,'string'); value=token;},clear:async()=>{value=null;}};
}

test('remembered login stores only refresh credential and restores with rotation',async()=>{
  const store=protectedStore(), requests=[];
  const fetch=async(url,options)=>{
    const path=new URL(url).pathname, body=JSON.parse(options.body);
    requests.push([path,body]);
    if(path.endsWith('/login')) return ok(auth('a'));
    return ok(auth(body.refreshToken==='refresh-a'?'b':'c'));
  };
  const first=create({baseUrl,fetch,rememberStore:store});
  await first.login(user.email,'secret',true);
  assert.equal(await store.get(),'refresh-a');
  assert.deepEqual(requests[0][1],{email:user.email,password:'secret',remember:true});
  const reopened=create({baseUrl,fetch,rememberStore:store});
  assert.deepEqual(await reopened.restore(),user);
  assert.equal(await store.get(),'refresh-b');
  assert.deepEqual(await reopened.renew(),user);
  assert.equal(await store.get(),'refresh-c');
});

test('unchecked login clears previous remembered credential and unsupported storage does not request 30 days',async()=>{
  const store=protectedStore('old');
  const fetch=async(url,options)=>{assert.equal(JSON.parse(options.body).remember,undefined);return ok(auth('a'));};
  await create({baseUrl,fetch,rememberStore:store}).login(user.email,'secret');
  assert.equal(await store.get(),null);
  await create({baseUrl,fetch}).login(user.email,'secret',true);
});

test('offline restore preserves credential for retry; rejected restore clears it',async()=>{
  const store=protectedStore('refresh-a');
  let mode='offline';
  const api=create({baseUrl,rememberStore:store,fetch:async()=>{
    if(mode==='offline') throw new TypeError('offline');
    return error(401,'invalid_session');
  }});
  await assert.rejects(api.restore(),{code:'network'});
  assert.equal(await store.get(),'refresh-a');
  await assert.rejects(api.getWorklog(),{code:'invalid_session'});
  mode='expired';
  assert.equal(await api.restore(),null);
  assert.equal(await store.get(),null);
});

test('logout while restore is pending cannot recreate a remembered account',async()=>{
  const store=protectedStore('refresh-a'), started=deferred(), response=deferred();
  const api=create({baseUrl,rememberStore:store,fetch:async url=>{
    if(url.endsWith('/renew')){started.resolve();return response.promise;}
    return ok({});
  }});
  const restore=api.restore();
  await started.promise;
  await api.logout();
  response.resolve(ok(auth('b')));
  await assert.rejects(restore,{code:'session_changed'});
  assert.equal(await store.get(),null);
});

test('logout waits for delayed protected write and clears it before completion',async()=>{
  const store=protectedStore(), started=deferred(), release=deferred(), set=store.set;
  store.set=async token=>{started.resolve();await release.promise;await set(token);};
  const api=create({baseUrl,rememberStore:store,fetch:async url=>url.endsWith('/login')?ok(auth('a')):ok({})});
  const login=api.login(user.email,'secret',true);
  await started.promise;
  const logout=api.logout();
  release.resolve();
  await assert.rejects(login,{code:'session_changed'});
  await logout;
  assert.equal(await store.get(),null);
});

test('failed secure storage write never exposes restored account',async()=>{
  const store=protectedStore('refresh-a');
  store.set=async()=>{throw new Error('keystore unavailable');};
  const api=create({baseUrl,rememberStore:store,fetch:async url=>url.endsWith('/renew')?ok(auth('b')):ok({})});
  await assert.rejects(api.restore(),{code:'secure_storage'});
  assert.equal(await store.get(),null);
  await assert.rejects(api.getWorklog(),{code:'invalid_session'});
});

test('ordinary login remains possible when empty protected storage cannot write or clear',async()=>{
  const store=protectedStore();
  store.clear=async()=>{throw new Error('storage unavailable');};
  store.set=async()=>{throw new Error('storage unavailable');};
  const api=create({baseUrl,rememberStore:store,fetch:async(url,options)=>{
    assert.equal(JSON.parse(options.body).remember,undefined);
    return ok(auth('a'));
  }});
  assert.equal(await api.restore(),null);
  assert.deepEqual(await api.login(user.email,'secret'),user);
});

test('logout immediately following token install cancels the stale login return',async()=>{
  let tokens=null, api, logout;
  const tokenStore={get:()=>tokens,clear:()=>{tokens=null;},set:value=>{
    tokens=value; queueMicrotask(()=>{logout=api.logout();});
  }};
  api=create({baseUrl,tokenStore,rememberStore:protectedStore(),fetch:async url=>url.endsWith('/login')?ok(auth('a')):ok({})});
  await assert.rejects(api.login(user.email,'secret',true),{code:'session_changed'});
  await logout;
  await assert.rejects(api.getWorklog(),{code:'invalid_session'});
});

test('test_login_register_invite_payload', async () => {
  const requests=[];
  const api=create({baseUrl,fetch:async (url, options)=>{requests.push([new URL(url).pathname,JSON.parse(options.body)]); return ok(auth('a'));}});
  assert.deepEqual(await api.login('one@example.test','secret'),user);
  assert.deepEqual(await api.register('one@example.test','secret','one-time'),user);
  await api.reset('reset-code','new-secret');
  assert.deepEqual(requests,[
    ['/gateway/auth/login',{email:'one@example.test',password:'secret'}],
    ['/gateway/auth/register',{email:'one@example.test',password:'secret',invite:'one-time'}],
    ['/gateway/auth/reset',{code:'reset-code',newPassword:'new-secret'}]
  ]);
});

test('test_token_never_in_localstorage', async () => {
  const previous=globalThis.localStorage;
  globalThis.localStorage={setItem(){assert.fail('tokens must stay in memory');},getItem(){assert.fail('no tokens from storage');}};
  try {
    const api=create({baseUrl,fetch:async()=>ok(auth('a'))});
    const signedIn=await api.login('one@example.test','secret');
    assert.deepEqual(signedIn,user);
    const relaunched=create({baseUrl,fetch:async()=>assert.fail('no request with missing session')});
    await assert.rejects(relaunched.getWorklog(),{code:'invalid_session'});
  } finally {globalThis.localStorage=previous;}
});

test('test_401_renew_once with concurrent reads and another 401 after renewal', async () => {
  const requests=[];
  const api=create({baseUrl,fetch:async (url, options)=>{
    const path=new URL(url).pathname;
    const token=options.headers['X-Worklog-Authorization'];
    requests.push([path,token,options.body && JSON.parse(options.body)]);
    if(path.endsWith('/login')) return ok(auth('a'));
    if(path.endsWith('/renew')) return ok(auth('b'));
    return error(401,'invalid_session');
  }});
  await api.login('one@example.test','secret');
  await Promise.all([assert.rejects(api.getWorklog(),{status:401}),assert.rejects(api.getWorklog(),{status:401})]);
  assert.deepEqual(requests.filter(([path])=>path.endsWith('/renew')),[['/gateway/auth/renew',undefined,{refreshToken:'refresh-a'}]]);
  assert.equal(requests.filter(([,token])=>token==='Bearer access-b').length,2);
  await assert.rejects(api.getWorklog(),{code:'invalid_session'});
  assert.equal(requests.length,6);
});

test('test_logout_clears_token_even_if_offline', async () => {
  const requests=[];
  const api=create({baseUrl,fetch:async (url, options)=>{
    const path=new URL(url).pathname;
    requests.push([path,options.headers['X-Worklog-Authorization']]);
    if(path.endsWith('/login')) return ok(auth('a'));
    throw new TypeError('offline');
  }});
  await api.login('one@example.test','secret');
  await api.logout();
  await assert.rejects(api.getWorklog(),{code:'invalid_session'});
  assert.deepEqual(requests,[['/gateway/auth/login',undefined],['/gateway/auth/logout','Bearer access-a']]);
});

test('old requests cannot renew or replay under a new login', async () => {
  const oldRequest=deferred();
  const api=create({baseUrl,fetch:async (url, options)=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/login')) return ok(auth(JSON.parse(options.body).email));
    if(path.endsWith('/logout')) return ok({});
    if(path.endsWith('/me/worklog') && options.headers['X-Worklog-Authorization']==='Bearer access-old') return oldRequest.promise;
    assert.fail('stale request must not touch the current session');
  }});
  await api.login('old','secret');
  const pending=api.getWorklog();
  await api.logout();
  await api.login('new','secret');
  oldRequest.resolve(error(401,'invalid_session'));
  await assert.rejects(pending,{code:'session_changed'});
});

test('employees traverses cursor pages and rejects a repeated cursor', async () => {
  let repeat=false;
  const api=create({baseUrl,fetch:async (url)=>{
    const path=new URL(url);
    if(path.pathname.endsWith('/login')) return ok(auth('a'));
    if(!path.searchParams.has('cursor')) return ok({users:{first:{profile:{email:'one@example.test'},worklog:null}},nextCursor:'second'});
    assert.equal(path.searchParams.get('cursor'),'second');
    return ok({users:{second:{profile:{email:'two@example.test'},worklog:null}},...(repeat ? {nextCursor:'second'} : {})});
  }});
  await api.login('one@example.test','secret');
  assert.deepEqual(Object.keys((await api.employees()).users),['first','second']);
  repeat=true;
  await assert.rejects(api.employees(),{code:'invalid_response'});
});

test('transport uses HTTPS only, bounds an unresponsive request and strips local snapshot metadata', async () => {
  let sent;
  const api=create({baseUrl,timeoutMs:25,fetch:async (url, options)=>{
    if(new URL(url).pathname.endsWith('/login')) return ok(auth('a'));
    sent=JSON.parse(options.body);
    return new Promise(()=>{});
  }});
  const unconfigured=create({baseUrl:'http://worklog.example.test',fetch:async()=>assert.fail('insecure call')});
  await assert.rejects(unconfigured.login('one@example.test','secret'),{code:'unconfigured'});
  await api.login('one@example.test','secret');
  await assert.rejects(api.putWorklog({data:{version:1,settings:{},days:{},updatedAt:123},expectedRevision:0,mutationId:'a'}),{code:'timeout'});
  assert.deepEqual(sent,{data:{version:1,settings:{},days:{}},expectedRevision:0,mutationId:'a'});
});


test('PUT enforces the UTF-8 size of the complete request envelope',async()=>{
  const sent=[];
  const api=create({baseUrl,fetch:async(url,options)=>{
    if(new URL(url).pathname.endsWith('/login')) return ok(auth('a'));
    sent.push(Buffer.byteLength(options.body,'utf8'));
    return ok({revision:1,updatedAt:'2026-11-20T12:00:00Z'});
  }});
  await api.login('one@example.test','secret');
  const payload={data:{version:1,settings:{},days:{label:''}},expectedRevision:0,mutationId:'f'.repeat(32)};
  const remaining=512*1024-Buffer.byteLength(JSON.stringify(payload),'utf8');
  payload.data.days.label='é'.repeat(Math.floor(remaining/2))+'0'.repeat(remaining%2);
  await api.putWorklog(payload);
  assert.deepEqual(sent,[512*1024]);
  payload.data.days.label+='0';
  await assert.rejects(api.putWorklog(payload),{code:'worklog_too_large',status:413});
  assert.deepEqual(sent,[512*1024]);
});
