(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory(require('./account.js'),require('node:crypto').webcrypto);
  } else {
    root.WorklogSync = factory(root.WorklogAccounts,root.crypto);
  }
})(globalThis, function(accounts, crypto){
  'use strict';
  const copy = value=>JSON.parse(JSON.stringify(value));
  const validRevision = value=>Number.isSafeInteger(value) && value>=0;
  const mutationId = ()=>Array.from(crypto.getRandomValues(new Uint8Array(16)), byte=>byte.toString(16).padStart(2,'0')).join('');
  const snapshot = ({settings,days})=>copy({version:1,settings,days});
  const errorCode = error=>error?.code || 'network';

  function sameSnapshot(left,right){
    if(left===right) return true;
    if(!left || !right || typeof left!=='object' || typeof right!=='object') return false;
    const keys=Object.keys(left);
    return keys.length===Object.keys(right).length && keys.every(key=>
      Object.prototype.hasOwnProperty.call(right,key) && sameSnapshot(left[key],right[key]));
  }

  const record = value=>value!==null && typeof value==='object' && !Array.isArray(value);
  const validSnapshot = value=>record(value) && accounts.validateWorklog(value);
  const validPending = value=>value===null || (record(value) &&
    validSnapshot(value.data) &&
    (value.expectedRevision===null || validRevision(value.expectedRevision)) &&
    typeof value.mutationId==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.mutationId) &&
    typeof value.sent==='boolean' && (!value.sent || validRevision(value.expectedRevision)) &&
    (value.next==null || validSnapshot(value.next)) &&
    (value.blocked===undefined || ['invalid_worklog','worklog_too_large'].includes(value.blocked)));
  const validConflict = value=>value===null || (record(value) &&
    validSnapshot(value.local) && (value.server===null || validSnapshot(value.server)) &&
    (value.revision===null || validRevision(value.revision)) &&
    ['unknown_revision','stale_revision','mutation_mismatch'].includes(value.reason) &&
    typeof value.resolved==='boolean');
  function parseCache(raw){
    const saved=JSON.parse(raw);
    if(!record(saved) || !('data' in saved) || !('revision' in saved) ||
       (saved.revision!==null && !validRevision(saved.revision)) ||
       (saved.data!==null && !validSnapshot(saved.data)) ||
       !validPending(saved.pending===undefined?null:saved.pending) ||
       !validConflict(saved.conflict===undefined?null:saved.conflict)){
      throw new Error('Invalid Worklog local cache');
    }
    return {data:saved.data,revision:saved.revision,
      pending:saved.pending===undefined?null:saved.pending,
      conflict:saved.conflict===undefined?null:saved.conflict};
  }

  // Older caches may contain a follow-up with the same content as the sent data.
  const followUp = ({data,next})=>next && !sameSnapshot(data,next)?next:null;

  function create({uid, storage, api, onState=()=>{}, canRefresh=()=>true, canSend=()=>true}){
    const scope = accounts.userScope({uid});
    if(!scope) throw new Error('Invalid worklog account');
    const empty = {data:null,revision:null,pending:null,conflict:null};
    let stored=empty, error=null, closed=false, running=null, cacheUnsafe=false;
    try {
      const raw=storage.getItem(scope.cache);
      if(raw!==null && raw!==undefined){
        try {stored=parseCache(raw);}
        catch(e){cacheUnsafe=true;error='cache_corrupt';}
      }
    } catch(e){cacheUnsafe=true;error='cache_unreadable';}

    function load(){return {...copy(stored),error:error||stored.pending?.blocked||null};}

    function announce(){if(!closed) onState(load());}

    function setError(code){
      if(closed || code===error) return;
      error=code;
      announce();
    }

    function save(change){
      if(closed || cacheUnsafe) return false;
      // Commit the snapshot, pending write and recovery draft together.
      const updated = {...stored,...change};
      try {storage.setItem(scope.cache,JSON.stringify(updated));}
      catch(e){setError('storage'); return false;}
      stored=updated;
      error=null;
      announce();
      return true;
    }

    function pending(data, revision){
      return {data,expectedRevision:revision,mutationId:mutationId(),sent:false,next:null};
    }

    function edit(data){
      if(closed || cacheUnsafe) return false;
      const {version,settings,days}=data;
      if(!accounts.validateWorklog({version,settings,days})){setError('invalid_worklog'); return false;}
      const local=snapshot(data);
      const conflict=stored.conflict;
      if(conflict && !conflict.resolved) return save({data:local,conflict:{...conflict,local}});
      const queued=stored.pending;
      if(queued){
        if(sameSnapshot(local,queued.data)){
          if(!queued.next) return true;
          return save({data:queued.data,pending:{...queued,next:null}});
        }
        if(queued.next && sameSnapshot(local,queued.next)) return true;
      }
      return save({data:local,pending:queued?.sent && !queued.blocked?{...queued,next:local}:pending(local,stored.revision)});
    }

    function markConflict(reason){
      return save({pending:null,conflict:{local:stored.data,server:null,revision:null,reason,resolved:false}});
    }

    async function readServer(){
      const remote=await api.getWorklog();
      if(!remote || !validRevision(remote.revision) || (remote.data===null)!==(remote.revision===0) ||
         (remote.data!==null && !accounts.validateWorklog(remote.data))){
        throw Object.assign(new Error('Invalid worklog snapshot'),{code:'invalid_response'});
      }
      return remote;
    }

    async function updateConflict(){
      const remote=await readServer();
      if(closed) return false;
      const draft=stored.conflict;
      return save({conflict:{...draft,server:remote.data,revision:remote.revision}});
    }

    async function flushPending(){
      while(!closed && canSend() && stored.pending && !stored.pending.blocked){
        let queued=stored.pending;
        if(queued.expectedRevision===null){
          // An edit made without a known baseline can only use a pristine account.
          const remote=await readServer();
          if(closed || !canSend()) return;
          if(remote.revision!==0){
            if(markConflict('unknown_revision')){
              save({conflict:{...stored.conflict,server:remote.data,revision:remote.revision}});
            }
            return;
          }
          queued={...stored.pending,expectedRevision:0};
        }
        if(!queued.sent && !save({revision:queued.expectedRevision,pending:{...queued,sent:true}})) return;
        const {data,expectedRevision,mutationId}=queued;
        let result;
        try {result=await api.putWorklog({data:copy(data),expectedRevision,mutationId});}
        catch(e){
          if(closed) return;
          if([400,413,422].includes(e.status)){
            const latest=followUp(stored.pending);
            const blocked=e.status===413?'worklog_too_large':'invalid_worklog';
            if(!save({data:latest||data,pending:latest?pending(latest,expectedRevision):{...stored.pending,next:null,blocked}})) return;
            continue;
          }
          if(e.status!==409 || !['stale_revision','mutation_mismatch'].includes(e.code)) throw e;
          if(markConflict(e.code)) await updateConflict();
          return;
        }
        if(closed) return;
        if(result?.revision!==expectedRevision+1){
          throw Object.assign(new Error('Invalid worklog revision'),{code:'invalid_response'});
        }
        const next=followUp(stored.pending);
        if(!save({revision:result.revision,data:next||data,pending:next?pending(next,result.revision):null})) return;
      }
    }

    async function refreshServer(){
      if(stored.pending){await flushPending(); return;}
      if(stored.conflict && !stored.conflict.resolved){await updateConflict(); return;}
      if(!canRefresh()) return;
      const remote=await readServer();
      if(closed) return;
      if(stored.pending){await flushPending(); return;}
      if(!canRefresh()) return;
      if(remote.revision!==stored.revision || error){
        save({data:remote.data,revision:remote.revision});
      }
    }

    function run(operation){
      if(closed || cacheUnsafe) return Promise.resolve();
      if(running) return running;
      // Hold the shared slot before starting callbacks that may synchronously call back into this object.
      running=Promise.resolve().then(()=>{if(!closed) return operation();})
        .catch(error=>setError(errorCode(error))).finally(()=>{running=null;});
      return running;
    }

    async function resolveConflict(choice){
      if(choice!=='server' && choice!=='retry-local') throw new Error('Invalid conflict recovery choice');
      if(running) await running;
      if(closed || cacheUnsafe || !stored.conflict || stored.conflict.resolved) return;
      return run(async()=>{
        if(!await updateConflict() || closed) return;
        const draft=stored.conflict;
        if(choice==='server'){
          save({data:draft.server,revision:draft.revision,conflict:{...draft,resolved:true}});
        } else if(save({data:draft.local,revision:draft.revision,pending:pending(draft.local,draft.revision),conflict:null})){
          await flushPending();
        }
      });
    }

    // Never delete, clear or overwrite an unreadable/malformed cache automatically.
    // Retrying reads is safe: a valid record can be reloaded after a transient
    // storage fault or external, user-controlled restoration of a backup.
    function retryCache(){
      if(closed) return false;
      if(!cacheUnsafe) return true;
      let raw;
      try {raw=storage.getItem(scope.cache);}
      catch(e){setError('cache_unreadable');return false;}
      if(raw===null || raw===undefined){setError('cache_unreadable');return false;}
      let recovered;
      try {recovered=parseCache(raw);}
      catch(e){setError('cache_corrupt');return false;}
      stored=recovered;
      cacheUnsafe=false;
      error=null;
      announce();
      return true;
    }

    return {load,edit,retryCache,flush:()=>run(flushPending),refresh:()=>run(refreshServer),resolveConflict,close:()=>{closed=true;}};
  }

  return {create};
});
