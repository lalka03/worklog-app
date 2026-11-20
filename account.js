(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.WorklogAccounts = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function(){
  'use strict';
  function userScope(user){
    if(typeof user?.uid!=='string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(user.uid)) return null;
    return {uid:user.uid, cache:'worklog.yandex.test.v1:'+user.uid};
  }
  function canWrite(user, admin){return !!userScope(user) && typeof admin==='boolean';}

  const record = value=>!!value && typeof value==='object' && !Array.isArray(value);
  const has = (value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  const allowed = (value,keys)=>record(value) && Object.keys(value).every(key=>keys.includes(key));
  const exact = (value,keys)=>allowed(value,keys) && keys.every(key=>has(value,key));
  const MAX_SETTINGS=1e6, MAX_RATE=1e9;

  function validDate(value){
    if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
    const date=new Date(value+'T00:00:00Z');
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0,10)===value;
  }

  function validNumber(value, maximum){
    if(typeof value==='string'){
      if(value.length>64 || !/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value.trim())) return false;
      value=Number(value);
    }
    return typeof value==='number' && Number.isFinite(value) && value>=0 && value<=maximum;
  }

  function validShift(block){
    if(block===null || block===undefined) return true;
    if(!allowed(block,['hours','route','departure','after']) || !validNumber(block.hours,168) ||
       !validNumber(block.route,3) || ![1,2,3].includes(Number(block.route))) return false;
    if(has(block,'after') && typeof block.after!=='boolean') return false;
    if(!has(block,'departure')) return true;
    const time=block.departure;
    return typeof time==='string' && time.length<=16 && (!time.trim() || /^(?:[01]?[0-9]|2[0-3]):[0-5]?[0-9]$/.test(time.trim()));
  }

  function validateWorklog(data){
    if(!exact(data,['version','settings','days']) || data.version!==1 || !record(data.days)) return false;
    const {settings,days}=data;
    const numericSettings=['p1','p2','p3','th1','th2','coef'];
    if(!exact(settings,['anchor','rates',...numericSettings]) || !validDate(settings.anchor) ||
       !numericSettings.every(key=>validNumber(settings[key],MAX_SETTINGS)) ||
       Number(settings.p1)+Number(settings.p2)+Number(settings.p3)<=0 ||
       !exact(settings.rates,['1','2','3']) || !Object.values(settings.rates).every(rate=>validNumber(rate,MAX_RATE))) return false;
    for(const [date,day] of Object.entries(days)){
      if(!validDate(date) || !allowed(day,['date','main','pod']) || day.date!==date || !validShift(day.main)) return false;
      if(day.pod!=null && (!allowed(day.pod,['s1','s2']) || !Object.values(day.pod).every(validShift))) return false;
    }
    return new TextEncoder().encode(JSON.stringify(data)).length<=512*1024;
  }
  function employeeRows(users){
    return Object.entries(users || {}).map(([uid,value])=>{
      const data = value && value.worklog || {};
      const email = value && value.profile && value.profile.email;
      return {uid, email: typeof email === 'string' ? email : uid,
        days:Object.entries(data.days || {}).sort(([a],[b])=>b.localeCompare(a)), settings:data.settings || {}};
    }).sort((a,b)=>a.email.localeCompare(b.email));
  }
  return {userScope, canWrite, employeeRows, validateWorklog, validDate, validNumber, validShift};
});
