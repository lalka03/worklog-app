'use strict';

// Exclusive build for the standalone, strictly offline Cache QA laboratory.
// Never stage the live app, credentials, API endpoint, or real worklog storage.
const fs = require('node:fs');
const path = require('node:path');
const qa = JSON.parse(fs.readFileSync('capacitor.cache-qa.config.json','utf8'));
const prod = JSON.parse(fs.readFileSync('capacitor.config.json','utf8'));
if(qa.appId !== 'com.worklog.app.yandex.cacheqa' ||
   qa.appName !== 'Worklog Cache QA' || qa.webDir !== 'www' ||
   prod.appId !== 'com.worklog.app.yandex.test'){
  throw new Error('CACHE_QA_IDENTITY_GUARD_STOP');
}
if(fs.existsSync('www')) throw new Error('CACHE_QA_STAGING_MUST_BE_FRESH');
fs.mkdirSync('www');
const staged=[
  ['scripts/cache-qa-lab.html','index.html'],
  ['scripts/cache-qa-lab.js','cache-qa-lab.js'],
  ['account.js','account.js'],
  ['sync.js','sync.js']
];
for(const [source,destination] of staged){
  fs.copyFileSync(source,path.join('www',destination));
}
const html=fs.readFileSync('www/index.html','utf8');
if(!html.includes('Worklog Cache QA') ||
   !html.includes('cache-qa-lab.js') ||
   !html.includes('connect-src \'none\'') ||
   html.includes('api.js') || html.includes('cache-qa-guard.js') ||
   html.includes('WORKLOG_API_BASE_URL')){
  throw new Error('CACHE_QA_OFFLINE_GUARD_STOP');
}
const files=fs.readdirSync('www').sort();
const expected=['account.js','cache-qa-lab.js','index.html','sync.js'];
if(JSON.stringify(files)!==JSON.stringify(expected))
  throw new Error('CACHE_QA_UNEXPECTED_WEB_ASSETS');
console.log('CACHE_QA_OFFLINE_LAB_ASSETS_READY');
