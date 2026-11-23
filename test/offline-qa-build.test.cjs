'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const originalId = 'com.worklog.app.yandex.test';
const qaId = 'com.worklog.app.yandex.offlineqa';

test('Offline QA package is independent from installed #36 package', () => {
  const prod = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json')));
  const qa = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.offline-qa.config.json')));
  assert.equal(prod.appId, originalId);
  assert.equal(qa.appId, qaId);
  assert.notEqual(prod.appId, qa.appId);
  assert.equal(qa.appName, 'Worklog Offline QA');
  assert.equal(qa.webDir, 'www');
});

test('Native staging targets only isolated QA path', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-offline-qa-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const cfg = fs.readFileSync(path.join(root, 'capacitor.offline-qa.config.json'));
  fs.writeFileSync(path.join(scratch, 'capacitor.offline-qa.config.json'), cfg);
  fs.writeFileSync(path.join(scratch, 'capacitor.config.json'), cfg);
  const nativeDir = path.join(scratch, 'native/android');
  fs.mkdirSync(nativeDir, { recursive: true });
  for (const name of ['MainActivity.java', 'RememberedSessionPlugin.java']) {
    fs.copyFileSync(path.join(root, 'native/android', name), path.join(nativeDir, name));
  }
  const destination = path.join(scratch, 'android/app/src/main/java', ...qaId.split('.'));
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'MainActivity.java'),
    `package ${qaId};\nimport com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity {}\n`);
  const script = path.join(root, 'scripts/stage-offline-qa-android.cjs');
  const run = spawnSync(process.execPath, [script], {cwd:scratch, encoding:'utf8'});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /OFFLINE_QA_NATIVE_READY/);
  for (const name of ['MainActivity.java', 'RememberedSessionPlugin.java']) {
    const copy = fs.readFileSync(path.join(destination, name), 'utf8');
    assert.match(copy, /^package com\.worklog\.app\.yandex\.offlineqa;/);
    assert.doesNotMatch(copy, /^package com\.worklog\.app\.yandex\.test;/);
  }
  const plugin = fs.readFileSync(path.join(destination, 'RememberedSessionPlugin.java'), 'utf8');
  assert.match(plugin, /@CapacitorPlugin\(name = "RememberedSession"\)/);
  assert.match(plugin, /getNoBackupFilesDir\(\)/);
  assert.match(plugin, /AndroidKeyStore/);
  fs.writeFileSync(path.join(scratch, 'capacitor.config.json'), JSON.stringify({appId:originalId}));
  const blocked = spawnSync(process.execPath,[script],{cwd:scratch,encoding:'utf8'});
  assert.notEqual(blocked.status,0);
  assert.match(blocked.stderr,/Refusing to stage native code/);
});

test('QA workflow builds only dedicated package and publishes separate artifact', () => {
  const yml = fs.readFileSync(path.join(root,'.github/workflows/build-offline-qa-apk.yml'),'utf8');
  assert.match(yml,/branches: \[worklog-android-offline-qa\]/);
  assert.match(yml,/needs: test/);
  assert.match(yml,/cp capacitor\.offline-qa\.config\.json capacitor\.config\.json/);
  assert.match(yml,/node scripts\/stage-offline-qa-android\.cjs/);
  assert.match(yml,/package: name='com\.worklog\.app\.yandex\.offlineqa'/);
  assert.match(yml,/WorklogOfflineQA-release/);
  assert.doesNotMatch(yml,/workflow_dispatch:/);
});
