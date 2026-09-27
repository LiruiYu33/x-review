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
  let queue = Promise.resolve(), proof = null, permitted = true, exists = true, failRemoval = false, probeReads = 0, probeHook;
  const writes = [], windows = [], events = {};
  const tab = {id:11,windowId:22,url:'https://x.com/target',status:'loading'};
  const chrome = {
    runtime:{id:'test',getURL:file=>'chrome-extension://test/'+file,onMessage:{addListener:fn=>events.message=fn},onStartup:{addListener:fn=>events.startup=fn}},
    storage:{local:{get:async key=>({[key]:structuredClone(stored[key])}),set:async values=>{if(failRemoval && values.manualUnfollow?.phase==='removed') throw Error('disk full'); writes.push(structuredClone(values));Object.assign(stored,structuredClone(values));},remove:async key=>delete stored[key]}},
    permissions:{contains:async()=>permitted},
    windows:{create:async options=>{windows.push(options);return{id:22,tabs:[{...tab}]};},update:async()=>({id:22})},
    tabs:{get:async()=>{if(!exists)throw Error('closed');return {...tab};},query:async()=>[{...tab}],onRemoved:{addListener:fn=>events.removed=fn},onUpdated:{addListener:fn=>events.updated=fn}},
    scripting:{executeScript:async options=>{if(options.files)return [];if(options.target.documentIds){probeReads++;if(probeHook)probeHook(probeReads);return[{documentId:options.target.documentIds[0],result:structuredClone(proof)}];}return[{result:null}];}}
  };
  const context=vm.createContext({chrome,URL,Date,console,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout});
  context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context));
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../background.js'),'utf8'),context);
  const sender={id:'test',url:'chrome-extension://test/index.html',tab:{id:1}};
  const page={id:'test',tab:{id:11},frameId:0,documentId:'doc-1',url:'https://x.com/target'};
  const send=(message,from=sender)=>new Promise(resolve=>events.message(message,from,resolve));
  const begin=async()=>{const result=await send({type:'UNFOLLOW_BEGIN',key:original.key});assert(result.ok,result.error);tab.status='complete';return result.data;};
  async function observe(phase,extra={},from=page){
    const identity={runId:stored.manualUnfollow.runId,handle:'target',id:original.id||'123',viewer:'owner',...extra};
    proof={...identity,state:phase==='following'?'following':'follow',trustedAction:phase==='confirmed',stableFor:2500};
    return send({type:'UNFOLLOW_OBSERVED',phase,...identity},from);
  }
  return {stored,writes,windows,tab,events,page,sender,original,send,begin,observe,
    permission:value=>permitted=value,exists:value=>exists=value,failRemoval:()=>failRemoval=true,
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
