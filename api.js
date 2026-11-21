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

  function create({baseUrl, fetch:send, tokenStore=memoryStore(), rememberStore=null, timeoutMs=12000, now=Date.now, onSession=()=>{}}){
    const base = httpsBase(baseUrl);
    let generation = 0;
    let renewal = null;
    let protectedEpoch = 0, renewalEpoch = 0;
    let remembered = false;
    let savedRecord = null;
    let offline = false;
    let needsOnlineRenewal = false;
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
      let timer, receivedErrorStatus=0;
      const timeout = new Promise((_,reject)=>{
        timer=setTimeout(()=>{reject(receivedErrorStatus?new ApiError('request_failed',receivedErrorStatus):new ApiError('timeout')); controller.abort();},timeoutMs);
      });
      try {
        const operation = async()=>{
          const response = await send(base+path, {method, headers, body:serialized,
            signal:controller.signal, credentials:'omit', redirect:'error', cache:'no-store'});
          if(!response.ok) receivedErrorStatus=response.status;
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
      if(offline) throw new ApiError('offline');
      const tokens = tokenStore.get();
      if(!tokens) throw new ApiError('invalid_session',401);
      return tokens;
    }

    function sameProtectedEpoch(epoch){
      if(epoch!==protectedEpoch) throw new ApiError('session_changed');
    }

    function protectedTokens(current,epoch){
      sameProtectedEpoch(epoch);
      const tokens=activeTokens(current);
      if(needsOnlineRenewal) throw new ApiError('offline');
      return tokens;
    }

    function validUser(user){
      if(!user || typeof user.uid!=='string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(user.uid) ||
         typeof user.email!=='string' || user.email.length>254 || user.email.indexOf('@')>64 ||
         !['admin','employee'].includes(user.role)) return false;
      return /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(user.email);
    }

    function timestamp(value){
      const ms=typeof value==='string'?Date.parse(value):NaN;
      return ms>0 && new Date(ms).toISOString().replace('.000Z','Z')===value &&
        value.length===20?ms:NaN;
    }

    function localTime(value){
      return Number.isSafeInteger(value) && value>0 && value<=8640000000000000;
    }

    function deadline(grant){
      const end=timestamp(grant.refreshExpiresAt), remaining=end-timestamp(grant.serverTime);
      if(!(remaining>0 && remaining<=30*86400000)) return NaN;
      return Math.min(end,grant.verifiedLocalMs+remaining);
    }

    function validGrant(grant,time){
      return grant?.version===1 && Object.keys(grant).length===6 && validUser(grant.user) &&
        Object.keys(grant.user).length===3 && localTime(time) && localTime(grant.verifiedLocalMs) &&
        localTime(grant.checkedLocalMs) && grant.checkedLocalMs>=grant.verifiedLocalMs &&
        time>=grant.checkedLocalMs && time<deadline(grant);
    }

    function offlineValid(){
      return (offline || remembered) && !!savedRecord && validGrant(savedRecord.grant,now());
    }

    function nextRecord(result,previous){
      const time=now(), {uid,email,role}=result.user;
      const grant={version:1,user:{uid,email,role},serverTime:result.serverTime,
        refreshExpiresAt:result.refreshExpiresAt,verifiedLocalMs:time,checkedLocalMs:time};
      if(!validGrant(grant,time)){
        if(previous) throw new ApiError('invalid_response');
        return null;
      }
      if(previous){
        if(!validGrant(previous,time) || uid!==previous.user.uid) throw new ApiError('invalid_session',401);
        // Preserve the original clock anchor. A shorter server window can only narrow access.
        if(deadline(previous)<=deadline(grant)){
          Object.assign(grant,{serverTime:previous.serverTime,refreshExpiresAt:previous.refreshExpiresAt,
            verifiedLocalMs:previous.verifiedLocalMs});
        }
        if(timestamp(grant.refreshExpiresAt)>timestamp(previous.refreshExpiresAt)){
          grant.refreshExpiresAt=previous.refreshExpiresAt;
        }
        if(!validGrant(grant,time)) throw new ApiError('invalid_session',401);
      }
      return {token:result.refreshToken,grant};
    }

    function validCredential(value){
      return typeof value==='string' && /^[A-Za-z0-9_-]{22,128}$/.test(value);
    }

    function validateAuth(result){
      if(!result || !validUser(result.user) || !validCredential(result.accessToken) || !validCredential(result.refreshToken)){
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
        catch(e){if(e instanceof ApiError) throw e; throw new ApiError('secure_storage');}
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

    async function install(current,result,keep,epoch=protectedEpoch){
      try {
        sameGeneration(current);
        if(keep) await storage(current,async store=>{
          const record=nextRecord(result,savedRecord?.grant);
          storageEmpty=false;
          await store.set(record || result.refreshToken);
          sameGeneration(current);
          if(record && !validGrant(record.grant,now())) throw new ApiError('invalid_session',401);
          savedRecord=record;
        });
        sameGeneration(current);
        // A late rotation is still authoritative for the next refresh. Only a
        // verification started after the most recent disconnect restores access.
        if(epoch===protectedEpoch){offline=false;needsOnlineRenewal=false;}
        if(!offline) tokenStore.set(result);
        remembered=keep;
      } catch(e){
        void revoke(result.accessToken);
        throw e;
      }
    }

    async function authenticate(action, body, keep=false){
      const current = ++generation;
      tokenStore.clear();
      savedRecord=null; offline=false; needsOnlineRenewal=false;
      renewal = null;
      remembered=false;
      if(rememberStore) await clearSaved(current);
      sameGeneration(current);
      const result = validateAuth(await request('/auth/'+action,{method:'POST',body}));
      try {await install(current,result,keep);}
      catch(e){
        if(keep && current===generation) await expire(current);
        throw e;
      }
      sameGeneration(current);
      return result.user;
    }

    async function expire(current){
      if(current!==generation) return;
      const expiredGeneration=++generation;
      renewal=null;
      const notify=offline || !!tokenStore.get();
      tokenStore.clear();
      offline=false; needsOnlineRenewal=false; savedRecord=null; remembered=false;
      if(notify) onSession(null);
      await clearSaved(expiredGeneration);
    }

    async function checkpointOffline(){
      if(!offline || !savedRecord) return false;
      const current=generation;
      try {
        await storage(current,async store=>{
          if(!offline || !savedRecord) return;
          const time=now();
          if(!validGrant(savedRecord.grant,time)) throw new ApiError('invalid_session',401);
          const record={token:savedRecord.token,grant:{...savedRecord.grant,checkedLocalMs:time}};
          await store.set(record);
          sameGeneration(current);
          if(!validGrant(record.grant,now())) throw new ApiError('invalid_session',401);
          savedRecord=record;
        });
        return current===generation && offline && offlineValid();
      } catch(e){
        if(current===generation){
          try {await expire(current);}
          catch(cleanupError){if(cleanupError.code!=='secure_storage') throw cleanupError;}
        }
        return false;
      }
    }

    async function enterOffline(){
      if(!offline && !tokenStore.get()) return null;
      protectedEpoch++;
      needsOnlineRenewal=true;
      if(!savedRecord || (!offline && !remembered)) return null;
      tokenStore.clear();
      offline=true;
      const current=generation;
      const valid=await checkpointOffline();
      return valid && current===generation && offline && offlineValid()?{...savedRecord.grant.user}:null;
    }

    function transient(error){
      return !error.status && (error.code==='network' || error.code==='timeout');
    }

    async function exchange(current,token,epoch=protectedEpoch){
      const result=validateAuth(await request('/auth/renew',{method:'POST',body:{refreshToken:token}}));
      await install(current,result,true,epoch);
      sameGeneration(current);
      return result.user;
    }

    function rejected(error){
      return error.status===401 || error.status===403 || (error.code==='invalid_response' && (!error.status || error.status<300));
    }

    async function restore(){
      if(!rememberStore) return null;
      const current=++generation;
      tokenStore.clear(); renewal=null; remembered=false; offline=false; needsOnlineRenewal=false; savedRecord=null;
      const saved=await storage(current,async store=>{
        const value=await store.get();
        storageEmpty=!value;
        return value;
      });
      sameGeneration(current);
      if(!saved) return null;
      if(typeof saved!=='string'){
        if(Object.keys(saved).length!==2 || !validCredential(saved.token) ||
           !validGrant(saved.grant,now())){
          await clearSaved(current);
          return null;
        }
        savedRecord=saved;
      }
      try {
        return await exchange(current,savedRecord?.token || saved);
      } catch(e){
        sameGeneration(current);
        if(transient(e) && savedRecord){
          offline=true;
          return enterOffline();
        }
        savedRecord=null;
        if(!rejected(e) && e.code!=='secure_storage') throw e;
        await expire(current);
        if(e.code==='secure_storage') throw e;
        return null;
      }
    }

    async function reconnect(){
      const current=generation, epoch=protectedEpoch;
      if(renewal && renewalEpoch!==epoch){
        // Let the server rotate exactly once. Fresh verification must use its successor.
        try {await renewal;} catch(e){if(!transient(e) && e.code!=='session_changed') throw e;}
        sameGeneration(current);
        sameProtectedEpoch(epoch);
        return reconnect();
      }
      if(!offline){
        if(needsOnlineRenewal && tokenStore.get()){
          await renewSession(current);
          return protectedTokens(current,epoch).user;
        }
        return tokenStore.get()?.user || null;
      }
      if(renewal) return renewal;
      const operation=(async()=>{
        try {
          if(!offlineValid()) throw new ApiError('invalid_session',401);
          return await exchange(current,savedRecord.token,epoch);
        } catch(e){
          sameGeneration(current);
          const storageFailed=e.code==='secure_storage' && !e.status;
          if(offlineValid() && !rejected(e) && !storageFailed) throw e;
          await expire(current);
          if(rejected(e) || transient(e)) return null;
          throw e;
        }
      })().then(user=>{sameProtectedEpoch(epoch);return user;});
      renewalEpoch=epoch;
      renewal=operation;
      try {return await operation;}
      finally {if(renewal===operation) renewal=null;}
    }

    async function renewSession(current, failedAccess){
      const tokens = activeTokens(current), epoch=protectedEpoch;
      if(failedAccess && tokens.accessToken!==failedAccess) return tokens;
      if(renewal) return renewal;
      const operation = (async()=>{
        try {
          const result = validateAuth(await request('/auth/renew',{method:'POST',body:{refreshToken:tokens.refreshToken}}));
          if(current!==generation){
            void revoke(result.accessToken);
            sameGeneration(current);
          }
          if(result.user.uid!==tokens.user.uid) throw new ApiError('invalid_session',401);
          await install(current,result,remembered,epoch);
          sameGeneration(current);
          if(epoch===protectedEpoch && result.user.role!==tokens.user.role) onSession(result.user);
          return result;
        } catch(e){
          sameGeneration(current);
          if(rejected(e) || e.code==='secure_storage') await expire(current);
          throw e;
        }
      })();
      renewalEpoch=epoch;
      renewal = operation;
      try {return await operation;}
      finally {if(renewal===operation) renewal=null;}
    }

    async function authorized(path, options={}, current=generation,epoch=protectedEpoch){
      const {accessToken} = protectedTokens(current,epoch);
      const withToken = token=>request(path,{...options,token});
      let payload;
      try {payload=await withToken(accessToken);}
      catch(e){
        protectedTokens(current,epoch);
        if(e.status!==401) throw e;
        await renewSession(current,accessToken);
        const renewed=protectedTokens(current,epoch);
        try {payload=await withToken(renewed.accessToken);}
        catch(retryError){
          sameProtectedEpoch(epoch);
          if(retryError.status===401){
            if(current===generation && tokenStore.get()?.accessToken===renewed.accessToken) await expire(current);
          } else sameGeneration(current);
          throw retryError;
        }
      }
      protectedTokens(current,epoch);
      return payload;
    }

    async function employees(){
      const current = generation, epoch=protectedEpoch;
      const users = Object.create(null);
      const seen = new Set();
      let cursor = '';
      do {
        const page = await authorized('/admin/employees'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{},current,epoch);
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
      restore, requiresOnlineIdentity:()=>remembered && needsOnlineRenewal && !savedRecord, isOffline:()=>offline, offlineValid, enterOffline, checkpointOffline, reconnect,
      register:(email,password,invite)=>authenticate('register',{email,password,invite}),
      reset:(code,newPassword)=>request('/auth/reset',{method:'POST',body:{code,newPassword}}),
      renew:async()=>{
        if(needsOnlineRenewal && !offline) return reconnect();
        const current=generation, epoch=protectedEpoch;
        await renewSession(current);
        return protectedTokens(current,epoch).user;
      },
      async logout(){
        const tokens = tokenStore.get();
        const current=++generation;
        tokenStore.clear();
        renewal=null;
        savedRecord=null; offline=false; needsOnlineRenewal=false;
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
