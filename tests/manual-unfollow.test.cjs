'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../core.js');
function harness(overrides = {}) {
  const original = core.normaliseRecord({handle:'target',followingOwners:['owner'],...overrides});
  const stored = {reviewData:{schemaVersion:1,thresholdDays:180,records:[original,core.normaliseRecord({handle:'other'})]}};
  let proof = null, permitted = true, exists = true, failRemoval = false, failClose = false, probeReads = 0, probeHook, closeCheckHook;
  const writes = [], windows = [], closes = [], events = {};
  const tab = {id:11,windowId:22,url:'https://x.com/target',status:'loading'};
  const chrome = {
    runtime:{id:'test',getURL:file=>'chrome-extension://test/'+file,onMessage:{addListener:fn=>events.message=fn},onStartup:{addListener:fn=>events.startup=fn}},
    storage:{local:{get:async key=>({[key]:structuredClone(stored[key])}),set:async values=>{if(failRemoval && values.manualUnfollow?.phase==='removed') throw Error('disk full'); writes.push(structuredClone(values));Object.assign(stored,structuredClone(values));},remove:async key=>delete stored[key]}},
    permissions:{contains:async()=>permitted},
    windows:{create:async options=>{windows.push(options);return{id:22,tabs:[{...tab}]};},update:async()=>({id:22})},
    tabs:{get:async()=>{
      if(closeCheckHook && stored.manualUnfollow?.phase==='removed'){
        const hook=closeCheckHook;closeCheckHook=null;await hook();
      }
      if(!exists)throw Error('closed');return {...tab};
    },remove:async tabId=>{
      closes.push({tabId,stored:structuredClone(stored)});
      if(failClose)throw Error('close rejected');
      exists=false;
      // Awaiting the listener exposes an accidental shared-write-queue deadlock.
      await events.removed(tabId);
    },query:async()=>[{...tab}],onRemoved:{addListener:fn=>events.removed=fn},onUpdated:{addListener:fn=>events.updated=fn}},
    scripting:{executeScript:async options=>{if(options.files)return [];if(options.target.documentIds){probeReads++;if(probeHook)probeHook(probeReads);return[{documentId:options.target.documentIds[0],result:structuredClone(proof)}];}return[{result:null}];}}
  };
  const context=vm.createContext({chrome,URL,Date,console,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout});
  context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context));
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../background.js'),'utf8'),context);
  const sender={id:'test',url:'chrome-extension://test/index.html',tab:{id:1}};
  const page={id:'test',tab:{id:11},frameId:0,documentId:'doc-1',url:'https://x.com/target'};
  const send=(message,from=sender)=>new Promise(resolve=>{
    if(events.message(message,from,resolve)===false)resolve({ok:false,error:'Message ignored'});
  });
  const begin=async()=>{const result=await send({type:'UNFOLLOW_BEGIN',key:original.key});assert(result.ok,result.error);tab.status='complete';return result.data;};
  async function observe(phase,extra={},from=page){
    const identity={runId:stored.manualUnfollow.runId,handle:'target',id:original.id||'123',viewer:'owner',...extra};
    proof={...identity,state:phase==='following'?'following':'follow',trustedAction:phase==='confirmed',stableFor:2500,
      ...(phase==='reconcile'?{observationKind:'already-not-following'}:{})};
    return send({type:'UNFOLLOW_OBSERVED',phase,...identity},from);
  }
  return {stored,writes,windows,closes,tab,events,page,sender,original,send,begin,observe,
    permission:value=>permitted=value,exists:value=>exists=value,failRemoval:()=>failRemoval=true,
    failClose:()=>failClose=true,beforeCloseCheck:fn=>closeCheckHook=fn,
    mutateProof:fn=>probeHook=fn,proof:()=>proof,setProof:value=>proof=value};
}
const hasTarget=h=>h.stored.reviewData.records.some(record=>record.key===h.original.key);
test('manual unfollow opens one native popup and only verified transition deletes the target atomically',async()=>{
  const h=harness();await h.begin();assert(hasTarget(h));assert.equal(h.windows[0].type,'popup');assert.equal(h.windows[0].url,'https://x.com/target');
  await h.send({type:'UNFOLLOW_BEGIN',key:h.original.key});assert.equal(h.windows.length,1);
  assert.equal((await h.observe('following')).data.phase,'armed');assert(hasTarget(h));
  const done=await h.observe('confirmed');assert.equal(done.data.phase,'removed');assert(!hasTarget(h));assert.equal(h.stored.reviewData.records.length,1);
  const transaction=h.writes.find(write=>write.manualUnfollow?.phase==='removed');assert(transaction.reviewData);assert.equal(transaction.manualUnfollowUndo.record.key,h.original.key);
});
test('already-follow state without a recorded following state cannot delete',async()=>{
  const h=harness();await h.begin();assert.equal((await h.observe('confirmed')).ok,false);assert(hasTarget(h));
});
test('a stable not-followed account reconciles an owner-bound stale record atomically',async()=>{
  const h=harness({followingOwners:['owner','OWNER']});await h.begin();
  const done=await h.observe('reconcile');assert.equal(done.data.phase,'removed');assert(!hasTarget(h));
  assert.match(done.data.reason,/当前未关注/);assert.doesNotMatch(done.data.reason,/已确认手动取关/);
  assert.equal(h.stored.reviewData.records.length,1);
  const transaction=h.writes.find(write=>write.manualUnfollow?.phase==='removed');
  assert(transaction.reviewData);assert.equal(transaction.manualUnfollowUndo.record.key,h.original.key);
  assert.equal(h.windows.length,1);
});
test('reconciliation after a queued arm acknowledgement preserves the bound identity',async()=>{
  const h=harness();await h.begin();await h.observe('following');
  assert.equal((await h.observe('reconcile')).data.phase,'removed');assert(!hasTarget(h));
});
test('reconciliation cannot remove records with missing, different or multiple owners',async()=>{
  for(const owners of [[],['another'],['owner','another']]){
    const h=harness({followingOwners:owners});await h.begin();
    const done=await h.observe('reconcile');assert.equal(done.data.phase,'retained');assert(hasTarget(h));
    assert.match(done.data.reason,owners.length?/其他或多个/:/没有关注名单归属/);
    assert.equal(h.stored.manualUnfollowUndo,undefined);
  }
  const h=harness();await h.begin();
  assert.equal((await h.observe('reconcile',{viewer:'another'})).data.phase,'retained');assert(hasTarget(h));
});
test('reconciliation requires the intended tab, main frame, profile URL and numeric identity',async()=>{
  for(const sender of [{tab:{id:99}},{frameId:1},{url:'https://x.com/someone_else'},{id:'other-extension'}]){
    const h=harness();await h.begin();
    assert.equal((await h.observe('reconcile',{}, {...h.page,...sender})).ok,false);assert(hasTarget(h));
  }
  for(const identity of [{handle:'someone_else'},{id:'999'}]){
    const h=harness({id:'123'});await h.begin();
    assert.equal((await h.observe('reconcile',identity)).ok,false);assert(hasTarget(h));
  }
});
test('armed reconciliation rejects conflicting document, viewer and target identities',async()=>{
  for(const change of [{documentId:'doc-old'},{viewer:'another'},{id:'999'}]){
    const h=harness();await h.begin();await h.observe('following');
    const sender={...h.page,...(change.documentId?{documentId:change.documentId}:{})};
    assert.equal((await h.observe('reconcile',change,sender)).ok,false);assert(hasTarget(h));
  }
});
test('reconciliation rejects incomplete, unstable or falsely attributed page proofs',async()=>{
  for(const bad of [
    {observationKind:undefined},{observationKind:'manual-unfollow'},{trustedAction:true},{trustedAction:undefined},
    {stableFor:1999},{stableFor:Infinity},{stableFor:NaN},{stableFor:'2500'},
    {state:'following'},{viewer:'another'},{id:'999'},{runId:'old-session'},{handle:'someone_else'}
  ]){
    const h=harness();await h.begin();h.mutateProof(()=>Object.assign(h.proof(),bad));
    assert.equal((await h.observe('reconcile')).ok,false,JSON.stringify(bad));assert(hasTarget(h));
  }
});
test('reconciliation probes again immediately before removal and preserves a refollowed account',async()=>{
  const h=harness();await h.begin();let reads=0;
  h.mutateProof(()=>{if(++reads===2)Object.assign(h.proof(),{state:'following',stableFor:0});});
  assert.equal((await h.observe('reconcile')).ok,false);assert.equal(reads,2);assert(hasTarget(h));
});
test('reconciliation keeps records when the run expires or access is revoked during a probe',async()=>{
  for(const action of ['expire','revoke']){
    const h=harness();await h.begin();let reads=0;
    h.mutateProof(()=>{if(++reads===2){if(action==='expire')h.stored.manualUnfollow.expiresAt='2000-01-01T00:00:00Z';else h.permission(false);}});
    assert.equal((await h.observe('reconcile')).ok,false);assert(hasTarget(h));
  }
});
test('concurrent local edits are retained when current X state is reconciled',async()=>{
  const h=harness();await h.begin();await h.send({type:'STATUS',key:h.original.key,status:'keep'});
  const done=await h.observe('reconcile');assert.equal(done.data.phase,'retained');assert(hasTarget(h));
  assert.equal(h.stored.reviewData.records.find(record=>record.key===h.original.key).status,'keep');
  assert.equal(h.stored.manualUnfollowUndo,undefined);
});
test('reconciliation keeps conflicting local numeric identities',async()=>{
  const h=harness();h.stored.reviewData.records.push(core.normaliseRecord({handle:'target',id:'999'}));await h.begin();
  assert.equal((await h.observe('reconcile')).data.phase,'retained');assert(hasTarget(h));
});
test('undo restores reconciled local data without an X action and ignores duplicate completion',async()=>{
  const h=harness();await h.begin();await h.observe('reconcile');
  assert.equal((await h.send({type:'UNFOLLOW_STATUS'})).data.canUndo,true);
  assert.equal((await h.send({type:'UNFOLLOW_UNDO'})).data.restored,1);assert(hasTarget(h));
  await h.observe('reconcile');assert(hasTarget(h));assert.equal(h.windows.length,1);
});
test('failed reconciliation transactions retain the record and prior undo',async()=>{
  const h=harness();h.stored.manualUnfollowUndo={runId:'older',record:core.normaliseRecord({handle:'prior'})};await h.begin();h.failRemoval();
  assert.equal((await h.observe('reconcile')).data.phase,'failed');assert(hasTarget(h));assert.equal(h.stored.manualUnfollowUndo.runId,'older');
});
test('foreign tabs, iframes, stale documents and wrong profile identities cannot delete',async()=>{
  const h=harness({id:'123'});await h.begin();await h.observe('following');
  for(const sender of [{...h.page,tab:{id:99}},{...h.page,frameId:2},{...h.page,documentId:'doc-old'}])assert.equal((await h.observe('confirmed',{},sender)).ok,false);
  for(const identity of [{id:'999'},{handle:'someone_else'},{viewer:'another_owner'}])assert.equal((await h.observe('confirmed',identity)).ok,false);
  assert(hasTarget(h));
});
test('untrusted, unstable or changed DOM evidence is rejected by the fresh probe',async()=>{
  const h=harness();await h.begin();await h.observe('following');
  for(const bad of [{trustedAction:false},{stableFor:100},{state:'following'},{viewer:'changed'}]){
    h.mutateProof(()=>Object.assign(h.proof(),bad));assert.equal((await h.observe('confirmed')).ok,false);assert(hasTarget(h));
  }
});
test('a refollow between initial verification and queued commit is rechecked',async()=>{
  const h=harness();await h.begin();await h.observe('following');let reads=0;
  h.mutateProof(()=>{if(++reads===2)Object.assign(h.proof(),{state:'following',stableFor:0});});
  assert.equal((await h.observe('confirmed')).ok,false);assert(hasTarget(h));
});
test('pending navigation and tab loading retain the record even with an old visible URL',async()=>{
  for(const change of [{pendingUrl:'https://x.com/other'},{status:'loading'}]){
    const h=harness();await h.begin();await h.observe('following');Object.assign(h.tab,change);
    assert.equal((await h.observe('confirmed')).ok,false);assert(hasTarget(h));
  }
});
test('closing, cancelling, reloading, timing out or restarting never deletes',async()=>{
  for(const action of ['close','cancel','reload','timeout','restart','watcher-stop']){
    const h=harness();await h.begin();await h.observe('following');
    if(action==='close')await h.events.removed(11);
    if(action==='cancel')await h.send({type:'UNFOLLOW_CANCEL'});
    if(action==='reload'){h.events.updated(11,{status:'loading'},h.tab);await new Promise(resolve=>setTimeout(resolve,5));}
    if(action==='timeout'){h.stored.manualUnfollow.expiresAt='2000-01-01T00:00:00Z';await h.send({type:'UNFOLLOW_STATUS'});}
    if(action==='restart')await h.events.startup();
    if(action==='watcher-stop')await h.send({type:'UNFOLLOW_WATCH_STOPPED',runId:h.stored.manualUnfollow.runId,reason:'Could not confirm'},h.page);
    assert.equal(h.stored.manualUnfollow.phase,'cancelled',action);await h.observe('confirmed');assert(hasTarget(h),action);
  }
});
test('revoking optional access prevents deletion and makes status terminal',async()=>{
  const h=harness();await h.begin();await h.observe('following');h.permission(false);
  assert.equal((await h.observe('confirmed')).ok,false);assert(hasTarget(h));
  assert.equal((await h.send({type:'UNFOLLOW_STATUS'})).data.session.phase,'cancelled');
});
test('records changed during a native unfollow are retained',async()=>{
  const h=harness();await h.begin();await h.observe('following');await h.send({type:'STATUS',key:h.original.key,status:'keep'});
  const done=await h.observe('confirmed');assert.equal(done.data.phase,'retained');assert(hasTarget(h));assert.equal(h.stored.reviewData.records[0].status,'keep');
});
test('other-owner and multi-owner records remain; legacy unowned records can be explicitly removed',async()=>{
  for(const owners of [['another'],['owner','another']]){const h=harness({followingOwners:owners});await h.begin();assert.equal((await h.observe('following')).data.phase,'retained');assert(hasTarget(h));}
  const h=harness({followingOwners:[]});await h.begin();await h.observe('following');assert.equal((await h.observe('confirmed')).data.phase,'removed');assert(!hasTarget(h));
});
test('numeric ID records require matching native button identity and handle if known',async()=>{
  const h=harness({id:'123',handle:undefined});h.tab.url='https://x.com/resolved';h.page.url=h.tab.url;await h.begin();
  assert.equal(h.windows[0].url,'https://x.com/i/user/123');
  assert.equal((await h.observe('following',{handle:'resolved',id:'999'})).ok,false);
  assert.equal((await h.observe('following',{handle:'resolved',id:'123'})).data.phase,'armed');
  assert.equal((await h.observe('confirmed',{handle:'resolved',id:'123'})).data.phase,'removed');
});
test('a conflicting known numeric identity prevents deletion of a handle-only record',async()=>{
  const h=harness();h.stored.reviewData.records.push(core.normaliseRecord({handle:'target',id:'999'}));await h.begin();
  assert.equal((await h.observe('following')).data.phase,'retained');assert(hasTarget(h));
});
test('undo restores local data only, and duplicate completion cannot remove it again',async()=>{
  const h=harness();await h.begin();await h.observe('following');await h.observe('confirmed');
  assert.equal((await h.send({type:'UNFOLLOW_STATUS'})).data.canUndo,true);
  assert.equal((await h.send({type:'UNFOLLOW_UNDO'})).data.restored,1);assert(hasTarget(h));
  await h.observe('confirmed');assert(hasTarget(h));assert.equal(h.windows.length,1);
});
test('undo never overwrites a newer reimported record',async()=>{
  const h=harness();await h.begin();await h.observe('following');await h.observe('confirmed');
  await h.send({type:'MERGE',records:[{...h.original,name:'New name',status:'keep'}]});
  assert.equal((await h.send({type:'UNFOLLOW_UNDO'})).data.restored,0);assert.equal(h.stored.reviewData.records.find(record=>record.key===h.original.key).name,'New name');
});
test('removal trims matching stale scan undo while preserving unrelated undo entries',async()=>{
  const h=harness();h.stored.followingSyncUndo={runId:'old-scan',records:[h.original,core.normaliseRecord({handle:'missing'})]};
  await h.begin();await h.observe('following');await h.observe('confirmed');
  assert.deepEqual(h.stored.followingSyncUndo.records.map(record=>record.handle),['missing']);
  await h.send({type:'SYNC_UNDO'});assert(!hasTarget(h));
});
test('failed removal transaction retains records and previous undo without success acknowledgement',async()=>{
  const h=harness();h.stored.manualUnfollowUndo={runId:'older',record:core.normaliseRecord({handle:'prior'})};await h.begin();await h.observe('following');h.failRemoval();
  assert.equal((await h.observe('confirmed')).data.phase,'failed');assert(hasTarget(h));assert.equal(h.stored.manualUnfollowUndo.runId,'older');
});
test('manual sessions and automatic collection/checks are mutually exclusive',async()=>{
  const h=harness();await h.begin();
  h.tab.url='https://x.com/owner/following';
  const scan=await h.send({type:'SCAN_BEGIN',tabId:11,ownerConfirmed:true});assert.equal(scan.ok,false);assert.match(scan.error,/取关/);
  const activity=await h.send({type:'ACT_BEGIN',mode:'all',limit:5},{...h.sender,url:'chrome-extension://test/activity.html'});assert.equal(activity.ok,false);assert.match(activity.error,/取关/);
  const a=harness();a.stored.followingScan={phase:'paused'};assert.equal((await a.send({type:'UNFOLLOW_BEGIN',key:a.original.key})).ok,false);
  const b=harness();b.stored.activityRun={phase:'running'};assert.equal((await b.send({type:'UNFOLLOW_BEGIN',key:b.original.key})).ok,false);
});
test('clear erases manual undo and makes late observations unable to restore or remove data',async()=>{
  const h=harness();await h.begin();await h.observe('following');await h.observe('confirmed');await h.send({type:'CLEAR'});
  assert.equal(h.stored.manualUnfollowUndo,null);assert.equal(h.stored.reviewData.records.length,0);
  await h.observe('confirmed');await h.send({type:'UNFOLLOW_UNDO'});assert.equal(h.stored.reviewData.records.length,0);
});


