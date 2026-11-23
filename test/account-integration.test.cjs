const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const accounts = require('../account.js');

const alpha='00000000-0000-4000-8000-000000000001';
const beta='00000000-0000-4000-8000-000000000002';
const admin='00000000-0000-4000-8000-000000000003';
const html=fs.readFileSync('index.html','utf8');
const start=Date.parse('2026-11-20T12:00:00Z');
const timing={serverTime:'2026-11-20T12:00:00Z',refreshExpiresAt:'2026-12-20T12:00:00Z'};
function protectedRecord(uid,name){
  return {token:uid,grant:{version:1,user:{uid,email:name+'@example.test',role:name==='admin'?'admin':'employee'},
    ...timing,verifiedLocalMs:start,checkedLocalMs:start}};
}

function appHarness({remembered=null,native=false,renewOffline=false,clearFails=false,online=true,cached=new Map(),time=start}={}){
  const calls=[], records=new Map(), readErrors=new Map(), resetResponses=new Map(), clipboard=[];
  const controls={time,renewOffline}, events=new Map(), timers=new Map(), deferred=new Map();
  let timerId=0;
  const WorklogApi={create:options=>require('../api.js').create({...options,now:()=>controls.time,baseUrl:'https://worklog.example.test'})};
  const elements=new Map();
  function makeElement(){
    const handlers=new Map();
    let markup='';
    return {children:[],style:{},classList:{add(){},remove(){},toggle(){}},querySelectorAll:()=>[],
      get innerHTML(){return markup;},set innerHTML(value){markup=value;this.replaceChildren();},
      querySelector:()=>makeElement(), appendChild(child){child.remove();child.parentNode=this;this.children.push(child);},
      replaceChildren(){for(const child of [...this.children]) child.remove();},
      remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}},
      addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:name=>handlers.delete(name),
      click(){return this.onclick ? this.onclick() : handlers.get('click')?.();},setAttribute(){},reportValidity:()=>true,textContent:'',value:''};
  }
  const element=id=>{
    if(!elements.has(id)) elements.set(id,makeElement());
    return elements.get(id);
  };
  const users=new Map([[alpha,'alpha'],[beta,'beta'],[admin,'admin']]);
  const byEmail=email=>[...users].find(([,name])=>`${name}@example.test`===email);
  const fetch=async(url, options)=>{
    const path=new URL(url).pathname;
    const uid=options.headers['X-Worklog-Authorization']?.split(' ')[1];
    const body=options.body && JSON.parse(options.body);
    calls.push({path,uid,method:options.method,body});
    const respond=(data,status=200)=>Response.json(data,{status});
    if(deferred.has(path)) return await deferred.get(path);
    if(path!=='/auth/renew' && controls.networkDown) throw new TypeError('offline');
    if(path==='/auth/login' || path==='/auth/register'){
      const found=byEmail(body.email);
      if(path==='/auth/login' && !found) return respond({error:'invalid_credentials'},401);
      if(path==='/auth/register' && body.invite!=='valid') return respond({error:'invalid_invite'},422);
      const id=found?.[0]??beta;
      return respond({user:{uid:id,email:body.email,role:id===admin?'admin':'employee'},accessToken:id,refreshToken:id,...timing});
    }
    if(path==='/auth/logout') return respond({});
    if(path==='/auth/renew'){
      if(controls.reject) return respond({error:"invalid_session"},401);
      if(controls.renewOffline) throw new TypeError('offline');
      const id=body.refreshToken;
      const name=users.get(id);
      if(!name) return respond({error:'invalid_session'},401);
      return respond({user:{uid:id,email:`${name}@example.test`,role:id===admin?'admin':'employee'},accessToken:id,refreshToken:id,...timing});
    }
    if(path==='/auth/reset') return respond({});
    if(path==='/auth/recovery') return body.email==='admin@example.test' && body.code===controls.recoveryCode
      ?respond({}):respond({error:'invalid_recovery'},422);
    if(path==='/admin/recovery'){
      if(uid!==admin) return respond({error:'forbidden'},403);
      if(options.method==='GET') return respond({active:!!controls.recoveryCode});
      if(body.password!==recoveryPassword) return respond({error:'invalid_current_password'},422);
      if(options.method==='DELETE'){controls.recoveryCode=null;return respond({});}
      controls.recoveryCode=controls.recoveryCode===issuedRecovery?replacementRecovery:issuedRecovery;
      return respond({code:controls.recoveryCode});
    }
    if(readErrors.has(path)) return respond({error:'forbidden'},403);
    if(path==='/me/worklog'){
      const current=records.get(uid)??{data:null,revision:0};
      if(options.method==='GET') return respond(current);
      if(body.expectedRevision!==current.revision) return respond({error:'stale_revision'},409);
      const revision=current.revision+1;
      records.set(uid,{data:body.data,revision});
      return respond({revision,updatedAt:'2026-11-20T12:00:00Z'});
    }
    if(path==='/admin/employees') return respond({users:records.get('users')??{}});
    if(path==='/admin/invites') return respond({invites:[]});
    if(path.startsWith('/admin/users/') && path.endsWith('/reset')) return respond(await resetResponses.get(path.split('/')[3]));
    assert.fail(`Unexpected path: ${path}`);
  };
  const ctx=vm.createContext({WorklogAccounts:accounts,WorklogApi,WorklogSync:require('../sync.js'),
    document:{getElementById:element,querySelectorAll:()=>[],createElement:makeElement,addEventListener:(name,fn)=>events.set(name,fn)},
    window:{scrollTo(){},addEventListener:(name,fn)=>events.set(name,fn),...(native?{Capacitor:{isNativePlatform:()=>true,isPluginAvailable:name=>name==='RememberedSession',Plugins:{RememberedSession:{
      get:async()=>typeof remembered==="object" && remembered?remembered:{token:remembered},set:async record=>{remembered=record;},clear:async()=>{if(clearFails) throw new Error('storage unavailable');remembered=null;}
    }}}}:{})},fetch,URL,TextEncoder,navigator:{onLine:online,clipboard:{writeText:async value=>clipboard.push(value)}},
    localStorage:{getItem:k=>cached.get(k)||null,setItem:(k,v)=>cached.set(k,v),removeItem:k=>cached.delete(k)},
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),console});
  const source=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  vm.runInContext(source.replace(/\(function init\(\)\{[\s\S]*?\}\)\(\);\s*$/, '')+'\nconst originalRender=render; render=()=>{}; toast=()=>{};',ctx);
  const run=code=>vm.runInContext(code,ctx);
  return {controls,deferred,record:()=>remembered,fire:async name=>{
    if(name==='online' || name==='offline') ctx.navigator.onLine=name==='online';
    await events.get(name)?.();
  },tick:async()=>{const timer=[...timers].at(-1);if(timer){timers.delete(timer[0]);await timer[1]();}},calls,records,cached,readErrors,resetResponses,clipboard,ctx,run,element,
    login:(name,keep=false)=>run(`(async()=>bindAccount(await api.login('${name}@example.test','sample-password',${keep})))()`),
    logout:()=>run("document.getElementById('btnLogout').onclick()")};
}

