const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync('capacitor.config.json', 'utf8'));
const appId = 'com.worklog.app.yandex.test';
if (config.appId !== appId) throw new Error('Unexpected Worklog pilot app ID');
const destination = path.join('android/app/src/main/java', ...appId.split('.'));
const activity = path.join(destination, 'MainActivity.java');
const template = fs.readFileSync(activity, 'utf8');
if (!template.includes(`package ${appId};`) || !template.includes('extends BridgeActivity')) {
  throw new Error('Unexpected generated MainActivity');
}
for (const name of ['MainActivity.java', 'RememberedSessionPlugin.java']) {
  fs.copyFileSync(path.join(__dirname, '..', 'native', 'android', name), path.join(destination, name));
}