for(const phase of ['confirmed','reconcile']){
  test(phase+' closes only the dedicated tab after local removal and its undo have been saved',{timeout:2000},async()=>{
    const h=harness();const run=await h.begin();
    assert.equal(h.closes.length,0);
    if(phase==='confirmed'){
      await h.observe('following');
      assert.equal(h.closes.length,0);
    }
    const done=await h.observe(phase);
    assert.equal(done.ok,true);assert.equal(done.data.phase,'removed');
    assert.equal(h.closes.length,1);assert.equal(h.closes[0].tabId,run.tabId);
    const atClose=h.closes[0].stored;
    assert.equal(atClose.manualUnfollow.phase,'removed');
    assert.equal(atClose.manualUnfollow.runId,run.runId);
    assert.equal(atClose.manualUnfollowUndo.runId,run.runId);
    assert.equal(atClose.manualUnfollowUndo.record.key,h.original.key);
    assert.equal(atClose.reviewData.records.some(record=>record.key===h.original.key),false);
    assert.equal(atClose.reviewData.records.length,1);
    // tabs.remove delivers onRemoved before resolving in this fixture; that
    // lifecycle event must leave the successful result and undo intact.
    assert.equal(h.stored.manualUnfollow.phase,'removed');
    assert.equal(h.stored.manualUnfollowUndo.runId,run.runId);
    assert.equal((await h.send({type:'UNFOLLOW_STATUS'})).data.canUndo,true);
    assert.equal((await h.send({type:'UNFOLLOW_UNDO'})).data.restored,1);
    assert.equal(hasTarget(h),true);
    await h.observe(phase);
    assert.equal(h.closes.length,1);
  });

  test(phase+' completion does not close twice when a duplicate message arrives',{timeout:2000},async()=>{
    const h=harness();await h.begin();
    if(phase==='confirmed')await h.observe('following');
    await h.observe(phase);await h.observe(phase);
    assert.equal(h.closes.length,1);
    assert.equal(h.stored.manualUnfollow.phase,'removed');
    assert.equal(hasTarget(h),false);
  });

  test('a rejected tab close preserves the successful '+phase+' removal and undo',{timeout:2000},async()=>{
    const h=harness();await h.begin();h.failClose();
    if(phase==='confirmed')await h.observe('following');
    const done=await h.observe(phase);
    assert.equal(done.ok,true);assert.equal(done.data.phase,'removed');
    assert.equal(h.closes.length,1);assert.equal(hasTarget(h),false);
    assert.equal(h.stored.manualUnfollow.phase,'removed');
    assert.equal(h.stored.manualUnfollowUndo.record.key,h.original.key);
    assert.equal((await h.send({type:'UNFOLLOW_STATUS'})).data.canUndo,true);
    await h.observe(phase);
    assert.equal(h.closes.length,1);
  });
}