test('Android login offers unchecked remember option, browser and registration do not',()=>{
  const h=appHarness({native:true});
  h.run("renderLogin(document.getElementById('app'))");
  assert.match(h.element('app').innerHTML,/id="loginRemember" type="checkbox"\s*>/);
  assert.match(h.element('app').innerHTML,/Запомнить меня.*30 дней/);
  h.run("authMode='register';renderLogin(document.getElementById('app'))");
  assert.doesNotMatch(h.element('app').innerHTML,/loginRemember/);
  const web=appHarness();
  web.run("renderLogin(document.getElementById('app'))");
  assert.doesNotMatch(web.element('app').innerHTML,/loginRemember/);
});

test('restored Android account binds only after server renewal',async()=>{
  const h=appHarness({native:true,remembered:alpha});
  assert.equal(h.run('activeUser'),null);
  await h.run('restoreRemembered()');
  assert.equal(h.run('activeUser.uid'),alpha);
  assert.equal(h.calls[0].path,'/auth/renew');
  assert.ok(h.calls.slice(1).every(call=>!call.uid || call.uid===alpha));
});

test('offline Android restore keeps private UI locked and permits local forget',async()=>{
  const h=appHarness({native:true,remembered:alpha,renewOffline:true});
  await h.run('restoreRemembered()');
  assert.equal(h.run('activeUser'),null);
  assert.equal(h.run('authReady'),false);
  h.run('originalRender()');
  assert.match(h.element('app').innerHTML,/Повторить/);
  assert.match(h.element('app').innerHTML,/Выйти/);
  await h.run('forgetRemembered()');
  assert.equal(h.run('authReady'),true);
  assert.equal(h.run('activeUser'),null);
  assert.equal(h.calls.length,1);
});

test('failed local forget never offers to restore the account the user just left',async()=>{
  const h=appHarness({native:true,remembered:alpha,renewOffline:true,clearFails:true});
  await h.run('restoreRemembered()');
  await h.run('forgetRemembered()');
  h.run('originalRender()');
  assert.equal(h.run('activeUser'),null);
  assert.match(h.element('app').innerHTML,/Повторить выход/);
  assert.doesNotMatch(h.element('app').innerHTML,/id="restoreRetry"/);
});

test('employee login, logout and next login never reuse another employee data or storage', async()=>{
  const h=appHarness();
  await h.login('alpha');
  h.run("DB.days['2026-11-20']={date:'2026-11-20'};saveDB()");
  await h.run('sync.flush()');
  assert.ok(h.cached.has('worklog.yandex.test.v1:'+alpha));
  assert.ok(h.records.get(alpha).data.days['2026-11-20']);
  await h.logout();
  assert.equal(h.run('Object.keys(DB.days).length'),0);
  await h.login('beta');
  assert.equal(h.run('Object.keys(DB.days).length'),0);
  h.run("DB.days['2026-11-21']={date:'2026-11-21'};saveDB()");
  await h.run('sync.flush()');
  assert.ok(h.records.get(beta).data.days['2026-11-21']);
  assert.equal(h.records.get(beta).data.days['2026-11-20'],undefined);
  assert.ok([...h.cached.values()].every(value=>!value.includes('sample-password')&&!value.includes('accessToken')&&!value.includes('refreshToken')));
});

test('test_admin_own_edit_and_employee_readonly',async()=>{
  const h=appHarness();
  h.records.set('users',{[alpha]:{profile:{email:'alpha@example.test'},worklog:null}});
  await h.login('admin');
  await h.run('refreshEmployees()');
  h.run(`selectEmployee('${alpha}')`);
  assert.equal(h.run('employeeRows(adminData)[0].email'),'alpha@example.test');
  h.run("state.tab='employees';originalRender()");
  const actions=h.element('app').children[0].children[2].children.map(button=>button.textContent);
  assert.ok(actions.includes('Выдать код восстановления'));
  assert.ok(!actions.includes('Сохранить'));
  h.run("DB.days['2026-11-20']={date:'2026-11-20'};saveDB()");
  await h.run('sync.flush()');
  assert.ok(h.records.get(admin).data.days['2026-11-20']);
  assert.deepEqual(h.calls.filter(call=>call.method==='PUT').map(({path,uid})=>[path,uid]),[['/me/worklog',admin]]);
  await h.logout();
  assert.equal(h.run('adminData'),null);
  assert.equal(h.run('isAdmin'),null);
});

