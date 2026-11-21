const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const accounts = require('../account.js');

const alpha='00000000-0000-4000-8000-000000000001';
const beta='00000000-0000-4000-8000-000000000002';
const admin='00000000-0000-4000-8000-000000000003';
const html=fs.readFileSync('index.html','utf8');
const WorklogApi={create:options=>require('../api.js').create({...options,baseUrl:'https://worklog.example.test'})};

function appHarness({remembered=null,native=false,renewOffline=false,clearFails=false}={}){
  const calls=[], records=new Map(), cached=new Map(), readErrors=new Map(), resetResponses=new Map(), clipboard=[];
  const elements=new Map();
  function makeElement(){
    const handlers=new Map();
    return {children:[],style:{},classList:{add(){},remove(){},toggle(){}},querySelectorAll:()=>[],
      querySelector:()=>makeElement(), appendChild(child){this.children.push(child);}, replaceChildren(){this.children=[];},
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
    if(path==='/auth/login' || path==='/auth/register'){
      const found=byEmail(body.email);
      if(path==='/auth/login' && !found) return respond({error:'invalid_credentials'},401);
      if(path==='/auth/register' && body.invite!=='valid') return respond({error:'invalid_invite'},422);
      const id=found?.[0]??beta;
      return respond({user:{uid:id,email:body.email,role:id===admin?'admin':'employee'},accessToken:id,refreshToken:id,expiresAt:'2026-11-20T12:00:00Z'});
    }
    if(path==='/auth/logout') return respond({});
    if(path==='/auth/renew'){
      if(renewOffline) throw new TypeError('offline');
      const id=body.refreshToken;
      const name=users.get(id);
      if(!name) return respond({error:'invalid_session'},401);
      return respond({user:{uid:id,email:`${name}@example.test`,role:id===admin?'admin':'employee'},accessToken:id,refreshToken:id});
    }
    if(path==='/auth/reset') return respond({});
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
    document:{getElementById:element,querySelectorAll:()=>[],createElement:makeElement,addEventListener(){}},
    window:{scrollTo(){},addEventListener(){},...(native?{Capacitor:{isNativePlatform:()=>true,isPluginAvailable:name=>name==='RememberedSession',Plugins:{RememberedSession:{
      get:async()=>({token:remembered}),set:async({token})=>{remembered=token;},clear:async()=>{if(clearFails) throw new Error('storage unavailable');remembered=null;}
    }}}}:{})},fetch,URL,TextEncoder,navigator:{clipboard:{writeText:async value=>clipboard.push(value)}},
    localStorage:{getItem:k=>cached.get(k)||null,setItem:(k,v)=>cached.set(k,v),removeItem:k=>cached.delete(k)},
    setTimeout:()=>1,clearTimeout:()=>{},console});
  const source=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  vm.runInContext(source.replace(/\(function init\(\)\{[\s\S]*?\}\)\(\);\s*$/, '')+'\nconst originalRender=render; render=()=>{}; toast=()=>{};',ctx);
  const run=code=>vm.runInContext(code,ctx);
  return {calls,records,cached,readErrors,resetResponses,clipboard,ctx,run,element,
    login:name=>run(`(async()=>bindAccount(await api.login('${name}@example.test','sample-password')))()`),
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
