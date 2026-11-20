const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const accounts = require('../account.js');

function appHarness(){
  const calls=[], records=new Map(), cached=new Map(), readErrors=new Map();
  const listeners=new Map();
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id)){
      const handlers=new Map();
      elements.set(id,{style:{},classList:{add(){},remove(){}},addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:name=>handlers.delete(name),click:()=>handlers.get('click')?.(),textContent:''});
    }
    return elements.get(id);
  };
  const ctx=vm.createContext({WorklogAccounts:accounts, document:{getElementById:element,querySelectorAll:()=>[]},window:{scrollTo(){}},
    localStorage:{getItem:k=>cached.get(k)||null,setItem:(k,v)=>cached.set(k,v),removeItem:k=>cached.delete(k)},
    setTimeout:()=>1,clearTimeout:()=>{},console,
    firebase:{database:()=>({ref:path=>({
      once:async()=>{if(readErrors.has(path)) throw readErrors.get(path);return {val:()=>records.get(path)||null};},
      set:async value=>{calls.push({path,value});records.set(path,value);},
      on:(event,cb)=>listeners.set(path,cb),off:()=>listeners.delete(path)
    })})}
  });
  const source=fs.readFileSync('index.html','utf8').match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  vm.runInContext(source.replace(/\(function init\(\)\{[\s\S]*?\}\)\(\);\s*$/, '')+'\nconst originalRender=render; render=()=>{}; toast=()=>{};',ctx);
  return {calls,records,cached,listeners,readErrors,ctx, run:code=>vm.runInContext(code,ctx)};
}
test('employee login, logout and next login never reuse another employee data or storage', async()=>{
  const h=appHarness();
  await h.run("bindAccount({uid:'alpha',email:'alpha@example.test'})");
  h.run("DB.days['2026-11-20']={date:'2026-11-20'};saveDB();cloudPush()");
  assert.ok(h.cached.has('worklog.test.v1:alpha'));
  assert.ok(h.records.get('users/alpha/worklog').days['2026-11-20']);
  const previous=h.listeners.get('users/alpha/worklog');
  await h.run('bindAccount(null)');
  assert.equal(h.run('Object.keys(DB.days).length'),0);
  await h.run("bindAccount({uid:'beta',email:'beta@example.test'})");
  previous({val:()=>({days:{'2026-11-20':{date:'2026-11-20'}}})});
  assert.equal(h.run('Object.keys(DB.days).length'),0);
  h.run("DB.days['2026-11-21']={date:'2026-11-21'};saveDB();cloudPush()");
  assert.ok(h.records.get('users/beta/worklog').days['2026-11-21']);
  assert.equal(h.records.get('users/beta/worklog').days['2026-11-20'],undefined);
  assert.ok(h.calls.every(c=>c.path.startsWith('users/alpha/')||c.path.startsWith('users/beta/')));
});
test('administrator can view employees and only write to their own worklog',async()=>{
  const h=appHarness(); h.records.set('admins/admin',true);h.records.set('users',{alpha:{profile:{email:'alpha@example.test'}}});
  await h.run("bindAccount({uid:'admin',email:'admin@example.test'})");
  assert.equal(h.run('isAdmin'),true);
  await h.run('refreshEmployees()');
  assert.equal(h.run('employeeRows(adminData)[0].email'),'alpha@example.test');
  h.run("DB.days['2026-11-20']={date:'2026-11-20'};saveDB();cloudPush()");
  assert.ok(h.records.get('users/admin/worklog').days['2026-11-20']);
  assert.ok(h.calls.every(c=>c.path.startsWith('users/admin/')));
  assert.ok(h.cached.has('worklog.test.v1:admin'));
  await h.run('bindAccount(null)');
  assert.equal(h.run('adminData'),null);
  assert.equal(h.run('isAdmin'),null);
});
test('employee calendar and totals use employee rates without changing personal records',async()=>{
  const h=appHarness();
  await h.run("bindAccount({uid:'admin',email:'admin@example.test'})");
  h.run("DB.settings.rates[1]=280; DB.days['2026-11-13']={date:'2026-11-13',main:{hours:2,route:1}}");
  const result=h.run("(()=>{const other=normalizeRemote({settings:{rates:{1:500}},days:{'2026-11-13':{date:'2026-11-13',main:{hours:3,route:1}}}});return [monthSummary(2026,10,other).total,monthSummary(2026,10).total,renderHome(other,2026,10),renderTotals(other)]})()");
  assert.equal(result[0],1500);
  assert.equal(result[1],560);
  assert.match(result[2],/1500,00 ₽/);
  assert.match(result[3],/1500,00 ₽/);
  assert.equal(h.run('DB.days[\'2026-11-13\'].main.hours'),2);
});
test('ordinary employees cannot enter or refresh the admin section',async()=>{
  const h=appHarness();
  await h.run("bindAccount({uid:'alpha',email:'alpha@example.test'})");
  h.run("setTab('employees')");
  await h.run('refreshEmployees()');
  assert.equal(h.run('state.tab'),'home');
  assert.equal(h.run('adminData'),null);
});
test('the employee selection is independent of the personal month and resets on logout',async()=>{
  const h=appHarness();
  h.records.set('admins/admin',true);
  h.records.set('users',{alpha:{profile:{email:'alpha@example.test'},worklog:{days:{}}}});
  await h.run("bindAccount({uid:'admin',email:'admin@example.test'})");
  await h.run('refreshEmployees()');
  h.run("state.viewYear=2025;state.viewMonth=2;selectEmployee('alpha')");
  assert.equal(h.run('employeeView.uid'),'alpha');
  assert.equal(h.run('state.viewYear'),2025);
  assert.equal(h.run('state.viewMonth'),2);
  await h.run('bindAccount(null)');
  assert.equal(h.run('employeeView.uid'),null);
});
test('administrator gets the same personal home and add-shift controls plus an employee tab',async()=>{
  const h=appHarness();h.records.set('admins/admin',true);
  await h.run("bindAccount({uid:'admin',email:'admin@example.test'})");
  h.run('originalRender()');
  assert.equal(h.run("document.getElementById('navEmployees').style.display"),'flex');
  assert.equal(h.run("document.getElementById('btnAddToday').style.display"),'flex');
  assert.match(h.run("document.getElementById('app').innerHTML"),/Заработано за месяц/);
  await h.run("bindAccount({uid:'alpha',email:'alpha@example.test'})");
  h.run('originalRender()');
  assert.equal(h.run("document.getElementById('navEmployees').style.display"),'none');
  assert.equal(h.run("document.getElementById('btnAddToday').style.display"),'flex');
});
test('a pending employee refresh cannot leak employee data into the next account',async()=>{
  const h=appHarness();h.records.set('admins/admin',true);h.records.set('users',{alpha:{profile:{email:'alpha@example.test'}}});
  await h.run("bindAccount({uid:'admin',email:'admin@example.test'})");
  const pending=h.run('refreshEmployees()');
  await h.run("bindAccount({uid:'alpha',email:'alpha@example.test'})");
  await pending;
  assert.equal(h.run('adminData'),null);
  assert.equal(h.run('employeeView.uid'),null);
  assert.equal(h.run('scope.uid'),'alpha');
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
  const h=appHarness();h.records.set('admins/admin',true);h.records.set('users',{alpha:{profile:{email:'alpha@example.test'}}});
  await h.run("bindAccount({uid:'admin',email:'admin@example.test'})");
  await h.run('refreshEmployees()');h.run("selectEmployee('alpha')");
  h.readErrors.set('users',{code:'PERMISSION_DENIED'});
  await h.run('refreshEmployees()');
  assert.equal(h.run('adminData'),null);
  assert.equal(h.run('employeeView.uid'),null);
  assert.equal(h.run('isAdmin'),false);
});
test('a stale authentication completion cannot switch the now active account',async()=>{
  const h=appHarness();
  const first=h.run("bindAccount({uid:'alpha',email:'alpha@example.test'})");
  const second=h.run("bindAccount({uid:'beta',email:'beta@example.test'})");
  await Promise.all([first,second]);
  assert.equal(h.run('scope.uid'),'beta');
  assert.ok(h.calls.every(c=>c.path.startsWith('users/beta/')));
});
test('a confirmation started by the previous employee cannot approve a data change after account switch',async()=>{
  const h=appHarness();
  await h.run("bindAccount({uid:'alpha',email:'alpha@example.test'})");
  const answer=h.run("confirmModal('Delete','Delete a record')");
  await h.run("bindAccount({uid:'beta',email:'beta@example.test'})");
  h.run("document.getElementById('mOk').click()");
  assert.equal(await answer,false);
});
