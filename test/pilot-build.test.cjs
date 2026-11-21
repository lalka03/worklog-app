const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const assets = ['account.js', 'api.js', 'index.html', 'sync.js'];
const marker = "const WORKLOG_API_BASE_URL = '';";
const gateway = 'https://syntheticpilot.apigw.yandexcloud.net';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-assets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of assets) {
    fs.copyFileSync(path.join(root, name), path.join(directory, name));
  }
  fs.writeFileSync(path.join(directory, 'data.json'), '{"synthetic":"must stay out of the APK"}');
  return directory;
}

function stage(directory, endpoint) {
  const env = { ...process.env };
  delete env.WORKLOG_API_BASE_URL;
  if (endpoint !== undefined) env.WORKLOG_API_BASE_URL = endpoint;
  return spawnSync(process.execPath, [path.join(root, 'scripts/stage-pilot-assets.cjs')], {
    cwd: directory, env, encoding: 'utf8',
  });
}

test('pilot staging packages exactly the app assets and fills only the empty gateway marker', t => {
  const directory = fixture(t);
  const run = stage(directory, gateway + '/');
  assert.equal(run.status, 0, run.stderr);

  const www = path.join(directory, 'www');
  assert.deepEqual(fs.readdirSync(www).sort(), assets);
  for (const name of assets) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    const packaged = fs.readFileSync(path.join(www, name), 'utf8');
    const expected = name === 'index.html'
      ? source.replace(marker, `const WORKLOG_API_BASE_URL = "${gateway}";`)
      : source;
    assert.equal(packaged, expected);
    assert.doesNotMatch(packaged, /firebase|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|secrets\.(?:KEYSTORE|KEY_)/i);
  }
  assert.match(fs.readFileSync(path.join(directory, 'index.html'), 'utf8'), /const WORKLOG_API_BASE_URL = '';/);
});

test('pilot staging rejects absent, unsafe and non-origin gateway values without creating www', t => {
  const directory = fixture(t);
  for (const endpoint of [
    undefined, '', 'http://pilot.worklog.app', 'https://localhost', 'https://pilot.test', 'https://127.0.0.1',
    'https://user:password@pilot.worklog.app', gateway + '/api', gateway + '/.', gateway + '?',
    gateway + '?key=value', gateway + '#', gateway + '#fragment', gateway + ' ', gateway + '\n',
    'https://-bad.worklog.app',
    gateway + '\\evil', gateway + '/"><script>alert(1)</script>',
  ]) {
    const run = stage(directory, endpoint);
    assert.equal(run.status, 1, String(endpoint));
    assert.match(run.stderr, /WORKLOG_API_BASE_URL/);
    assert.equal(fs.existsSync(path.join(directory, 'www')), false);
  }
});

test('pilot staging requires one exact empty gateway marker', t => {
  const directory = fixture(t);
  const source = path.join(directory, 'index.html');
  for (const template of [marker.replace("''", "'https://already-set.worklog.app'"), marker + '\n' + marker]) {
    fs.writeFileSync(source, template);
    const run = stage(directory, gateway);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /exactly one empty URL marker/);
    assert.equal(fs.existsSync(path.join(directory, 'www')), false);
  }
});

