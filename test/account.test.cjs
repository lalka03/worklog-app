const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { userScope, canWrite, employeeRows } = require('../account.js');

test('anonymous accounts cannot obtain a writable storage scope', () => {
  assert.equal(userScope(null), null);
  assert.equal(userScope({uid: ''}), null);
});
test('two authenticated employees have separate remote and local stores', () => {
  assert.deepEqual(userScope({uid:'a'}), { uid:'a', path:'users/a/worklog', cache:'worklog.test.v1:a' });
  assert.deepEqual(userScope({uid:'b'}), { uid:'b', path:'users/b/worklog', cache:'worklog.test.v1:b' });
});
test('only a signed-in employee can write their own store', () => {
  assert.equal(canWrite({uid:'a'}, false), true);
  assert.equal(canWrite({uid:'a'}, true), false);
  assert.equal(canWrite(null, false), false);
  assert.equal(canWrite({uid:'a'}, null), false);
});
test('administrator summaries include employees even with no records', () => {
  assert.deepEqual(employeeRows({a:{profile:{email:'one@example.test'},worklog:{days:{'2026-11-20':{date:'2026-11-20'}}}},b:{profile:{email:'two@example.test'}}}), [
    {uid:'a',email:'one@example.test',days:[['2026-11-20',{date:'2026-11-20'}]],settings:{}},
    {uid:'b',email:'two@example.test',days:[],settings:{}}
  ]);
});
test('test Android package is distinct from the installed production app', () => {
  const config = JSON.parse(fs.readFileSync('capacitor.config.json','utf8'));
  assert.equal(config.appId, 'com.worklog.app.test');
  assert.equal(config.appName, 'Worklog Test');
});
