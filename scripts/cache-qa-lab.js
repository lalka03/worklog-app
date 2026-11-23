(function(root,factory){
  'use strict';
  const engine=(typeof module==='object' && module.exports)
    ? require('../sync.js') : root.WorklogSync;
  const lab=factory(engine);
  if(typeof module==='object' && module.exports) module.exports=lab;
  else root.WorklogCacheLab=lab;
  if(typeof document!=='undefined'){
    const run=document.getElementById('run');
    const output=document.getElementById('results');
    if(!run || !output) throw Error('QA interface is incomplete');
    run.addEventListener('click',async()=>{
      run.disabled=true;
      output.textContent='Выполняются проверки на искусственных данных…';
      delete output.dataset.success;
      try{
        const results=await lab.runAll();
        output.textContent=results.checks.map(item=>`${item.ok?'✓':'✗'} ${item.name}${item.ok?'':': '+item.error}`).join('\n')+
          `\n\nПройдено: ${results.passed}/${results.total}`+
          '\nДанные основного Worklog не читались и не изменялись.';
        output.dataset.success=String(results.passed===results.total);
      }catch(e){
        output.dataset.success='false';
        output.textContent='Ошибка запуска QA-лаборатории: '+String(e.message||e);
      }finally{
        run.disabled=false;
      }
    });
  }
})(globalThis,function(syncModule){
  'use strict';
  if(!syncModule || typeof syncModule.create!=='function')
    throw Error('WorklogSync is unavailable');
  const UID='00000000-0000-4000-8000-0000000000a1';
  const KEY='worklog.yandex.test.v1:'+UID;
  const DAY='2026-11-23';
  function snapshot(hours){
    return {version:1,settings:{
      anchor:DAY,p1:3,p2:3,p3:3,th1:3,th2:13,coef:1.5,
      rates:{'1':280,'2':322,'3':350}
    },days:{[DAY]:{date:DAY,main:{hours:String(hours),route:1}}}};
  }
  function check(condition,message){if(!condition) throw Error(message);}
  function disk(){
    const records=new Map();
    let failRead=false, failWrite=false, writes=0;
    return {
      records,
      getItem(key){
        if(failRead) throw Error('synthetic read failure');
        return records.get(key)??null;
      },
      setItem(key,raw){
        if(failWrite) throw Error('synthetic storage full');
        records.set(key,raw);
        writes++;
      },
      readFault(value){failRead=value;},
      writeFault(value){failWrite=value;},
      writes:()=>writes
    };
  }
  function server(){
    let state={data:null,revision:0};
    let commits=0, attempts=0;
    const receipts=new Map();
    return {
      api:{
        getWorklog:async()=>JSON.parse(JSON.stringify(state)),
        putWorklog:async({data,expectedRevision,mutationId})=>{
          attempts++;
          if(receipts.has(mutationId)) return receipts.get(mutationId);
          check(expectedRevision===state.revision,'stale synthetic revision');
          state={data,revision:state.revision+1};
          commits++;
          const reply={revision:state.revision};
          receipts.set(mutationId,reply);
          return reply;
        }
      },
      counts:()=>({attempts,commits}),
      get:()=>state
    };
  }
  const bind=(storage,remote)=>syncModule.create({uid:UID,storage,api:remote.api});
  async function corruptedJson(){
    const d=disk(),s=server();
    const broken='{"data":';
    d.records.set(KEY,broken);
    const app=bind(d,s);
    check(app.load().error==='cache_corrupt','corruption not detected');
    check(!app.edit(snapshot(2)),'damaged cache accepted an edit');
    await app.refresh();
    await app.flush();
    check(d.records.get(KEY)===broken,'damaged cache was overwritten');
    check(s.counts().attempts===0,'unexpected server send');
    check(!app.retryCache(),'retry wrongly accepted broken JSON');
    app.close();
  }
  async function readFailureRecovery(){
    const d=disk(),s=server();
    const data=snapshot(3),mutationId='a'.repeat(32);
    d.records.set(KEY,JSON.stringify({data,revision:0,conflict:null,
      pending:{data,expectedRevision:0,mutationId,sent:false,next:null}}));
    d.readFault(true);
    const app=bind(d,s);
    check(app.load().error==='cache_unreadable','read error was not detected');
    check(!app.edit(snapshot(4)),'unreadable cache accepted an edit');
    await app.flush();
    check(s.counts().attempts===0,'upload occurred during read failure');
    d.readFault(false);
    check(app.retryCache(),'valid pending draft not restored');
    check(app.load().pending?.mutationId===mutationId,'pending operation ID changed');
    await app.flush();
    check(app.load().pending===null && app.load().revision===1,'recovery did not commit');
    check(s.counts().commits===1,'wrong number of synthetic commits');
    app.close();
  }
  async function malformedPending(){
    const d=disk(),s=server(),data=snapshot(5);
    const bad=JSON.stringify({data,revision:0,conflict:null,
      pending:{data,expectedRevision:0,mutationId:'invalid!',sent:true,next:null}});
    d.records.set(KEY,bad);
    const app=bind(d,s);
    check(app.load().error==='cache_corrupt','malformed pending was accepted');
    await app.flush();
    check(d.records.get(KEY)===bad,'invalid pending was replaced');
    check(s.counts().commits===0,'invalid pending was uploaded');
    app.close();
  }
  async function storageFull(){
    const d=disk(),s=server();
    const app=bind(d,s);
    await app.refresh();
    d.writeFault(true);
    check(!app.edit(snapshot(6)),'write failure incorrectly reported success');
    check(app.load().error==='storage','storage error was not reported');
    await app.flush();
    check(s.counts().attempts===0,'unsaved edit reached server');
    d.writeFault(false);
    check(app.edit(snapshot(6)),'valid edit rejected after freeing space');
    await app.flush();
    check(s.counts().commits===1,'retry did not commit exactly once');
    check(app.load().revision===1,'missing synchronized revision');
    app.close();
  }
  const cases=[
    ['Повреждённый JSON сохранён без перезаписи',corruptedJson],
    ['После временной ошибки чтения черновик восстановлен',readFailureRecovery],
    ['Повреждённая очередь отправки заблокирована',malformedPending],
    ['Отказ записи не отправляет смену; повтор безопасен',storageFull]
  ];
  async function runAll(){
    const checks=[];
    for(const [name,task] of cases){
      try{await task();checks.push({name,ok:true});}
      catch(error){checks.push({name,ok:false,error:String(error?.message||error).slice(0,140)});}
    }
    return {total:checks.length,passed:checks.filter(c=>c.ok).length,checks};
  }
  return {runAll};
});
