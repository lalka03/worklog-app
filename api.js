(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.WorklogApi = api;
})(globalThis, function(){
  'use strict';

  class ApiError extends Error {
    constructor(code, status=0){
      super(code);
      this.code = code;
      this.status = status;
    }
  }

  function memoryStore(){
    let tokens = null;
    return {get:()=>tokens, set:value=>{tokens=value;}, clear:()=>{tokens=null;}};
  }

  function httpsBase(value){
    try {
      const url = new URL(value);
      if(url.protocol==='https:' && !url.username && !url.password && !url.search && !url.hash){
        return url.href.replace(/\/+$/, '');
      }
    } catch(e){}
    return null;
  }

  function create({baseUrl, fetch:send, tokenStore=memoryStore(), rememberStore=null, timeoutMs=12000, onSession=()=>{}}){
    const base = httpsBase(baseUrl);
    let generation = 0;
    let renewal = null;
    let remembered = false;
    let storageQueue = Promise.resolve();
    let storageEmpty = false;

    async function request(path, {method='GET', body, token}={}){
      if(!base) throw new ApiError('unconfigured');
      const serialized = body===undefined?undefined:JSON.stringify(body);
      if(method==='PUT' && new TextEncoder().encode(serialized).length>512*1024){
        throw new ApiError('worklog_too_large',413);
      }
      const controller = new AbortController();
      const headers = {'Accept':'application/json'};
      if(body!==undefined) headers['Content-Type']='application/json';
      if(token) headers['X-Worklog-Authorization']=`Bearer ${token}`;
      let timer;
      const timeout = new Promise((_,reject)=>{
        timer=setTimeout(()=>{reject(new ApiError('timeout')); controller.abort();},timeoutMs);
      });
      try {
        const operation = async()=>{
          const response = await send(base+path, {method, headers, body:serialized,
            signal:controller.signal, credentials:'omit', redirect:'error', cache:'no-store'});
          let payload;
          try { payload=await response.json(); }
          catch(e){
            throw new ApiError(response.ok?'invalid_response':'request_failed',response.status);
          }
          if(!response.ok) throw new ApiError(typeof payload?.error==='string'?payload.error:'request_failed', response.status);
          return payload;
        };
        return await Promise.race([operation(),timeout]);
      } catch(e){
        if(e instanceof ApiError) throw e;
        throw new ApiError('network');
      } finally {clearTimeout(timer);}
    }

    function sameGeneration(current){
      if(current!==generation) throw new ApiError('session_changed');
    }

    function activeTokens(current){
      sameGeneration(current);
      const tokens = tokenStore.get();
      if(!tokens) throw new ApiError('invalid_session',401);
      return tokens;
    }

    function validateAuth(result){
      if(!result || typeof result.user?.uid!=='string' || typeof result.user.email!=='string' ||
         !['admin','employee'].includes(result.user.role) || typeof result.accessToken!=='string' ||
         !result.accessToken || typeof result.refreshToken!=='string' || !result.refreshToken){
        throw new ApiError('invalid_response');
      }
      return result;
    }

    async function revoke(token){
      try {await request('/auth/logout',{method:'POST',token});}
      catch(e){} // Local logout is immediate, including when offline.
    }

    // Serialize native operations, so a late write cannot outlive logout or a new login.
    function storage(current, operation){
      if(!rememberStore) return Promise.resolve(null);
      const task=storageQueue.then(async()=>{
        sameGeneration(current);
        let value;
        try {value=await operation(rememberStore);}
        catch(e){throw new ApiError('secure_storage');}
        sameGeneration(current);
        return value;
      });
      storageQueue=task.catch(()=>{});
      return task;
    }

    function clearSaved(current){
      return storage(current,async store=>{
        if(!storageEmpty) await store.clear();
        storageEmpty=true;
      });
    }

    async function install(current,result,keep){
      try {
        sameGeneration(current);
        if(keep) await storage(current,async store=>{
          storageEmpty=false;
          await store.set(result.refreshToken);
        });
        sameGeneration(current);
        tokenStore.set(result);
        remembered=keep;
      } catch(e){
        void revoke(result.accessToken);
        if(current===generation && keep){
          remembered=false;
          await clearSaved(current);
        }
        throw e;
      }
    }

    async function authenticate(action, body, keep=false){
      const current = ++generation;
      tokenStore.clear();
      renewal = null;
      remembered=false;
      if(rememberStore) await clearSaved(current);
      sameGeneration(current);
      const result = validateAuth(await request('/auth/'+action,{method:'POST',body}));
      await install(current,result,keep);
      sameGeneration(current);
      return result.user;
    }

    async function expire(current){
      if(current===generation && tokenStore.get()){
        tokenStore.clear();
        remembered=false;
        onSession(null);
        await clearSaved(current);
      }
    }

    async function restore(){
      if(!rememberStore) return null;
      const current=++generation;
      tokenStore.clear(); renewal=null; remembered=false;
      const saved=await storage(current,async store=>{
        const token=await store.get();
        storageEmpty=!token;
        return token;
      });
      sameGeneration(current);
      if(!saved) return null;
      let result;
      try {
        result=validateAuth(await request('/auth/renew',{method:'POST',body:{refreshToken:saved}}));
      } catch(e){
        sameGeneration(current);
        if(e.status!==401) throw e;
        await clearSaved(current);
        sameGeneration(current);
        return null;
      }
      await install(current,result,true);
      sameGeneration(current);
      return result.user;
    }

    async function renewSession(current, failedAccess){
      const tokens = activeTokens(current);
      if(failedAccess && tokens.accessToken!==failedAccess) return tokens;
      if(renewal) return renewal;
      const operation = (async()=>{
        try {
          const result = validateAuth(await request('/auth/renew',{method:'POST',body:{refreshToken:tokens.refreshToken}}));
          if(current!==generation){
            void revoke(result.accessToken);
            sameGeneration(current);
          }
          activeTokens(current);
          if(result.user.uid!==tokens.user.uid) throw new ApiError('invalid_session',401);
          await install(current,result,remembered);
          sameGeneration(current);
          if(result.user.role!==tokens.user.role) onSession(result.user);
          return result;
        } catch(e){
          sameGeneration(current);
          if(e.status===401 || e.code==='secure_storage') await expire(current);
          throw e;
        }
      })();
      renewal = operation;
      try {return await operation;}
      finally {if(renewal===operation) renewal=null;}
    }

    async function authorized(path, options={}, current=generation){
      const {accessToken} = activeTokens(current);
      const withToken = token=>request(path,{...options,token});
      let payload;
      try {payload=await withToken(accessToken);}
      catch(e){
        sameGeneration(current);
        if(e.status!==401) throw e;
        const renewed = await renewSession(current,accessToken);
        activeTokens(current);
        try {payload=await withToken(renewed.accessToken);}
        catch(retryError){
          sameGeneration(current);
          if(retryError.status===401) await expire(current);
          throw retryError;
        }
      }
      activeTokens(current);
      return payload;
    }

    async function employees(){
      const current = generation;
      const users = Object.create(null);
      const seen = new Set();
      let cursor = '';
      do {
        const page = await authorized('/admin/employees'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{},current);
        if(!page?.users || typeof page.users!=='object' || Array.isArray(page.users)) throw new ApiError('invalid_response');
        Object.assign(users,page.users);
        cursor=page.nextCursor;
        if(cursor===undefined) return {users};
        if(typeof cursor!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(cursor) || seen.has(cursor)){
          throw new ApiError('invalid_response');
        }
        seen.add(cursor);
      } while(cursor);
      throw new ApiError('invalid_response');
    }

    return {
      login:(email,password,remember=false)=>{
        const keep=remember===true && !!rememberStore;
        return authenticate('login',{email,password,...(keep?{remember:true}:{})},keep);
      },
      restore,
      register:(email,password,invite)=>authenticate('register',{email,password,invite}),
      reset:(code,newPassword)=>request('/auth/reset',{method:'POST',body:{code,newPassword}}),
      renew:async()=> (await renewSession(generation)).user,
      async logout(){
        const tokens = tokenStore.get();
        const current=++generation;
        tokenStore.clear();
        renewal=null;
        remembered=false;
        try {await clearSaved(current);}
        finally {if(tokens) await revoke(tokens.accessToken);}
      },
      getWorklog:()=>authorized('/me/worklog'),
      putWorklog:({data:{version, settings, days},expectedRevision,mutationId})=>authorized('/me/worklog',{
        method:'PUT',body:{data:{version,settings,days},expectedRevision,mutationId}
      }),
      employees,
      employee:uid=>authorized('/admin/employees/'+encodeURIComponent(uid)),
      createInvite:()=>authorized('/admin/invites',{method:'POST'}),
      listInvites:()=>authorized('/admin/invites'),
      revokeInvite:id=>authorized('/admin/invites/'+encodeURIComponent(id),{method:'DELETE'}),
      issueReset:uid=>authorized('/admin/users/'+encodeURIComponent(uid)+'/reset',{method:'POST'})
    };
  }

  return {create};
});
