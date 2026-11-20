const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { userScope, canWrite, employeeRows, validateWorklog } = require('../account.js');

test('anonymous accounts cannot obtain a writable storage scope', () => {
  assert.equal(userScope(null), null);
  assert.equal(userScope({uid: ''}), null);
});
const first='00000000-0000-4000-8000-000000000001';
const second='00000000-0000-4000-8000-000000000002';
test('two authenticated employees have separate local stores with canonical UUIDs', () => {
  assert.deepEqual(userScope({uid:first}), {uid:first, cache:'worklog.yandex.test.v1:'+first});
  assert.deepEqual(userScope({uid:second}), {uid:second, cache:'worklog.yandex.test.v1:'+second});
  assert.equal(userScope({uid:'alice'}),null);
});
test('both signed-in roles can write their own store after role resolution', () => {
  assert.equal(canWrite({uid:first}, false), true);
  assert.equal(canWrite({uid:first}, true), true);
  assert.equal(canWrite(null, false), false);
  assert.equal(canWrite({uid:first}, null), false);
});
test('administrator summaries include employees even with no records', () => {
  assert.deepEqual(employeeRows({a:{profile:{email:'one@example.test'},worklog:{days:{'2026-11-20':{date:'2026-11-20'}}}},b:{profile:{email:'two@example.test'}}}), [
    {uid:'a',email:'one@example.test',days:[['2026-11-20',{date:'2026-11-20'}]],settings:{}},
    {uid:'b',email:'two@example.test',days:[],settings:{}}
  ]);
});
test('test Android package is distinct from the installed production app', () => {
  const config = JSON.parse(fs.readFileSync('capacitor.config.json','utf8'));
  assert.equal(config.appId, 'com.worklog.app.yandex.test');
  assert.equal(config.appName, 'Worklog Yandex Test');
  assert.equal(config.webDir, 'www');
  assert.equal(config.android.allowMixedContent, false);
});


test('version-one validation accepts legacy decimal strings and bounds server-compatible settings',()=>{
  const valid={version:1,settings:{anchor:'2024-02-29',p1:'3e0',p2:0,p3:0,th1:3,th2:13,coef:'1.5',rates:{1:280,2:'322',3:350}},
    days:{'2026-11-20':{date:'2026-11-20',main:{hours:'168',route:'3',departure:'5:0',after:false}}}};
  assert.equal(validateWorklog(valid),true);
  for(const update of [
    data=>data.settings.anchor='2026-02-29', data=>data.settings.anchor='0000-01-01',
    data=>data.settings.p1=0, data=>data.settings.p3=1e6+1,
    data=>data.settings.th2='0x10',data=>data.settings.coef=Infinity,data=>data.settings.rates[2]=1e9+1,
    data=>data.days['2026-11-20'].main.hours=168.1,data=>data.days['2026-11-20'].main.hours=-1,
    data=>data.days['2026-11-20'].main.route=2.5,data=>data.days['2026-11-20'].main.departure='24:00',
    data=>data.days['2026-11-20'].main.after='false',data=>data.days['2026-11-20'].date='2026-11-21',
  ]){
    const altered=structuredClone(valid);
    update(altered);
    assert.equal(validateWorklog(altered),false,update.toString());
  }
});
