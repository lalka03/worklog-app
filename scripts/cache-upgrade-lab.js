'use strict';
// Entirely synthetic, strictly offline; no real login or Worklog service.
(async()=>{
  const out=document.getElementById('result');
  const phase=document.currentScript?.getAttribute('data-phase');
  function insist(condition,code){if(!condition)throw Error(code);}
  function show(text){out.textContent=text;console.log(text);}
  const uid='00000000-0000-4000-8000-000000000091';
  const corruptUid='00000000-0000-4000-8000-000000000092';
  const key=id=>window.WorklogAccounts.userScope({uid:id}).cache;
  const snapshot={version:1,
    settings:{anchor:'2026-11-23',th1:3,th2:13,coef:1.5,p1:3,p2:3,p3:3,
      rates:{'1':280,'2':322,'3':350}},
    days:{'2026-11-23':{date:'2026-11-23',main:{hours:'4',route:1}}}};
  const native=window.Capacitor;
  insist(native?.isPluginAvailable?.('RememberedSession'),'NO_NATIVE_PLUGIN');
  const bridge=native.Plugins.RememberedSession;
  const fakeApi={getWorklog:async()=>{throw Error('NETWORK_DISABLED');},
    putWorklog:async()=>{throw Error('NETWORK_DISABLED');}};
  const fakeToken='SynTheticUpgradeGrantToken000000001';
  insist(phase==='old'||phase==='new','UNKNOWN_PHASE');
  if(phase==='old'){
    insist(localStorage.getItem(key(uid))===null,'DIRTY_TEST_ENVIRONMENT');
    const engine=window.WorklogSync.create({uid,storage:localStorage,api:fakeApi,
      canSend:()=>false,canRefresh:()=>false});
    insist(engine.edit(snapshot),'OLD_WRITE_FAILED');
    const disk=JSON.parse(localStorage.getItem(key(uid)));
    insist(disk.pending&&disk.data&&disk.pending.sent===false,'OLD_OFFLINE_DRAFT_MISSING');
    localStorage.setItem(key(corruptUid),'{broken-json:');
    localStorage.setItem('worklog.qa.upgrade.sentinel','SYNTHETIC_V1');
    await bridge.set({token:fakeToken});
    const stored=await bridge.get();
    insist(stored.token===fakeToken,'OLD_NATIVE_GRANT_FAILED');
    show('V1_READY');
  } else {
    insist(localStorage.getItem('worklog.qa.upgrade.sentinel')==='SYNTHETIC_V1','LOST_WEB_STORAGE');
    const raw=localStorage.getItem(key(uid));
    insist(raw!==null,'LOST_OLD_CACHE');
    const engine=window.WorklogSync.create({uid,storage:localStorage,api:fakeApi,
      canSend:()=>false,canRefresh:()=>false});
    const state=engine.load();
    insist(state.error===null,'UPGRADE_CACHE_ERROR');
    insist(state.data?.days?.['2026-11-23']?.main?.hours==='4','LOST_OLD_SHIFT');
    insist(state.pending?.sent===false,'LOST_OFFLINE_QUEUE');
    insist(localStorage.getItem(key(uid))===raw,'UPGRADE_REWROTE_OLD_CACHE');
    const broken=localStorage.getItem(key(corruptUid));
    const corrupt=window.WorklogSync.create({uid:corruptUid,storage:localStorage,api:fakeApi});
    insist(corrupt.load().error==='cache_corrupt','INVALID_CACHE_NOT_BLOCKED');
    insist(corrupt.edit(snapshot)===false,'INVALID_CACHE_EDIT_ALLOWED');
    await corrupt.flush();
    insist(localStorage.getItem(key(corruptUid))===broken,'CORRUPT_CACHE_OVERWRITTEN');
    const saved=await bridge.get();
    insist(saved.token===fakeToken,'LOST_ANDROID_KEYSTORE_GRANT');
    show('V2_PASS');
  }
})().catch(err=>{
  const message='LAB_FAIL_'+String(err?.message||err).replace(/[^A-Za-z0-9_]/g,'_');
  document.getElementById('result').textContent=message;console.error(message);
});