for(const outcome of ['armed','cancelled','retained','failed storage','invalid evidence']){
  test(outcome+' leaves the native popup open',{timeout:2000},async()=>{
    const h=harness();await h.begin();await h.observe('following');
    if(outcome==='cancelled'){
      await h.send({type:'UNFOLLOW_CANCEL'});await h.observe('confirmed');
    }else if(outcome==='retained'){
      await h.send({type:'STATUS',key:h.original.key,status:'keep'});
      assert.equal((await h.observe('confirmed')).data.phase,'retained');
    }else if(outcome==='failed storage'){
      h.failRemoval();assert.equal((await h.observe('confirmed')).data.phase,'failed');
    }else if(outcome==='invalid evidence'){
      h.mutateProof(()=>{h.proof().trustedAction=false;});
      assert.equal((await h.observe('confirmed')).ok,false);
    }
    assert.equal(h.closes.length,0);assert.equal(hasTarget(h),true);
  });
}

for(const [name,change] of [
  ['moved to a different window',{windowId:99}],
  ['navigated to a different profile',{url:'https://x.com/other'}],
  ['navigated to another route on the same profile',{url:'https://x.com/target/following'}],
  ['started a pending navigation',{pendingUrl:'https://x.com/other'}],
  ['started loading',{status:'loading'}]
]){
  test('a popup '+name+' after removal is kept open',{timeout:2000},async()=>{
    const h=harness();const run=await h.begin();await h.observe('following');
    h.beforeCloseCheck(()=>Object.assign(h.tab,change));
    const done=await h.observe('confirmed');
    assert.equal(done.ok,true);assert.equal(done.data.phase,'removed');
    assert.equal(h.closes.length,0);assert.equal(hasTarget(h),false);
    assert.equal(h.stored.manualUnfollowUndo.runId,run.runId);
  });
}