test('workflow tests the Yandex branch and signs only a manual release from that branch', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-apk.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:[\s\S]*push:\s*branches: \[\s*worklog-yandex-test\s*\]/);
  assert.doesNotMatch(workflow, /worklog-multiuser-test|WorklogTest-release|data\.json/);
  const [checks, release] = workflow.split(/^  release:\s*$/m);
  assert.match(checks, /python-version:\s*['"]3\.12['"]/);
  assert.match(checks, /pip install -r backend\/requirements\.txt/);
  assert.match(checks, /python -m unittest discover -s backend\/tests -v[\s\S]*npm test/);
  assert.doesNotMatch(checks, /WORKLOG_API_BASE_URL|secrets\./);
  assert.ok(release, 'release is a separate job');
  assert.match(release, /if:.*github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/worklog-yandex-test'/);
  assert.match(release, /needs: test/);
  assert.match(release, /WORKLOG_API_BASE_URL:.*vars\.WORKLOG_API_BASE_URL[\s\S]*node scripts\/stage-pilot-assets\.cjs[\s\S]*assembleRelease/);
  assert.match(release, /name: WorklogYandexTest-release/);
});

test('native staging installs Android Keystore plugin and activity in the immutable pilot package',t=>{
  const directory=fixture(t);
  const packageDir=path.join(directory,'android/app/src/main/java/com/worklog/app/yandex/test');
  fs.mkdirSync(packageDir,{recursive:true});
  fs.copyFileSync(path.join(root,'capacitor.config.json'),path.join(directory,'capacitor.config.json'));
  fs.writeFileSync(path.join(packageDir,'MainActivity.java'),'package com.worklog.app.yandex.test;\nimport com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity {}\n');
  const script=path.join(root,'scripts/stage-android-session.cjs');
  const run=spawnSync(process.execPath,[script],{cwd:directory,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const plugin=fs.readFileSync(path.join(packageDir,'RememberedSessionPlugin.java'),'utf8');
  const activity=fs.readFileSync(path.join(packageDir,'MainActivity.java'),'utf8');
  assert.match(plugin,/@CapacitorPlugin\(name = "RememberedSession"\)/);
  assert.match(plugin,/AndroidKeyStore/);
  assert.match(plugin,/AES\/GCM\/NoPadding/);
  assert.match(plugin,/getNoBackupFilesDir\(\)/);
  // Inspect the staged Android source. The signed device run exercises the Keystore.
  assert.match(plugin,/MAX_PLAINTEXT_BYTES = 4096/);
  assert.match(plugin,/MAX_CIPHERTEXT_BYTES = IV_SIZE \+ TAG_BITS \/ 8 \+ MAX_PLAINTEXT_BYTES/);
  assert.match(plugin,/if \(validToken\(plaintext\)\)[\s\S]*validRecord\(record\)/);
  assert.match(plugin,/cipher\.doFinal\(plaintext\)/);
  for (const field of ['version', 'user', 'uid', 'email', 'role', 'refreshExpiresAt', 'serverTime', 'verifiedLocalMs', 'checkedLocalMs']) {
    assert.ok(plugin.includes('"' + field + '"'), field);
  }
  assert.match(plugin,/!validRecord\(record\)[\s\S]*erase\(\); empty\(call\)/);
  assert.match(plugin,/!validRecord\(record\)[\s\S]*call\.reject/);
  assert.match(plugin,/record\.length\(\) != 2[\s\S]*grant\.length\(\) != 6/);
  assert.match(plugin,/user\.length\(\) != 3/);
  assert.match(plugin,/expiresAt > serverTime && expiresAt - serverTime <= MAX_GRANT_MS/);
  assert.match(plugin,/checked >= verified/);
  assert.match(plugin,/new byte\[MAX_CIPHERTEXT_BYTES \+ 1\]/);
  assert.match(plugin,/synchronized void clear\(PluginCall call\)[\s\S]*erase\(\)/);
  assert.match(plugin,/finishWrite\(output\);[\s\S]*Arrays\.equals\(.*readCiphertext\(target\)/);
  assert.match(activity,/registerPlugin\(RememberedSessionPlugin.class\);[\s\S]*super.onCreate/);
  const workflow=fs.readFileSync(path.join(root,'.github/workflows/build-apk.yml'),'utf8');
  assert.match(workflow,/npx cap add android[\s\S]*node scripts\/stage-android-session.cjs[\s\S]*assembleRelease/);
});

test('staged bridge preserves legacy tokens and returns null when the native store is empty', async t => {
  const token = 'legacy_refresh_credential_32';
  const bridge = stagedBridge(t, { get: async () => ({ token }) });
  assert.equal(await bridge.get(), token);
  const empty = stagedBridge(t, { get: async () => ({ token: null }) });
  assert.equal(await empty.get(), null);
  let stored;
  const writer = stagedBridge(t, { set: async value => { stored = value; } });
  await writer.set(token);
  assert.equal(JSON.stringify(stored), JSON.stringify({ token }));
});

test('staged bridge reads and writes the complete protected grant in one plugin call', async t => {
  const record = {
    token: 'rotated_refresh_credential_33',
    grant: {
      version: 1,
      user: { uid: '00000000-0000-4000-8000-000000000001', email: 'worker@example.test', role: 'employee' },
      refreshExpiresAt: '2026-12-01T00:00:00Z',
      serverTime: '2026-11-21T00:00:00Z',
      verifiedLocalMs: 1795219200000,
      checkedLocalMs: 1795219200000,
    },
  };
  const writes = [];
  const bridge = stagedBridge(t, {
    get: async () => record,
    set: async value => { writes.push(value); },
    clear: async () => { writes.length = 0; },
  });
  assert.equal(JSON.stringify(await bridge.get()), JSON.stringify(record));
  await bridge.set(record);
  assert.equal(JSON.stringify(writes), JSON.stringify([record]));
  await bridge.clear();
  assert.equal(writes.length, 0);
});

function stagedBridge(t, plugin) {
  const directory = fixture(t);
  const run = stage(directory, gateway);
  assert.equal(run.status, 0, run.stderr);
  const html = fs.readFileSync(path.join(directory, 'www', 'index.html'), 'utf8');
  const bridge = html.slice(html.indexOf('const nativeSession='), html.indexOf("let restoreError="));
  return vm.runInNewContext(bridge + '\nnativeSession', { window: { Capacitor: {
    isNativePlatform: () => true,
    isPluginAvailable: name => name === 'RememberedSession',
    Plugins: { RememberedSession: plugin },
  } } });
}
