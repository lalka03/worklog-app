const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../api.js');

const baseUrl = 'https://worklog.example.test/gateway/';
const user = {uid:'00000000-0000-4000-8000-000000000001',email:'one@example.test',role:'employee'};
const auth = (value) => ({user,accessToken:`test-access-credential-${value}`,refreshToken:`test-refresh-credential-${value}`,expiresAt:'2026-11-20T12:00:00Z'});
const ok = (value) => Response.json(value);
const error = (status, code) => Response.json({error:code}, {status});
const deferred = () => { let resolve; const promise = new Promise(value=>{resolve=value;}); return {promise,resolve}; };

function protectedStore(initial=null){
  let value=initial;
  return {get:async()=>value,set:async token=>{value=structuredClone(token);},clear:async()=>{value=null;}};
}

test('remembered login stores only refresh credential and restores with rotation',async()=>{
  const store=protectedStore(), requests=[];
  const fetch=async(url,options)=>{
    const path=new URL(url).pathname, body=JSON.parse(options.body);
    requests.push([path,body]);
    if(path.endsWith('/login')) return ok(auth('a'));
    return ok(auth(body.refreshToken==='test-refresh-credential-a'?'b':'c'));
  };
  const first=create({baseUrl,fetch,rememberStore:store});
  await first.login(user.email,'secret',true);
  assert.equal(await store.get(),'test-refresh-credential-a');
  assert.deepEqual(requests[0][1],{email:user.email,password:'secret',remember:true});
  const reopened=create({baseUrl,fetch,rememberStore:store});
  assert.deepEqual(await reopened.restore(),user);
  assert.equal(await store.get(),'test-refresh-credential-b');
  assert.deepEqual(await reopened.renew(),user);
  assert.equal(await store.get(),'test-refresh-credential-c');
});

test('unchecked login clears previous remembered credential and unsupported storage does not request 30 days',async()=>{
  const store=protectedStore('old');
  const fetch=async(url,options)=>{assert.equal(JSON.parse(options.body).remember,undefined);return ok(auth('a'));};
  await create({baseUrl,fetch,rememberStore:store}).login(user.email,'secret');
  assert.equal(await store.get(),null);
  await create({baseUrl,fetch}).login(user.email,'secret',true);
});

test('offline restore preserves credential for retry; rejected restore clears it',async()=>{
  const store=protectedStore('test-refresh-credential-a');
  let mode='offline';
  const api=create({baseUrl,rememberStore:store,fetch:async()=>{
    if(mode==='offline') throw new TypeError('offline');
    return error(401,'invalid_session');
  }});
  await assert.rejects(api.restore(),{code:'network'});
  assert.equal(await store.get(),'test-refresh-credential-a');
  await assert.rejects(api.getWorklog(),{code:'invalid_session'});
  mode='expired';
  assert.equal(await api.restore(),null);
  assert.equal(await store.get(),null);
});

test('logout while restore is pending cannot recreate a remembered account',async()=>{
  const store=protectedStore('test-refresh-credential-a'), started=deferred(), response=deferred();
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
  const store=protectedStore('test-refresh-credential-a');
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
  assert.deepEqual(requests.filter(([path])=>path.endsWith('/renew')),[['/gateway/auth/renew',undefined,{refreshToken:'test-refresh-credential-a'}]]);
  assert.equal(requests.filter(([,token])=>token==='Bearer test-access-credential-b').length,2);
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
  assert.deepEqual(requests,[['/gateway/auth/login',undefined],['/gateway/auth/logout','Bearer test-access-credential-a']]);
});