test('employee calendar and totals use employee rates without changing personal records',async()=>{
  const h=appHarness();
  await h.login('admin');
  h.run("DB.settings.rates[1]=280; DB.days['2026-11-13']={date:'2026-11-13',main:{hours:2,route:1}}");
  const result=h.run("(()=>{const other=normalizeRemote({settings:{rates:{1:500}},days:{'2026-11-13':{date:'2026-11-13',main:{hours:3,route:1}}}});return [monthSummary(2026,10,other).total,monthSummary(2026,10).total,renderHome(other,2026,10),renderTotals(other)]})()");
  assert.equal(result[0],1500);
  assert.equal(result[1],560);
  assert.match(result[2],/1500,00 ₽/);
  assert.match(result[3],/1500,00 ₽/);
  assert.equal(h.run('DB.days[\'2026-11-13\'].main.hours'),2);
});
test('test_invite_management_hidden_for_staff',async()=>{
  const h=appHarness();
  await h.login('alpha');
  h.run("originalRender();setTab('employees')");
  await h.run('refreshEmployees()');
  assert.equal(h.run('state.tab'),'home');
  assert.equal(h.run('adminData'),null);
  assert.equal(h.element('navEmployees').style.display,'none');
  assert.equal(h.calls.some(call=>call.path.startsWith('/admin/')),false);
});
test('the employee selection is independent of the personal month and resets on logout',async()=>{
  const h=appHarness();

  h.records.set('users',{[alpha]:{profile:{email:'alpha@example.test'},worklog:{days:{}}}});
  await h.login('admin');
  await h.run('refreshEmployees()');
  h.run(`state.viewYear=2025;state.viewMonth=2;selectEmployee('${alpha}')`);
  assert.equal(h.run('employeeView.uid'),alpha);
  assert.equal(h.run('state.viewYear'),2025);
  assert.equal(h.run('state.viewMonth'),2);
  await h.logout();
  assert.equal(h.run('employeeView.uid'),null);
});
test('administrator gets the same personal home and add-shift controls plus an employee tab',async()=>{
  const h=appHarness();
  await h.login('admin');
  h.run('originalRender()');
  assert.equal(h.run("document.getElementById('navEmployees').style.display"),'flex');
  assert.equal(h.run("document.getElementById('btnAddToday').style.display"),'flex');
  assert.match(h.run("document.getElementById('app').innerHTML"),/Заработано за месяц/);
  await h.login('alpha');
  h.run('originalRender()');
  assert.equal(h.run("document.getElementById('navEmployees').style.display"),'none');
  assert.equal(h.run("document.getElementById('btnAddToday').style.display"),'flex');
});
test('a pending employee refresh cannot leak employee data into the next account',async()=>{
  const h=appHarness();h.records.set('users',{[alpha]:{profile:{email:'alpha@example.test'}}});
  await h.login('admin');
  const pending=h.run('refreshEmployees()');
  await h.login('alpha');
  await pending;
  assert.equal(h.run('adminData'),null);
  assert.equal(h.run('employeeView.uid'),null);
  assert.equal(h.run('scope.uid'),alpha);
});
test('malformed employee data does not crash the calendar or totals',()=>{
  const h=appHarness();
  const result=h.run("(()=>{const data=employeeWorklog({settings:{anchor:123,p1:'wrong',rates:{1:500}},days:[['2026-11-13',{main:{hours:3,route:1}}],['bad-date',{date:123,main:{hours:2,route:1}}]]});return [data.days['2026-11-13'].date,Object.keys(data.days).length,monthSummary(2026,10,data).total,renderTotals(data)]})()");
  assert.equal(result[0],'2026-11-13');
  assert.equal(result[1],1);
  assert.equal(result[2],1500);
  assert.match(result[3],/1500,00 ₽/);
});
test('revoked admin access removes previously loaded employee records',async()=>{
  const h=appHarness();h.records.set('users',{[alpha]:{profile:{email:'alpha@example.test'}}});
  await h.login('admin');
  await h.run('refreshEmployees()');h.run(`selectEmployee('${alpha}')`);
  h.readErrors.set('/admin/employees',true);
  await h.run('refreshEmployees()');
  assert.equal(h.run('adminData'),null);
  assert.equal(h.run('employeeView.uid'),null);
  assert.equal(h.run('isAdmin'),false);
});
test('a stale authentication completion cannot switch the now active account',async()=>{
  const h=appHarness();
  const first=h.run(`bindAccount({uid:'${alpha}',email:'alpha@example.test',role:'employee'})`);
  const second=h.run(`bindAccount({uid:'${beta}',email:'beta@example.test',role:'employee'})`);
  await Promise.all([first,second]);
  assert.equal(h.run('scope.uid'),beta);
});
test('a confirmation started by the previous employee cannot approve a data change after account switch',async()=>{
  const h=appHarness();
  await h.login('alpha');
  const answer=h.run("confirmModal('Delete','Delete a record')");
  await h.login('beta');
  h.run("document.getElementById('mOk').click()");
  assert.equal(await answer,false);
});

test('test_login_without_invite_allowed_only_existing',async()=>{
  const h=appHarness();
  h.run('originalRender()');
  assert.doesNotMatch(h.element('app').innerHTML,/loginInvite/);
  h.element('loginEmail').value='missing@example.test';
  h.element('loginPassword').value='sample-password';
  await h.element('loginForm').onsubmit({preventDefault(){}});
  assert.equal(h.run('activeUser'),null);
  h.run('originalRender()');
  h.element('registerBtn').click();
  h.run('originalRender()');
  assert.match(h.element('app').innerHTML,/loginInvite/);
  h.element('loginInvite').value='';
  await h.element('loginForm').onsubmit({preventDefault(){}});
  assert.equal(h.calls.filter(call=>call.path==='/auth/register').length,0);
  h.element('loginInvite').value='valid';
  await h.element('loginForm').onsubmit({preventDefault(){}});
  assert.equal(h.run('activeUser.email'),'missing@example.test');
  await h.logout();
  await h.login('alpha');
  assert.equal(h.run('activeUser.email'),'alpha@example.test');
});