test('a tab already closed after storage success does not turn removal into failure',{timeout:2000},async()=>{
  const h=harness();await h.begin();await h.observe('following');
  h.beforeCloseCheck(()=>h.exists(false));
  const done=await h.observe('confirmed');
  assert.equal(done.ok,true);assert.equal(done.data.phase,'removed');
  assert.equal(h.closes.length,0);assert.equal(hasTarget(h),false);
  assert.equal(h.stored.manualUnfollow.phase,'removed');
  assert.equal(h.stored.manualUnfollowUndo.record.key,h.original.key);
});

test('undo during the asynchronous close check keeps the restored record and window',{timeout:2000},async()=>{
  const h=harness();await h.begin();await h.observe('following');
  let restored;
  h.beforeCloseCheck(async()=>{restored=await h.send({type:'UNFOLLOW_UNDO'});});
  const done=await h.observe('confirmed');
  assert.equal(done.ok,true);assert.equal(restored.data.restored,1);
  assert.equal(h.closes.length,0);assert.equal(hasTarget(h),true);
  assert.equal(h.stored.manualUnfollow.phase,'retained');
  assert.equal(h.stored.manualUnfollowUndo,null);
});

test('a new session begun during the close check cannot have its tab closed by the completed session',{timeout:2000},async()=>{
  const h=harness();const previous=await h.begin();await h.observe('following');
  let next;
  h.beforeCloseCheck(async()=>{
    h.tab.url='https://x.com/other';
    const other=h.stored.reviewData.records.find(record=>record.handle==='other');
    next=await h.send({type:'UNFOLLOW_BEGIN',key:other.key});
  });
  const done=await h.observe('confirmed');
  assert.equal(done.ok,true);assert.equal(next.ok,true);
  assert.notEqual(next.data.runId,previous.runId);
  assert.equal(h.stored.manualUnfollow.runId,next.data.runId);
  assert.equal(h.stored.manualUnfollow.phase,'watching');
  assert.equal(h.closes.length,0);assert.equal(hasTarget(h),false);
  assert.equal(h.stored.manualUnfollowUndo.runId,previous.runId);
});

