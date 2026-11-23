'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const lab = require('../scripts/cache-qa-lab.js');

test('four offline Android memory fault scenarios pass against the actual Worklog sync engine',async()=>{
  const result = await lab.runAll();
  assert.equal(result.total,4);
  assert.equal(result.passed,4,JSON.stringify(result.checks));
  assert.equal(result.checks.every(item=>item.ok),true);
});

test('QA laboratory has no real localStorage, fetch, credentials, Yandex endpoints, or authentication UI',()=>{
  const html=fs.readFileSync('scripts/cache-qa-lab.html','utf8');
  const script=fs.readFileSync('scripts/cache-qa-lab.js','utf8');
  for(const forbidden of [/\blocalStorage\b/, /\bfetch\s*\(/, /WORKLOG_API_BASE_URL/,
    /yandex\.cloud/, /worklog\.cache\.qa\./, /\bCapacitor\b/, /navigator\.onLine/]){
    assert.doesNotMatch(script,forbidden);
  }
  assert.match(html,/connect-src 'none'/);
  assert.match(html,/script-src 'self'/);
  assert.doesNotMatch(html,/api\.js|password|type="email"|WORKLOG_API_BASE_URL/);
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map(x=>x[1]),
    ['account.js','sync.js','cache-qa-lab.js']);
});

test('QA packaging includes only four approved web assets',()=>{
  const src=fs.readFileSync('scripts/stage-cache-qa-assets.cjs','utf8');
  assert.match(src,/CACHE_QA_UNEXPECTED_WEB_ASSETS/);
  assert.match(src,/expected=\['account\.js','cache-qa-lab\.js','index\.html','sync\.js'\]/);
  const workflow=fs.readFileSync('.github/workflows/build-cache-qa-apk.yml','utf8');
  assert.match(workflow,/Stage offline-only memory lab/);
  assert.doesNotMatch(workflow,/vars\.WORKLOG_API_BASE_URL/);
  assert.match(workflow,/test ! -e www\/api\.js/);
});