test('old requests cannot renew or replay under a new login', async () => {
  const oldRequest=deferred();
  const api=create({baseUrl,fetch:async (url, options)=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/login')) return ok(auth(JSON.parse(options.body).email));
    if(path.endsWith('/logout')) return ok({});
    if(path.endsWith('/me/worklog') && options.headers['X-Worklog-Authorization']==='Bearer test-access-credential-old') return oldRequest.promise;
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

const start = Date.parse('2026-11-20T00:00:00Z');
const serverTime = '2026-11-20T00:00:00Z';
const refreshExpiresAt = '2026-11-21T00:00:00Z';
const rememberedAuth = value=>({...auth(value),refreshToken:'remembered-refresh-token-'+value,serverTime,refreshExpiresAt});
function offlineFixture(options={}){
  const store=protectedStore(), paths=[];
  let time=start, reply=async()=>ok(rememberedAuth('a'));
  const open=()=>create({...options,baseUrl,rememberStore:store,now:()=>time,fetch:async(url,opts)=>{
    paths.push([new URL(url).pathname,opts.body && JSON.parse(opts.body)]);
    return reply(url);
  }});
  return {open,store,paths,time:value=>{time=value;},reply:value=>{reply=value;},
    disconnect:()=>{reply=async()=>{throw new TypeError('offline');};}};
}
test('remembered record persists only refresh credential and bounded identity',async()=>{
  const f=offlineFixture(), api=f.open();
  await api.login(user.email,'private-password',true);
  assert.deepEqual(await f.store.get(),{token:'remembered-refresh-token-a',grant:{version:1,user,serverTime,refreshExpiresAt,verifiedLocalMs:start,checkedLocalMs:start}});
});
test('disconnected restart checkpoints identity and forbids all protected requests',async()=>{
  const f=offlineFixture();
  await f.open().login(user.email,'secret',true);
  f.disconnect(); f.time(start+1000);
  const api=f.open();
  assert.deepEqual(await api.restore(),user);
  assert.equal(api.isOffline(),true);
  assert.equal((await f.store.get()).grant.checkedLocalMs,start+1000);
  const count=f.paths.length;
  for(const action of [()=>api.getWorklog(),()=>api.putWorklog({data:{}}),()=>api.employees(),()=>api.createInvite()]){
    await assert.rejects(action);
  }
  assert.equal(f.paths.length,count);
  f.time(start+2000);
  assert.equal(await api.checkpointOffline(),true);
  assert.equal((await f.store.get()).grant.checkedLocalMs,start+2000);
  f.time(start+1500);
  assert.equal(api.offlineValid(),false);
  assert.equal(await api.checkpointOffline(),false);
  assert.equal(await f.store.get(),null);
});
test('offline deadline uses the earlier of absolute expiry and verified local remaining time',async()=>{
  for(const offset of [-3600000,3600000]){
    const f=offlineFixture(),api=f.open();
    f.time(start+offset);
    await api.login(user.email,'secret',true);
    f.time(start+86400000+Math.min(offset,0));
    f.disconnect();
    assert.equal(await api.enterOffline(),null);
    assert.equal(await f.store.get(),null);
  }
});
test('invalid server window saves legacy token without local identity',async()=>{
  for(const value of [undefined,'2026-11-20T00:00:00Z','2026-12-21T00:00:00Z','November 21 2026']){
    const f=offlineFixture(), api=f.open();
    f.reply(async()=>ok({...rememberedAuth('a'),refreshExpiresAt:value}));
    await api.login(user.email,'secret',true);
    assert.equal(await f.store.get(),'remembered-refresh-token-a');
    assert.equal(await api.enterOffline(),null);
  }
});
test('reconnect retries transport errors and single-flights rotation with fixed expiry and verified role',async()=>{
  const f=offlineFixture(),api=f.open();
  await api.login(user.email,'secret',true);
  assert.deepEqual(await api.enterOffline(),user);
  f.disconnect();
  await assert.rejects(api.reconnect(),{code:'network'});
  assert.equal(api.isOffline(),true);
  const answer=deferred(), admin={...user,role:'admin'};
  f.reply(()=>answer.promise);
  const a=api.reconnect(),b=api.reconnect();
  answer.resolve(ok({...rememberedAuth('b'),refreshExpiresAt:'2026-11-25T00:00:00Z',user:admin}));
  assert.deepEqual(await Promise.all([a,b]),[admin,admin]);
  assert.equal(api.isOffline(),false);
  assert.equal((await f.store.get()).grant.refreshExpiresAt,refreshExpiresAt);
  assert.deepEqual(f.paths.slice(1),Array(2).fill(['/gateway/auth/renew',{refreshToken:'remembered-refresh-token-a'}]));
  f.reply(async()=>ok({revision:7}));
  assert.deepEqual(await api.getWorklog(),{revision:7});
});
test('reconnect locks on revocation, malformed response or mismatched UID',async()=>{
  for(const response of [error(401,'expired'),error(403,'disabled'),ok({}),ok({...rememberedAuth('b'),user:{...user,uid:'00000000-0000-4000-8000-000000000002'}})]){
    const f=offlineFixture(),api=f.open();
    await api.login(user.email,'secret',true);
    await api.enterOffline();
    f.reply(async()=>response);
    await Promise.allSettled([api.reconnect()]);
    assert.equal(await f.store.get(),null);
    assert.equal(api.offlineValid(),false);
    await assert.rejects(api.getWorklog(),{code:'invalid_session'});
  }
});
test('logout supersedes delayed offline reconnect',async()=>{
  const f=offlineFixture(),api=f.open(),answer=deferred(),started=deferred();
  await api.login(user.email,'secret',true);
  await api.enterOffline();
  f.reply(async(url)=>{if(url.endsWith('/renew')){started.resolve();return answer.promise;}return ok({});});
  const pending=api.reconnect();
  await started.promise;
  await api.logout();
  answer.resolve(ok(rememberedAuth('b')));
  await assert.rejects(pending,{code:'session_changed'});
  assert.equal(await f.store.get(),null);
});
test('failed offline checkpoint locks the session and denies subsequent reads',async()=>{
  const f=offlineFixture(),api=f.open();
  await api.login(user.email,'secret',true);
  await api.enterOffline();
  f.store.set=async()=>{throw new Error('locked');};
  f.time(start+100);
  assert.equal(await api.checkpointOffline(),false);
  assert.equal(api.isOffline(),false);
  await assert.rejects(api.getWorklog(),{code:'invalid_session'});
});
test('a failed server restore cannot later expose the loaded grant through enterOffline',async()=>{
  const f=offlineFixture();
  await f.open().login(user.email,'secret',true);
  f.reply(async()=>error(503,'unavailable'));
  const api=f.open();
  await assert.rejects(api.restore(),{status:503});
  assert.equal(await api.enterOffline(),null);
  assert.equal(api.offlineValid(),false);
});
test('a second keystore failure on cleanup still returns false and drops local identity',async()=>{
  const f=offlineFixture(),api=f.open();
  await api.login(user.email,'secret',true);
  await api.enterOffline();
  f.store.set=f.store.clear=async()=>{throw Error('locked');};
  assert.equal(await api.checkpointOffline(),false);
  assert.equal(api.offlineValid(),false);
});
test('reconnect cannot rotate away a concurrently persisted later clock checkpoint',async()=>{
  const f=offlineFixture(),api=f.open(), started=deferred(), release=deferred(), waitRenew=deferred();
  await api.login(user.email,'secret',true);
  await api.enterOffline();
  const write=f.store.set;
  f.store.set=async value=>{if(value.token==='remembered-refresh-token-a'){started.resolve();await release.promise;} await write(value);};
  f.reply(async url=>url.endsWith('/renew')?waitRenew.promise:ok({}));
  const reconnect=api.reconnect();
  f.time(start+10000);
  const check=api.checkpointOffline();
  await started.promise;
  f.time(start+100);
  waitRenew.resolve(ok(rememberedAuth('b')));
  await new Promise(resolve=>setImmediate(resolve));
  f.time(start+10000);
  release.resolve();
  await check;
  await reconnect;
  f.time(start+100);
  assert.equal(api.offlineValid(),false);
});
test('malformed saved refresh credential cannot unlock encrypted local identity',async()=>{
  const f=offlineFixture();
  await f.open().login(user.email,'secret',true);
  const record=await f.store.get();
  await f.store.set({...record,token:'credential with whitespace'});
  f.disconnect();
  const api=f.open();
  assert.equal(await api.restore(),null);
  assert.equal(api.isOffline(),false);
  assert.equal(await f.store.get(),null);
});
test('legacy renewal upgrades to a grant and ordinary login regains online access after verification',async()=>{
  const f=offlineFixture(),api=f.open();
  await f.store.set('refresh-legacy');
  assert.deepEqual(await api.restore(),user);
  assert.equal((await f.store.get()).grant.user.uid,user.uid);
  await api.login(user.email,'secret',false);
  assert.equal(await api.enterOffline(),null);
  assert.deepEqual(await api.reconnect(),user);
  assert.equal(await f.store.get(),null);
  f.reply(async()=>ok({revision:2}));
  assert.deepEqual(await api.getWorklog(),{revision:2});
});
for(const action of ['restore','reconnect']){
  for(const status of [401,403]){
    test(action+' locks after received '+status+' headers when the response body stalls',async()=>{
      const f=offlineFixture({timeoutMs:20}), signedIn=f.open();
      await signedIn.login(user.email,'secret',true);
      const api=action==='restore'?f.open():signedIn;
      if(action==='reconnect') await api.enterOffline();
      f.reply(async()=>({ok:false,status,json:()=>new Promise(()=>{})}));
      assert.equal(await api[action](),null);
      assert.equal(api.offlineValid(),false);
      assert.equal(await f.store.get(),null);
      await assert.rejects(api.getWorklog(),{code:'invalid_session'});
    });
  }
}
for(const field of ['accessToken','refreshToken']){
  test('reconnect rejects malformed '+field+' before installing a rotated session',async()=>{
    for(const invalid of ['a'.repeat(21),'a'.repeat(129),'a'.repeat(21)+'!']){
      const f=offlineFixture(),api=f.open();
      await api.login(user.email,'secret',true);
      await api.enterOffline();
      f.reply(async()=>ok({...rememberedAuth('b'),[field]:invalid}));
      assert.equal(await api.reconnect(),null);
      assert.equal(await f.store.get(),null);
      assert.equal(api.offlineValid(),false);
      await assert.rejects(api.getWorklog(),{code:'invalid_session'});
    }
  });
}
for(const delayedWrite of [true,false]){
  test(delayedWrite?'final protected 401 invalidates an in-progress rotation':'late protected 401 preserves a completed newer rotation',async()=>{
    const f=offlineFixture(),api=f.open(),retryStarted=deferred(),retry=deferred(),writing=deferred(),release=deferred();
    await api.login(user.email,'secret',true);
    let rotations=0, reads=0;
    f.reply(async url=>{
      if(url.endsWith('/renew')) return ok(rememberedAuth(++rotations===1?'b':'c'));
      if(url.endsWith('/logout')) return ok({});
      if(++reads===1) return error(401,'invalid_session');
      if(reads===2){retryStarted.resolve();return retry.promise;}
      return ok({revision:3});
    });
    const rejectedRead=assert.rejects(api.getWorklog(),{status:401});
    await retryStarted.promise;
    const write=f.store.set;
    f.store.set=async record=>{writing.resolve();if(delayedWrite) await release.promise;await write(record);};
    const rotation=api.renew();
    await writing.promise;
    if(!delayedWrite) await rotation;
    retry.resolve(error(401,'invalid_session'));
    await new Promise(resolve=>setImmediate(resolve));
    release.resolve();
    if(delayedWrite) await assert.rejects(rotation,{code:'session_changed'});
    await rejectedRead;
    if(delayedWrite){
      assert.equal(await f.store.get(),null);
      assert.equal(api.offlineValid(),false);
      await assert.rejects(api.getWorklog(),{code:'invalid_session'});
    }else{
      assert.equal((await f.store.get()).token,'remembered-refresh-token-c');
      assert.deepEqual(await api.getWorklog(),{revision:3});
    }
  });
}

test('disconnect fences non-remembered employee pagination until explicit in-memory renewal',async()=>{
  const calls=[],firstPage=deferred();
  const api=create({baseUrl,fetch:async url=>{
    const {pathname,search}=new URL(url);calls.push(pathname+search);
    if(pathname.endsWith('/login') || pathname.endsWith('/renew')) return ok(auth('a'));
    if(pathname.endsWith('/employees') && !search) return firstPage.promise;
    return ok({users:{}});
  }});
  await api.login(user.email,'secret');
  const list=api.employees();
  await api.enterOffline();
  firstPage.resolve(ok({users:{},nextCursor:'next'}));
  await assert.rejects(list,{code:'session_changed'});
  await assert.rejects(api.getWorklog(),{code:'offline'});
  assert.deepEqual(calls,['/gateway/auth/login','/gateway/admin/employees']);
  assert.deepEqual(await api.renew(),user);
  await api.getWorklog();
  assert.deepEqual(calls.slice(2),['/gateway/auth/renew','/gateway/me/worklog']);
});

test('a late admin mutation 401 after disconnect cannot renew or replay its POST',async()=>{
  const mutation=deferred(), calls=[];
  const api=create({baseUrl,fetch:async url=>{
    calls.push(new URL(url).pathname);
    if(url.endsWith('/invites') && calls.length===2) return mutation.promise;
    if(url.endsWith('/invites')) return ok({});
    return ok(auth('a'));
  }});
  await api.login(user.email,'secret');
  const issue=api.createInvite();await api.enterOffline();
  mutation.resolve(error(401,'invalid_session'));
  await assert.rejects(issue,{code:'session_changed'});
  assert.deepEqual(calls,['/gateway/auth/login','/gateway/admin/invites']);
});

for(const remember of [false,true]){
  test('a disconnected '+(remember?'remembered':'ordinary')+' session retains in-flight rotation but requires fresh verification',async()=>{
    const store=protectedStore(), first=deferred(), firstStarted=deferred(), second=deferred(), calls=[];
    let live='a';
    const api=create({baseUrl,rememberStore:store,now:()=>start,fetch:async(url,opts)=>{
      const route=new URL(url).pathname.split('/').pop();calls.push(route);
      if(route==='login') return ok(rememberedAuth(live));
      if(route==='worklog') return error(401,'expired_access');
      if(route==='logout'){live=null;return ok({});}
      if(route==='renew'){
        if(!live || JSON.parse(opts.body).refreshToken!==rememberedAuth(live).refreshToken) return error(401,'invalid_session');
        if(live==='a'){live='b';firstStarted.resolve();await first.promise;}
        else {live='c';await second.promise;}
        return ok(rememberedAuth(live));
      }
      return ok({});
    }});
    await api.login(user.email,'secret',remember);
    const read=api.getWorklog().catch(e=>e.code);await firstStarted.promise;
    await api.enterOffline();
    const verifying=api.reconnect().catch(e=>e.code);
    first.resolve();
    assert.equal(await read,'session_changed');
    await assert.rejects(api.createInvite(),{code:'offline'});
    second.resolve();
    assert.deepEqual(await verifying,user);
    assert.equal(calls.includes('logout'),false);
    assert.equal(calls.filter(x=>x==='worklog').length,1);
    assert.equal(calls.filter(x=>x==='renew').length,2);
    await api.createInvite();
    assert.equal(calls.at(-1),'invites');
    assert.equal((await store.get())?.token,remember?rememberedAuth('c').refreshToken:undefined);
  });

  test('second disconnect during '+(remember?'remembered':'ordinary')+' verification keeps the fence and the rotated credential',async()=>{
    const store=protectedStore(),gate=deferred();let live='a';
    const api=create({baseUrl,rememberStore:store,now:()=>start,fetch:async(url,opts)=>{
      if(url.endsWith('/login')) return ok(rememberedAuth(live));
      if(url.endsWith('/renew')){
        if(JSON.parse(opts.body).refreshToken!==rememberedAuth(live).refreshToken) return error(401,'invalid_session');
        live=live==='a'?'b':'c';await gate.promise;
        return ok(rememberedAuth(live));
      }
      return ok({});
    }});
    await api.login(user.email,'secret',remember);await api.enterOffline();
    const attempt=api.reconnect().catch(e=>e.code);
    await api.enterOffline();gate.resolve();
    assert.equal(await attempt,'session_changed');
    await assert.rejects(api.createInvite(),{code:'offline'});
    assert.deepEqual(await api.reconnect(),user);
    await api.createInvite();
  });
}
for(const status of [429,502,503]){
  test('reconnect retains the grant and retries after HTTP '+status,async()=>{
    const f=offlineFixture(),api=f.open();
    await api.login(user.email,'secret',true);
    await api.enterOffline();
    const saved=await f.store.get();
    f.reply(async()=>error(status,'temporary_failure'));
    await assert.rejects(api.reconnect(),{status});
    assert.deepEqual(await f.store.get(),saved);
    assert.equal(api.offlineValid(),true);
    await assert.rejects(api.getWorklog(),{code:'offline'});
    f.reply(async()=>ok(rememberedAuth('b')));
    assert.deepEqual(await api.reconnect(),user);
    assert.equal((await f.store.get()).token,rememberedAuth('b').refreshToken);
  });
}
