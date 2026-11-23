'use strict';

const fs = require('node:fs');
const {execFileSync} = require('node:child_process');

const qa = JSON.parse(fs.readFileSync('capacitor.cache-qa.config.json', 'utf8'));
const expected = 'com.worklog.app.yandex.cacheqa';
const production = JSON.parse(fs.readFileSync('capacitor.config.json','utf8'));
if(qa.appId !== expected || qa.appName !== 'Worklog Cache QA' ||
   qa.webDir !== 'www' || production.appId !== 'com.worklog.app.yandex.test'){
  throw new Error('CACHE_QA_IDENTITY_GUARD_STOP');
}
execFileSync(process.execPath, ['scripts/stage-pilot-assets.cjs'], {stdio:'inherit'});
const html = fs.readFileSync('www/index.html', 'utf8');
const marker = '<script src="api.js"></script>';
if(html.split(marker).length !== 2 || !html.includes('<script src="sync.js"></script>')){
  throw new Error('Unexpected script sequence; cannot insert QA account gate');
}
fs.writeFileSync('www/index.html', html.replace(marker, marker + '\n<script src="cache-qa-guard.js"></script>'));
fs.copyFileSync('scripts/cache-qa-guard.js', 'www/cache-qa-guard.js');
console.log('CACHE_QA_ASSETS_READY_SYNTHETIC_ONLY');
