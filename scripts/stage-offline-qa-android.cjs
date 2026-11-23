'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const qaId = 'com.worklog.app.yandex.offlineqa';
const originalId = 'com.worklog.app.yandex.test';
const qaConfig = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.offline-qa.config.json'), 'utf8'));
const activeConfig = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
if (qaConfig.appId !== qaId || qaConfig.appName !== 'Worklog Offline QA' ||
    qaConfig.webDir !== 'www' || activeConfig.appId !== qaId) {
  throw new Error('Refusing to stage native code outside the separate Offline QA package');
}

const destination = path.join(root, 'android/app/src/main/java', ...qaId.split('.'));
const generated = fs.readFileSync(path.join(destination, 'MainActivity.java'), 'utf8');
if (!generated.includes(`package ${qaId};`) || !generated.includes('extends BridgeActivity')) {
  throw new Error('Unexpected generated Offline QA MainActivity');
}

const files = ['MainActivity.java', 'RememberedSessionPlugin.java'];
const generatedSources = files.map(name => {
  const source = fs.readFileSync(path.join(root, 'native/android', name), 'utf8');
  const expectedPackage = `package ${originalId};`;
  if (!source.startsWith(expectedPackage) || source.split(expectedPackage).length !== 2) {
    throw new Error(`Unexpected native template package: ${name}`);
  }
  return [name, source.replace(expectedPackage, `package ${qaId};`)];
});
for (const [name, content] of generatedSources) {
  fs.writeFileSync(path.join(destination, name), content);
}
console.log('OFFLINE_QA_NATIVE_READY');
