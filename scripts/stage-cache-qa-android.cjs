'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const qaId = 'com.worklog.app.yandex.cacheqa';
const templateId = 'com.worklog.app.yandex.test';
const qa = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.cache-qa.config.json'), 'utf8'));
const active = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
if(qa.appId !== qaId || qa.appName !== 'Worklog Cache QA' ||
   qa.webDir !== 'www' || active.appId !== qaId){
  throw new Error('CACHE_QA_NATIVE_IDENTITY_GUARD_STOP');
}
const destination = path.join(root, 'android/app/src/main/java', ...qaId.split('.'));
const activity = fs.readFileSync(path.join(destination,'MainActivity.java'), 'utf8');
if(!activity.includes(`package ${qaId};`) || !activity.includes('extends BridgeActivity')){
  throw new Error('Unexpected Cache QA native MainActivity');
}
for(const file of ['MainActivity.java','RememberedSessionPlugin.java']){
  const source = fs.readFileSync(path.join(root,'native/android',file),'utf8');
  const header = `package ${templateId};`;
  if(!source.startsWith(header) || source.split(header).length !== 2){
    throw new Error('Unexpected native session bridge template: ' + file);
  }
  fs.writeFileSync(path.join(destination,file),source.replace(header,`package ${qaId};`));
}
console.log('CACHE_QA_NATIVE_READY');