test('test_no_firebase_scripts_or_calls', async()=>{
  const paths=[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(paths,['account.js','api.js','sync.js']);
  const h=appHarness();
  await h.login('alpha');
  assert.deepEqual(h.calls.map(call=>call.path),['/auth/login','/me/worklog']);
});

test('test_export_import_keeps_v1 and reads an older backup without a version field',async()=>{
  const h=appHarness();
  await h.login('alpha');
  h.run('bindSettings()');
  const days={'2026-11-20':{date:'2026-11-20',main:{route:'2',hours:'2.5',departure:'05:00',after:false}}};
  const imported=h.element('impFile').onchange({target:{files:[{text:async()=>JSON.stringify({days,settings:{rates:{2:'500'}}})}]}});
  await new Promise(resolve=>setImmediate(resolve));
  h.element('mOk').click();
  await imported;
  await h.run('sync.flush()');
  assert.equal(h.records.get(alpha).data.version,1);
  assert.deepEqual(h.records.get(alpha).data.days,days);
  assert.deepEqual(h.records.get(alpha).data.settings.rates,{1:280,2:'500',3:350});
  let exported;
  h.ctx.window.Capacitor={isNativePlatform:()=>true,isPluginAvailable:()=>true,Plugins:{
    Filesystem:{writeFile:async({data})=>{exported=JSON.parse(data);return {uri:'file:///test.json'};}},Share:{share:async()=>{}}}};
  await h.element('expBtn').onclick({currentTarget:h.element('expBtn')});
  assert.deepEqual(exported,h.records.get(alpha).data);
});


function descendants(element){
  return element.children.flatMap(child=>[child,...descendants(child)]);
}

async function resetHarness(){
  const h=appHarness();
  h.records.set('users',{
    [alpha]:{profile:{email:'alpha@example.test'},worklog:null},
    [beta]:{profile:{email:'beta@example.test'},worklog:null}
  });
  await h.login('admin');
  await h.run('refreshEmployees()');
  h.run(`state.tab='employees';selectEmployee('${alpha}');originalRender()`);
  return h;
}

const resetCode={code:'synthetic-alpha-code',expiresAt:'2026-11-21T12:00:00Z'};
const recoveryPassword='synthetic-current-password';
const issuedRecovery='synthetic-first-recovery-code';
const replacementRecovery='synthetic-next-recovery-code';

function recoveryControl(h,label){
  return descendants(h.element('app')).find(item=>item.textContent===label);
}
function recoveryField(h){
  return descendants(h.element('app')).find(item=>item.type==='password');
}
async function openSettings(h){
  h.run("setTab('settings');originalRender()");
  await new Promise(done=>setImmediate(done));
}

test('security settings are limited to administrators with a verified online session',async()=>{
  const h=appHarness();
  await h.login('alpha');await openSettings(h);
  assert.equal(recoveryControl(h,'Безопасность'),undefined);
  assert.ok(!h.calls.some(call=>call.path==='/admin/recovery'));
  await h.logout();await h.login('admin');await openSettings(h);
  assert.ok(recoveryControl(h,'Безопасность'));
  await h.fire('offline');
  assert.equal(recoveryControl(h,'Безопасность'),undefined);
  await h.fire('online');
  assert.equal(recoveryControl(h,'Безопасность'),undefined);
  await h.tick();
  assert.ok(recoveryControl(h,'Безопасность'));
});

test('recovery confirmation clears a wrong password and displays the validation error in Settings',async()=>{
  const h=appHarness();await h.login('admin');await openSettings(h);
  const field=recoveryField(h);
  assert.ok(field);
  field.value='wrong-password';
  const attempt=recoveryControl(h,'Создать резервный код').click();
  assert.equal(field.value,'');
  await attempt;
  assert.ok(recoveryControl(h,'Неверный текущий пароль.'));
  assert.equal(h.run('activeUser.uid'),admin);
  assert.ok(!h.calls.some(call=>['/auth/renew','/auth/logout'].includes(call.path)));
});

test('Settings displays each generated code once, replaces it and revokes it',async()=>{
  const h=appHarness({native:true});await h.login('admin',true);await openSettings(h);
  recoveryField(h).value=recoveryPassword;
  await recoveryControl(h,'Создать резервный код').click();
  const output=recoveryControl(h,issuedRecovery),copy=recoveryControl(h,'Скопировать код');
  assert.ok(output);
  assert.ok(descendants(h.element('app')).some(item=>item.textContent.includes('отдельно')));
  assert.deepEqual(h.clipboard,[]);
  await copy.click();
  assert.deepEqual(h.clipboard,[issuedRecovery]);
  let exported;
  Object.assign(h.ctx.window.Capacitor.Plugins,{
    Filesystem:{writeFile:async({data})=>{exported=data;return {uri:'file:///test.json'};}},Share:{share:async()=>{}}
  });
  h.ctx.window.Capacitor.isPluginAvailable=()=>true;
  await h.element('expBtn').onclick({currentTarget:h.element('expBtn')});
  for(const persisted of [exported,JSON.stringify(h.record()),JSON.stringify([...h.cached])]){
    assert.equal(typeof persisted,'string');
    assert.ok(!persisted.includes(issuedRecovery) && !persisted.includes(recoveryPassword));
  }
  recoveryControl(h,'Скрыть код').click();
  assert.equal(output.textContent,'');
  await copy.click();
  assert.deepEqual(h.clipboard,[issuedRecovery]);
  await openSettings(h);
  assert.equal(recoveryControl(h,issuedRecovery),undefined);
  recoveryField(h).value=recoveryPassword;
  await recoveryControl(h,'Заменить резервный код').click();
  assert.ok(recoveryControl(h,replacementRecovery));
  recoveryField(h).value=recoveryPassword;
  await recoveryControl(h,'Отозвать код').click();
  assert.equal(recoveryControl(h,replacementRecovery),undefined);
  assert.ok(recoveryControl(h,'Создать резервный код'));
  assert.equal(h.controls.recoveryCode,null);
});

for(const leave of ['navigation','logout','account change','disconnect','background']){
  test(`a pending recovery code cannot appear after ${leave}`,async()=>{
    const h=appHarness();await h.login('admin');await openSettings(h);
    let respond;
    h.deferred.set('/admin/recovery',new Promise(resolve=>{respond=resolve;}));
    const field=recoveryField(h);
    field.value=recoveryPassword;
    const issue=recoveryControl(h,'Создать резервный код').click();
    assert.equal(field.value,'');
    assert.ok(h.calls.some(call=>call.path==='/admin/recovery' && call.method==='POST'));
    if(leave==='navigation') h.run("setTab('home');originalRender()");
    if(leave==='logout' || leave==='account change') await h.logout();
    if(leave==='account change') await h.login('alpha');
    if(leave==='disconnect') await h.fire('offline');
    if(leave==='background'){h.ctx.document.hidden=true;await h.fire('visibilitychange');}
    h.deferred.delete('/admin/recovery');
    if(leave==='navigation' || leave==='account change') await openSettings(h);
    if(leave==='disconnect'){await h.fire('online');await h.tick();}
    if(leave==='background'){h.ctx.document.hidden=false;await h.fire('visibilitychange');}
    respond(Response.json({code:issuedRecovery}));
    await issue;h.run('originalRender()');
    assert.equal(recoveryControl(h,issuedRecovery),undefined);
    assert.deepEqual(h.clipboard,[]);
  });
}

test('backgrounding the app clears the displayed backup code and password',async()=>{
  const h=appHarness();await h.login('admin');await openSettings(h);
  recoveryField(h).value=recoveryPassword;
  await recoveryControl(h,'Создать резервный код').click();
  const output=recoveryControl(h,issuedRecovery),copy=recoveryControl(h,'Скопировать код');
  assert.ok(output);
  recoveryField(h).value=recoveryPassword;
  const field=recoveryField(h);
  h.ctx.document.hidden=true;await h.fire('visibilitychange');
  assert.equal(output.textContent,'');assert.equal(field.value,'');
  await copy.click();assert.deepEqual(h.clipboard,[]);
  h.ctx.document.hidden=false;await h.fire('visibilitychange');
  await new Promise(done=>setImmediate(done));
  assert.equal(recoveryControl(h,issuedRecovery),undefined);
  assert.ok(recoveryControl(h,'Заменить резервный код'));
});

test('administrator recovery requires internet, clears both credentials and returns to signed-out login',async()=>{
  const h=appHarness();
  h.controls.recoveryCode=issuedRecovery;
  h.run("authMode='reset';originalRender()");
  assert.match(h.element('app').innerHTML,/Резервный код администратора/);
  h.element('adminRecoveryBtn').click();h.run('originalRender()');
  assert.match(h.element('app').innerHTML,/id="loginEmail"/);
  assert.match(h.element('app').innerHTML,/id="loginInvite" type="password"/);
  const email=h.element('loginEmail'),password=h.element('loginPassword'),code=h.element('loginInvite');
  const submit=()=>h.element('loginForm').onsubmit({preventDefault(){}});
  await h.fire('offline');
  email.value='other@example.test';password.value='new-password-value';code.value=issuedRecovery;
  await submit();
  assert.equal(password.value,'');assert.equal(code.value,'');
  assert.equal(h.calls.length,0);
  await h.fire('online');
  password.value='new-password-value';code.value=issuedRecovery;
  const wrong=submit();
  assert.equal(password.value,'');assert.equal(code.value,'');
  await wrong;
  assert.match(h.element('loginStatus').textContent,/Резервный код недействителен или уже использован/);
  email.value='admin@example.test';password.value='new-password-value';code.value=issuedRecovery;
  await submit();h.run('originalRender()');
  assert.equal(h.run('activeUser'),null);
  assert.equal(h.run('authMode'),'login');
  assert.match(h.element('loginStatus').textContent,/Пароль обновлён/);
  assert.deepEqual(h.calls.map(call=>call.path),['/auth/recovery','/auth/recovery']);
});

test('the employee recovery form continues to submit its original payload',async()=>{
  const h=appHarness();
  h.run("authMode='reset';originalRender()");
  assert.doesNotMatch(h.element('app').innerHTML,/id="loginEmail"/);
  h.element('loginPassword').value='new-password-value';
  h.element('loginInvite').value=resetCode.code;
  await h.element('loginForm').onsubmit({preventDefault(){}});
  assert.equal(h.run('authMode'),'login');
  assert.deepEqual(h.calls,[{path:'/auth/reset',uid:undefined,method:'POST',body:{code:resetCode.code,newPassword:'new-password-value'}}]);
});

test('employee reset code names its recipient and cannot follow navigation or be copied after leaving',async()=>{
  const h=await resetHarness();
  h.resetResponses.set(alpha,resetCode);
  const reset=descendants(h.element('app')).find(item=>item.textContent==='Выдать код восстановления');
  const issue=reset.click();
  h.element('mOk').click();
  await issue;
  h.run('originalRender()');
  const controls=descendants(h.element('app'));
  assert.ok(controls.some(item=>item.value===resetCode.code));
  assert.ok(controls.some(item=>item.textContent.includes('Получатель: alpha@example.test')));
  const copy=controls.find(item=>item.textContent==='Скопировать код');
  await copy.click();
  assert.deepEqual(h.clipboard,[resetCode.code]);
  controls.find(item=>item.textContent==='К списку').click();
  h.run('originalRender()');
  assert.ok(!descendants(h.element('app')).some(item=>item.value===resetCode.code));
  h.run(`selectEmployee('${beta}');originalRender()`);
  assert.ok(!descendants(h.element('app')).some(item=>item.value===resetCode.code));
  await copy.click();
  assert.deepEqual(h.clipboard,[resetCode.code]);
});

test('a reset response is discarded when the operator changes recipient while it is pending',async()=>{
  const h=await resetHarness();
  let resolve;
  h.resetResponses.set(alpha,new Promise(done=>{resolve=done;}));
  const reset=descendants(h.element('app')).find(item=>item.textContent==='Выдать код восстановления');
  const issue=reset.click();
  h.element('mOk').click();
  await new Promise(done=>setImmediate(done));
  assert.ok(h.calls.some(call=>call.path===`/admin/users/${alpha}/reset`));
  h.run(`selectEmployee('${beta}');selectEmployee('${alpha}');originalRender()`);
  resolve(resetCode);
  await issue;
  h.run('originalRender()');
  assert.ok(!descendants(h.element('app')).some(item=>item.value===resetCode.code));
});

async function offlineApp(name='alpha'){
  const uid=name==='admin'?admin:alpha;
  const first=appHarness({native:true});
  await first.login(name,true);
  first.run("DB.days['2026-11-19']={date:'2026-11-19'};saveDB()");
  await first.run('sync.flush()');
  first.cached.set('worklog.yandex.test.v1:'+beta,'unrelated account');
  const h=appHarness({native:true,remembered:first.record(),cached:first.cached,renewOffline:true,online:false});
  h.records.set(uid,first.records.get(uid));
  await h.run('restoreRemembered()');
  return h;
}

test('offline cold start edits its own cache and verifies before uploading the draft',async()=>{
  const h=await offlineApp('admin');
  assert.equal(h.run('activeUser.uid'),admin);
  assert.equal(h.run('isAdmin'),false);
  assert.deepEqual([...h.run('Object.keys(DB.days)')],['2026-11-19']);
  h.run("setTab('employees');renderAdmin(document.getElementById('app'));refreshEmployees();refreshInvites();renderSyncStatus()");
  assert.equal(h.run('state.tab'),'home');
  assert.equal(h.element('app').children.length,0);
  assert.equal(h.element('syncStatus').textContent,'Без интернета. Изменения сохраняются на устройстве.');
  assert.equal(h.run("DB.days['2026-11-20']={date:'2026-11-20'};saveDB()"),true);
  await h.tick();
  assert.deepEqual(h.calls.map(x=>x.path),['/auth/renew']);
  h.controls.renewOffline=false;
  await h.fire('online');await h.tick();
  assert.deepEqual(h.calls.slice(1).map(x=>[x.path,x.method]),[['/auth/renew','POST'],['/me/worklog','PUT']]);
  assert.equal(h.calls.at(-1).body.expectedRevision,1);
  assert.ok(h.records.get(admin).data.days['2026-11-20']);
  assert.equal(h.run('isAdmin'),true);
  assert.equal(h.element('syncStatus').textContent,'Данные синхронизированы.');
});

test('reconnect conflict keeps the offline draft',async()=>{
  const h=await offlineApp();
  h.run("DB.days['2026-11-20']={date:'2026-11-20'};saveDB()");
  h.records.get(alpha).revision=2;h.controls.renewOffline=false;
  await h.fire('online');await h.tick();
  assert.ok(h.run("syncState.conflict?.local.days['2026-11-20']"));
  assert.equal(h.records.get(alpha).data.days['2026-11-20'],undefined);
});

for(const trigger of ['render','save','foreground','timer','rollback','revocation']){
  test('offline grant locks on '+trigger+' and retains only a UID-scoped draft',async()=>{
    const h=await offlineApp();
    h.run("DB.days['2026-11-20']={date:'2026-11-20'};saveDB()");
    if(trigger==='revocation'){
      h.controls.renewOffline=false;h.controls.reject=true;await h.fire('online');await h.tick();
    }else{
      h.controls.time=trigger==='rollback'?start-1:Date.parse(timing.refreshExpiresAt);
      if(trigger==='save') assert.equal(h.run('saveDB()'),false);
      else if(trigger==='render') h.run('originalRender()');
      else if(trigger==='timer') await h.tick();
      else await h.fire('visibilitychange');
    }
    assert.equal(h.run('activeUser'),null);
    assert.equal(h.run('Object.keys(DB.days).length'),0);
    assert.ok(JSON.parse(h.cached.get('worklog.yandex.test.v1:'+alpha)).pending.data.days['2026-11-20']);
  });
}

test('disconnect clears admin data and ignores old employee replies even after revalidation',async()=>{
  const h=appHarness();await h.login('admin');
  h.records.set('users',{[alpha]:{profile:{email:'alpha@example.test'}}});
  await h.run('refreshEmployees()');
  let finish;
  h.deferred.set('/admin/employees',new Promise(resolve=>{finish=resolve;}));
  const pending=h.run('refreshEmployees()');
  h.run("state.tab='employees'");
  await h.fire('offline');
  assert.equal(h.run('adminData'),null);
  assert.equal(h.run('state.tab'),'home');
  assert.equal(h.run('saveDB()'),true);
  await h.fire('online');await h.tick();
  finish(Response.json({users:{[beta]:{profile:{email:'beta@example.test'}}}}));
  await pending;
  assert.equal(h.run('adminData'),null);
});

test('backend network failure enters personal-only mode even when the device reports online',async()=>{
  const h=appHarness({native:true});await h.login('admin',true);
  h.controls.networkDown=true;h.controls.renewOffline=true;
  await h.run('runSync(session)');
  assert.equal(h.run('api.isOffline()'),true);
  assert.equal(h.run('isAdmin'),false);
  assert.equal(h.run('saveDB()'),true);
  await h.tick();
  assert.equal(h.calls.at(-1).path,'/auth/renew');
});

test('revoked offline account cannot upload its pending shift through the next login',async()=>{
  const h=await offlineApp();
  h.run("DB.days['2026-11-20']={date:'2026-11-20'};saveDB()");
  h.controls.reject=true;await h.fire('online');await h.tick();
  await h.login('beta');
  assert.equal(h.run('scope.uid'),beta);
  assert.equal(h.run('Object.keys(DB.days).length'),0);
  assert.ok(JSON.parse(h.cached.get('worklog.yandex.test.v1:'+alpha)).pending);
  assert.equal(h.calls.filter(call=>call.method==='PUT').length,0);
});

test('offline logout with failed secure deletion keeps the account locked and preserves its queued draft',async()=>{
  const h=appHarness({native:true,remembered:protectedRecord(alpha,'alpha'),renewOffline:true,online:false,clearFails:true});
  await h.run('restoreRemembered()');
  h.run("DB.days['2026-11-20']={date:'2026-11-20'};saveDB()");
  await h.logout();h.run('originalRender()');
  assert.equal(h.run('activeUser'),null);
  assert.match(h.element('app').innerHTML,/Повторить выход/);
  assert.ok(JSON.parse(h.cached.get('worklog.yandex.test.v1:'+alpha)).pending);
  assert.equal(h.calls.length,1);
});

test('reconnect keeps the personal form open and all admin and sync calls blocked until verification finishes',async()=>{
  const h=await offlineApp('admin');
  h.run("state.editDate='2026-11-20';state.settingsDirty=true");
  let done;
  h.deferred.set('/auth/renew',new Promise(resolve=>{done=resolve;}));
  await h.fire('online');const checking=h.tick();
  await new Promise(resolve=>setImmediate(resolve));
  await h.run('refreshEmployees()');await h.run('refreshInvites()');
  assert.equal(h.run('isAdmin'),false);
  assert.deepEqual(h.calls.map(x=>x.path),['/auth/renew','/auth/renew']);
  done(Response.json({user:protectedRecord(admin,'admin').grant.user,accessToken:admin,refreshToken:admin,...timing}));
  await checking;
  assert.equal(h.run('state.editDate'),'2026-11-20');
  assert.equal(h.run('state.settingsDirty'),true);
  assert.equal(h.run('isAdmin'),true);
});

test('foreground checkpoint rejects rollback across a later cold launch',async()=>{
  const h=await offlineApp();
  h.controls.time=start+10000;
  await h.fire('visibilitychange');
  const next=appHarness({native:true,remembered:h.record(),cached:h.cached,online:false,renewOffline:true,time:start+5000});
  await next.run('restoreRemembered()');
  assert.equal(next.run('activeUser'),null);
  assert.equal(next.calls.length,0);
});

test('admin service network failure clears previously loaded employee data immediately',async()=>{
  const h=appHarness({native:true});await h.login('admin',true);
  h.records.set('users',{[alpha]:{profile:{email:'alpha@example.test'}}});
  await h.run('refreshEmployees()');h.controls.networkDown=true;
  await h.run('refreshEmployees()');
  assert.equal(h.run('adminData'),null);
  assert.equal(h.run('isAdmin'),false);
  assert.equal(h.run('api.isOffline()'),true);
});

test('a delayed invitation list cannot return after disconnect and same-account verification',async()=>{
  const h=appHarness();await h.login('admin');
  h.run("state.tab='employees'");
  let done;
  h.deferred.set('/admin/invites',new Promise(resolve=>{done=resolve;}));
  const pending=h.run('refreshInvites()');
  await h.fire('offline');await h.fire('online');await h.tick();
  h.run("state.tab='employees'");
  done(Response.json({invites:[{id:'old',state:'available'}]}));
  await pending;
  assert.equal(h.run('invites.length'),0);
});

test('a second disconnect during revalidation leaves the grant personal-only',async()=>{
  const h=await offlineApp('admin');
  let done;
  h.deferred.set('/auth/renew',new Promise(resolve=>{done=resolve;}));
  await h.fire('online');const checking=h.tick();
  await new Promise(resolve=>setImmediate(resolve));
  await h.fire('offline');
  done(Response.json({user:protectedRecord(admin,'admin').grant.user,accessToken:admin,refreshToken:admin,...timing}));
  await checking;
  assert.equal(h.run('api.isOffline()'),true);
  assert.equal(h.run('isAdmin'),false);
  assert.equal(h.run('saveDB()'),true);
  assert.equal(h.calls.filter(x=>x.path==='/me/worklog').length,0);
});

test('settings export locks an expired offline grant before accessing its data',async()=>{
  const h=await offlineApp();h.run('bindSettings()');
  h.controls.time=Date.parse(timing.refreshExpiresAt);
  await h.element('expBtn').onclick({currentTarget:h.element('expBtn')});
  assert.equal(h.run('activeUser'),null);
});

test('successful backend revalidation with an open form does not treat its old sync error as a fresh outage',async()=>{
  const h=appHarness({native:true});await h.login('admin',true);
  h.controls.networkDown=true;await h.run('runSync(session)');
  h.run("state.editDate='2026-11-20'");
  h.controls.networkDown=false;await h.tick();
  assert.equal(h.run('api.isOffline()'),false);
  assert.equal(h.run('isAdmin'),true);
  assert.equal(h.run('state.editDate'),'2026-11-20');
});

test('conflict recovery network failure clears staff data and keeps the personal draft',async()=>{
  const h=appHarness({native:true});await h.login('admin',true);
  h.records.set('users',{[alpha]:{profile:{email:'alpha@example.test'}}});
  await h.run('refreshEmployees()');
  h.run("DB.days['2026-11-21']={date:'2026-11-21'};saveDB()");
  h.records.set(admin,{data:h.run('normalizeRemote()'),revision:2});
  await h.run('runSync(session)');
  assert.equal(h.run('syncState.conflict.resolved'),false);
  h.controls.networkDown=true;
  const recovery=h.run("recoverSync('retry-local')");
  h.element('mOk').click();await recovery;
  assert.equal(h.run('adminData'),null);
  assert.equal(h.run('api.isOffline()'),true);
  assert.ok(h.run("syncState.conflict.local.days['2026-11-21']"));
  h.run('renderSyncStatus()');
  assert.match(h.element('syncStatus').textContent,/черновик.*Без интернета/i);
  assert.equal(h.element('syncKeepServer').disabled,true);
  assert.equal(h.element('syncRetryLocal').disabled,true);
  await h.run("recoverSync('retry-local')");
  assert.equal(h.run('cancelConfirm'),null);
});

test('staff access revoked during a personal refresh keeps subsequent personal refreshes scheduled',async()=>{
  const h=appHarness();await h.login('admin');
  let done;
  h.deferred.set('/me/worklog',new Promise(resolve=>{done=resolve;}));
  const refresh=h.tick();await new Promise(resolve=>setImmediate(resolve));
  h.readErrors.set('/admin/employees',true);await h.run('refreshEmployees()');
  done(Response.json({data:null,revision:0}));await refresh;
  h.deferred.delete('/me/worklog');
  const before=h.calls.length;await h.tick();
  assert.deepEqual(h.calls.slice(before).map(call=>call.path),['/me/worklog']);
  assert.equal(h.run('isAdmin'),false);
});

test('ordinary token renewal can demote an admin without stopping periodic personal refresh',async()=>{
  const h=appHarness();await h.login('admin');
  let rejectAccess;
  h.deferred.set('/me/worklog',new Promise(resolve=>{rejectAccess=resolve;}));
  h.deferred.set('/auth/renew',Promise.resolve(Response.json({
    user:{uid:admin,email:'admin@example.test',role:'employee'},accessToken:admin,refreshToken:admin,...timing
  })));
  const refresh=h.tick();await new Promise(resolve=>setImmediate(resolve));
  h.deferred.delete('/me/worklog');rejectAccess(Response.json({error:'invalid_session'},{status:401}));
  await refresh;
  assert.equal(h.run('isAdmin'),false);
  const count=h.calls.length;await h.tick();
  assert.deepEqual(h.calls.slice(count).map(call=>call.path),['/me/worklog']);
});
test('active token-only remembered account locks its draft until automatic online migration',async()=>{
  const h=appHarness({native:true});
  const {user}=protectedRecord(alpha,'alpha').grant;
  h.deferred.set('/auth/login',Promise.resolve(Response.json({user,accessToken:alpha,refreshToken:alpha})));
  await h.login('alpha',true);
  h.run("DB.days['2026-11-20']={date:'2026-11-20'};saveDB()");
  const key='worklog.yandex.test.v1:'+alpha,draft=h.cached.get(key);
  assert.ok(JSON.parse(draft).pending);
  await h.fire('offline');
  h.run('originalRender()');
  assert.equal(h.run('activeUser'),null);
  assert.equal(h.run('saveDB()'),false);
  assert.equal(h.run('sync'),null);
  assert.equal(h.run('Object.keys(DB.days).length'),0);
  assert.match(h.element('app').innerHTML,/restoreForget/);
  assert.equal(h.record().token,alpha);
  assert.equal(h.cached.get(key),draft);
  const before=h.calls.length;
  h.controls.renewOffline=true;
  await h.fire('online');await h.tick();
  assert.equal(h.run('activeUser'),null);
  assert.equal(h.cached.get(key),draft);
  h.controls.renewOffline=false;await h.tick();
  assert.equal(h.calls[before].path,'/auth/renew');
  assert.equal(h.record().grant.user.uid,alpha);
  assert.equal(h.run('activeUser.uid'),alpha);
  assert.ok(h.records.get(alpha).data.days['2026-11-20']);
});


test('full local storage prevents a false save and server upload until space is available', async () => {
  const h=appHarness();
  await h.login('alpha');
  const attempted={
    date:'2026-11-23',
    main:{hours:'3',route:1}
  };
  const initialDays=h.run('Object.keys(DB.days)');
  const initialWrites=h.calls.filter(call=>call.method==='PUT').length;
  const originalSet=h.ctx.localStorage.setItem;
  h.ctx.localStorage.setItem=()=>{throw new Error('synthetic storage quota exceeded');};

  assert.equal(h.run('saveDB({...DB,days:{...DB.days,"2026-11-23":{date:"2026-11-23",main:{hours:"3",route:1}}}})'),false);
  assert.equal(h.run('sync.load().error'),'storage');
  assert.deepEqual(h.run('Object.keys(DB.days)'),initialDays);
  await h.run('sync.flush()');
  assert.equal(h.calls.filter(call=>call.method==='PUT').length,initialWrites);

  h.ctx.localStorage.setItem=originalSet;
  assert.equal(h.run('saveDB({...DB,days:{...DB.days,"2026-11-23":{date:"2026-11-23",main:{hours:"3",route:1}}}})'),true);
  await h.run('sync.flush()');
  assert.equal(h.records.get(alpha).data.days['2026-11-23'].main.hours,attempted.main.hours);
  assert.equal(h.run('sync.load().error'),null);
});
