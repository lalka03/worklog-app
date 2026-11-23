'use strict';

// This file is injected only into the disposable Cache QA Android package.
// No real/admin account can sign in. Only one purpose-built synthetic employee
// may authenticate, and all admin/recovery commands are explicitly disabled.
(function(root){
  const QA_EMAIL = 'worklog.cache.qa.20261123@example.com';
  const originalCreate = root.WorklogApi?.create;
  if(typeof originalCreate !== 'function') throw new Error('CACHE_QA_API_MISSING');

  function denied(){
    const error = new Error('qa_account_only');
    error.code = 'qa_account_only';
    return Promise.reject(error);
  }
  function isQaUser(user) {
    return !!user && user.email === QA_EMAIL && user.role === 'employee';
  }
  function isQaEmail(email){
    return typeof email === 'string' && email.trim().toLowerCase() === QA_EMAIL;
  }
  const blocked = ['reset','redeemRecovery','employees','employee','createInvite',
    'listInvites','recoveryStatus','issueRecovery','revokeRecovery',
    'revokeInvite','issueReset'];
  root.WorklogApi.create = function(options){
    const api = originalCreate(options);
    let allowed = false;
    const track = fn => async (...args) => {
      const user = await fn(...args);
      if(!user) {allowed=false;return null;}
      if(!isQaUser(user)){
        allowed=false;
        try {await api.logout();} catch(e){}
        throw new Error('CACHE_QA_UNEXPECTED_ACCOUNT');
      }
      allowed=true;
      return user;
    };
    const qa = {
      ...api,
      login: (email,...args) => isQaEmail(email) ? track(api.login)(email,...args) : denied(),
      register: (email,...args) => isQaEmail(email) ? track(api.register)(email,...args) : denied(),
      restore: track(api.restore),
      renew: track(api.renew),
      reconnect: track(api.reconnect),
      logout: async (...args) => {allowed=false;return api.logout(...args);},
      getWorklog: (...args) => allowed ? api.getWorklog(...args) : denied(),
      putWorklog: (...args) => allowed ? api.putWorklog(...args) : denied()
    };
    for(const name of blocked) qa[name] = denied;
    return qa;
  };
})(globalThis);
