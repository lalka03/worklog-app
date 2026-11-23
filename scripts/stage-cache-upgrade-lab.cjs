'use strict';
// Disposable emulator-only two-version upgrade acceptance.
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const PHASE=process.argv[2],STABLE='d73eee4d55076362b6d914a12de9ea875e0cba32';
const CANDIDATE='90929964399b6dcf9eb26e6a2cf0779663348ed0';
const APP_ID='com.worklog.app.yandex.upgradeqa';
if(!['old','new'].includes(PHASE))throw Error('UPGRADE_INVALID_PHASE');
const readGit=(ref,file)=>execFileSync('git',['show',ref+':'+file],{encoding:'utf8'});
const hash=txt=>execFileSync('git',['hash-object','--stdin'],{input:txt,encoding:'utf8'}).trim();
const account=readGit(STABLE,'account.js');
const sync=readGit(PHASE==='old'?STABLE:CANDIDATE,'sync.js');
if(hash(account)!=='10ff04c87a3e482ddc35cac88673d3bfe527de6a')throw Error('ACCOUNT_BLOB_CHANGED');
if(hash(sync)!==(PHASE==='old'?'af88fc8452b6a469765b4a8b7a8e191fff5744ee':'4e46042d50a5490b288effacdf05ae3b0392fcdf'))throw Error('PINNED_SYNC_BLOB_CHANGED');
const cfg=JSON.parse(readGit(STABLE,'capacitor.config.json'));
if(cfg.appId!=='com.worklog.app.yandex.test')throw Error('STABLE_APP_ID_CHANGED');
const currentCfg=JSON.parse(fs.readFileSync('capacitor.config.json','utf8'));
if(PHASE==='old'&&currentCfg.appId!==cfg.appId)throw Error('ORIGINAL_CONFIG_CHANGED');
if(PHASE==='new'&&currentCfg.appId!==APP_ID)throw Error('QA_PACKAGE_CHANGED');
cfg.appId=APP_ID;cfg.appName='Worklog Upgrade QA';
fs.writeFileSync('capacitor.config.json',JSON.stringify(cfg,null,2)+'\n');
if(PHASE==='old')fs.mkdirSync('www');
const html=fs.readFileSync('scripts/cache-upgrade-lab.html','utf8');
if(!html.includes("connect-src 'none'")||/api\.js|WORKLOG_API_BASE_URL/i.test(html))throw Error('UNSAFE_LAB_HTML');
const script=fs.readFileSync('scripts/cache-upgrade-lab.js','utf8');
if(/\bfetch\s*\(|WORKLOG_API_BASE_URL|yandex\.cloud|https?:\/\//.test(script))throw Error('UNSAFE_LAB_JS');
fs.writeFileSync('www/index.html',html.replace('__UPGRADE_PHASE__',PHASE));
fs.writeFileSync('www/account.js',account);
fs.writeFileSync('www/sync.js',sync);
fs.writeFileSync('www/cache-upgrade-lab.js',script);
if(JSON.stringify(fs.readdirSync('www').sort())!==JSON.stringify(['account.js','cache-upgrade-lab.js','index.html','sync.js']))throw Error('UNEXPECTED_WEB_ASSET');
if(PHASE==='old'){
  fs.mkdirSync('lab-native',{recursive:true});
  for(const name of ['MainActivity.java','RememberedSessionPlugin.java']){
    const body=readGit(STABLE,'native/android/'+name);
    fs.writeFileSync(path.join('lab-native',name),body.replaceAll('com.worklog.app.yandex.test',APP_ID));
  }
}
console.log('UPGRADE_LAB_STAGE_'+PHASE.toUpperCase()+'_OK');
