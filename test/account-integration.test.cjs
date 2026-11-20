const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const accounts = require('../account.js');

function appHarness(){
  const calls=[], records=new Map(), cached=new Map();
  const listeners=new Map();
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id)){
      const handlers=new Map();
      elements.set(id,{style:{},classList:{add(){},remove(){}},addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:name=>handlers.delete(name),click:()=>handlers.get('click')?.(),textContent:''});
    }
    return elements.get(id);
  };
  const ctx=vm.createContext({WorklogAccounts:accounts, document:{getElementById:element},
    localStorage:{getItem:k=>cached.get(k)||null,setItem:(k,v)=>cached.set(k,v),removeItem:k=>cached.delete(k)},
    setTimeout:()=>1,clearTimeout:()=>{},console,
    firebase:{database:()=>({ref:path=>({
      once:async()=>({val:()=>records.get(path)||null}),
      set:async value=>{calls.push({path,value});records.set(path,value);},
      on:(event,cb)=>listeners.set(path,cb),off:()=>listeners.delete(path)
    })})}
  });
  const source=fs.readFileSync('index.html','utf8').match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  vm.runInContext(source.replace(/\(function init\(\)\{[\s\S]*?\}\)\(\);\s*$/, '')+'\nrender=()=>{}; toast=()=>{};',ctx);
  return {calls,records,cached,listeners,ctx, run:code=>vm.runInContext(code,ctx)};
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
test('administrator loads employee records and does not write any data',async()=>{
  const h=appHarness(); h.records.set('admins/admin',true);h.records.set('users',{alpha:{profile:{email:'alpha@example.test'}}});
  await h.run("bindAccount({uid:'admin',email:'admin@example.test'})");
  assert.equal(h.run('isAdmin'),true);
  assert.equal(h.run('employeeRows(adminData)[0].email'),'alpha@example.test');
  h.run('saveDB();cloudPush()');
  assert.deepEqual(h.calls,[]);
  assert.equal(h.cached.size,0);
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