test('overlapping successful completion handlers close the popup only once',{timeout:2000},async()=>{
  const h=harness();await h.begin();await h.observe('following');
  const replies=await Promise.all([h.observe('confirmed'),h.observe('confirmed')]);
  assert.equal(replies.every(reply=>reply.ok && reply.data.phase==='removed'),true);
  assert.equal(h.closes.length,1);assert.equal(hasTarget(h),false);
  assert.equal(h.stored.manualUnfollow.phase,'removed');
  assert.equal(h.stored.manualUnfollowUndo.record.key,h.original.key);
});


for(const stableFor of [499,500]){
  test('trusted manual evidence at '+stableFor+' milliseconds '+(stableFor===500?'can commit':'must retain')+' the local record',{timeout:2000},async()=>{
    const h=harness();await h.begin();await h.observe('following');
    h.mutateProof(()=>{h.proof().stableFor=stableFor;});
    const done=await h.observe('confirmed');
    assert.equal(done.ok,stableFor===500);
    assert.equal(hasTarget(h),stableFor!==500);
    assert.equal(h.closes.length,stableFor===500?1:0);
    if(stableFor===500){
      assert.equal(done.data.phase,'removed');
      assert.equal(h.stored.manualUnfollowUndo.record.key,h.original.key);
    }else assert.equal(h.stored.manualUnfollowUndo,undefined);
  });
}

test('500-millisecond manual evidence is probed again and rejected if X has returned to Following',{timeout:2000},async()=>{
  const h=harness();await h.begin();await h.observe('following');
  let reads=0;
  h.mutateProof(()=>{
    h.proof().stableFor=500;
    if(++reads===2)Object.assign(h.proof(),{state:'following',stableFor:0});
  });
  assert.equal((await h.observe('confirmed')).ok,false);
  assert.equal(reads,2);assert.equal(hasTarget(h),true);
  assert.equal(h.closes.length,0);assert.equal(h.stored.manualUnfollowUndo,undefined);
});

for(const stableFor of [500,1999,2000]){
  test('initial reconciliation at '+stableFor+' milliseconds retains its separate two-second requirement',{timeout:2000},async()=>{
    const h=harness();await h.begin();
    h.mutateProof(()=>{h.proof().stableFor=stableFor;});
    const done=await h.observe('reconcile');
    assert.equal(done.ok,stableFor===2000);
    assert.equal(hasTarget(h),stableFor!==2000);
    assert.equal(h.closes.length,stableFor===2000?1:0);
  });
}
