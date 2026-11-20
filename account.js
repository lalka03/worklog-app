(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.WorklogAccounts = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function(){
  'use strict';
  function userScope(user){
    if(!user || typeof user.uid !== 'string' || !user.uid || /[.#$\[\]/]/.test(user.uid)) return null;
    return {uid:user.uid, path:'users/'+user.uid+'/worklog', cache:'worklog.test.v1:'+user.uid};
  }
  function canWrite(user, admin){ return !!userScope(user) && (admin === false || admin === true); }
  function employeeRows(users){
    return Object.entries(users || {}).map(([uid,value])=>{
      const data = value && value.worklog || {};
      const email = value && value.profile && value.profile.email;
      return {uid, email: typeof email === 'string' ? email : uid,
        days:Object.entries(data.days || {}).sort(([a],[b])=>b.localeCompare(a)), settings:data.settings || {}};
    }).sort((a,b)=>a.email.localeCompare(b.email));
  }
  return {userScope, canWrite, employeeRows};
});
