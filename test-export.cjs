const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const html = fs.readFileSync('index.html','utf8');
const start = html.indexOf("  document.getElementById('expBtn').onclick=");
const end = html.indexOf("  document.getElementById('impBtn').onclick=",start);
assert.ok(start >= 0 && end > start);
const handler = html.slice(start,end);
(async () => {
  for (const mode of ['native', 'browser', 'failed']) {
    const db = {settings:{rates:{1:280}}, days:{'2026-01-01':{note:'Тест'},'2026-01-02':{}}, version:1};
    const before = JSON.stringify(db);
    let saved, shared, downloaded, toastMessage, browserBlob;
    const button = {};
    const anchor = {click(){downloaded = this.download},remove(){}};
    const context = {
      DB:db, window: {Capacitor: mode === 'browser' ? undefined : {isNativePlatform:()=>true, Plugins:{
        Filesystem:{writeFile:async opts=>{if(mode==='failed')throw Error('mock');saved=opts;return {uri:'file:///cache/'+opts.path}}},
        Share:{share:async opts=>{shared=opts}}
      }}}, document:{getElementById:()=>button,createElement:()=>anchor,body:{appendChild(){}}},
      URL:{createObjectURL(blob){browserBlob=blob;return 'blob:mock'},revokeObjectURL(){}},Blob,
      setTimeout:(fn)=>fn(),toast: msg=>{toastMessage=msg}
    };
    vm.runInNewContext(handler, context);
    await button.onclick({currentTarget:button});
    assert.equal(button.disabled,false);
    assert.equal(JSON.stringify(db),before);
    if(mode==='native'){
      assert.equal(saved.directory,'CACHE'); assert.equal(saved.encoding,'utf8');
      assert.deepEqual(JSON.parse(saved.data),{version:1,settings:db.settings,days:db.days});
      assert.equal(shared.files[0],'file:///cache/'+saved.path); assert.match(shared.dialogTitle,/2/);
    } else if(mode==='browser'){
      assert.match(downloaded,/^worklog_backup_.*\.json$/); assert.deepEqual(JSON.parse(await browserBlob.text()),{version:1,settings:db.settings,days:db.days});
    } else {assert.equal(shared,undefined); assert.equal(toastMessage,'Экспорт не завершён');}
  }
  console.log('PASS: native export, browser export, failure handling, data unchanged');
})().catch(error=>{console.error(error);process.exitCode=1});
