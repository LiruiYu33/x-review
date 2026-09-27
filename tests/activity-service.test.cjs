'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const DAY=86400000;
function harness({records=[{handle:'target'}],thresholdDays=180}={}){
  const epoch=Date.parse('2026-09-27T12:00:00Z');
  let now=epoch,timerId=0,queue=Promise.resolve(),permitted=true,validContext=true;
  let probeHook,executionFailures=0,injectionFailures=0,navigationStatus='complete',resolveURL=url=>url,documentId='doc-1';
  const timers=new Map(),writes=[],navigations=[],injections=[],probes=[];
  const clone=value=>structuredClone(value);
  class Clock extends Date{
    constructor(...args){super(...(args.length?args:[now]));}
    static now(){return now;}
  }
  const context=vm.createContext({URL,Date:Clock,console,crypto:require('node:crypto').webcrypto,
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,at:now+delay});return id;},
    clearTimeout:id=>timers.delete(id)});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../core.js'),'utf8'),context);
  const core=context.XReviewCore;
  const stored={reviewData:{schemaVersion:1,thresholdDays,records:records.map(record=>clone(core.normaliseRecord(record)))}};
  const tabs=new Map([[1,{id:1,url:'chrome-extension://fixture/activity.html',status:'complete'}]]);
  const page=vm.createContext({});
  const sender={id:'fixture',url:'chrome-extension://fixture/activity.html',tab:{id:1}};
  function ready({days=1,handle,id,evidence={}}={}){
    const profile=handle||new URL(tabs.get(2)?.url||'https://x.com/target').pathname.slice(1);
    return {state:'ready',reason:'Public profile sample observed.',snapshot:{kind:'profile',record:{handle:profile,...(id?{id}:{}),
      name:'Fictional '+profile,evidence:{observedAt:new Clock().toISOString(),latestPostAt:new Clock(epoch-days*DAY).toISOString(),
        sampleCount:3,scope:'profile-posts',profileAtTop:true,hasUncertainReposts:false,...evidence}}}};
  }
  const chrome={
    runtime:{id:'fixture',getURL:file=>'chrome-extension://fixture/'+file,
      getContexts:async()=>validContext?[{tabId:1,documentUrl:sender.url}]:[]},
    permissions:{contains:async()=>permitted},
    storage:{local:{get:async key=>({[key]:clone(stored[key])}),set:async values=>{writes.push({at:now-epoch,values:clone(values)});Object.assign(stored,clone(values));}}},
    tabs:{get:async id=>{if(!tabs.has(id))throw Error('Tab closed');return clone(tabs.get(id));},
      create:async options=>{const tab={id:2,url:options.url,status:'complete'};tabs.set(2,tab);return clone(tab);},
      update:async(id,options)=>{
        navigations.push({id,at:now-epoch,...options});
        const tab={id,url:resolveURL(options.url),status:navigationStatus};tabs.set(id,tab);
        delete page.XReviewProfileProbe;delete page.XReviewReadPage;
        return clone(tab);
      }},
    scripting:{executeScript:async options=>{
      if(options.files){
        injections.push({at:now-epoch,files:[...options.files],tabId:options.target.tabId});
        if(injectionFailures>0){injectionFailures--;throw Error('Document changed during injection');}
        page.XReviewReadPage=()=>{};
        page.XReviewProfileProbe=()=>{
          probes.push({at:now-epoch,tabId:options.target.tabId});
          if(executionFailures>0){executionFailures--;throw Error('Probe context lost');}
          return clone(probeHook?probeHook(now-epoch,probes.length):ready());
        };
        return [];
      }
      page.fixtureArgs=clone(options.args||[]);
      const result=await vm.runInContext('('+options.func.toString()+')(...fixtureArgs)',page);
      return [{result:clone(result),documentId}];
    }}
  };
  context.chrome=chrome;
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../activity-service.js'),'utf8'),context);
  const enqueue=task=>{const operation=queue.then(task);queue=operation.catch(()=>{});return operation;};
  const service=context.createActivityService({core,enqueue,load:async()=>clone(stored.reviewData),
    getFollowingScan:async()=>null,reconcileFollowingScan:async()=>{},manualUnfollowBusy:async()=>false});
  const flush=async()=>{for(let count=0;count<200;count++)await Promise.resolve();};
  const send=message=>service.handle(message,sender);
  return {stored,writes,navigations,injections,probes,tabs,ready,send,service,flush,
    now:()=>now-epoch,core,
    setProbe:fn=>probeHook=fn,permission:value=>permitted=value,controller:value=>validContext=value,
    failExecution:count=>executionFailures=count,failInjection:count=>injectionFailures=count,
    setNavigationStatus:value=>navigationStatus=value,resolveURL:fn=>resolveURL=fn,
    replaceDocument:(id,{dropGlobals=false}={})=>{
      documentId=id;
      if(dropGlobals){delete page.XReviewProfileProbe;delete page.XReviewReadPage;}
    },
    saves:()=>writes.filter(write=>write.values.reviewData),
    async begin(){return send({type:'ACT_BEGIN',mode:'all',limit:records.length});},
    next(){
      const task={done:false,value:null,error:null};
      task.promise=send({type:'ACT_NEXT',runId:stored.activityRun.runId}).then(value=>{task.done=true;task.value=value;return value;},error=>{task.done=true;task.error=error;throw error;});
      return task;
    },
    async advance(milliseconds){
      await flush();const end=now+milliseconds;
      while(true){
        const due=[...timers.entries()].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!due)break;
        now=due[1].at;timers.delete(due[0]);due[1].callback();await flush();
      }
      now=end;await flush();
    }
  };
}

async function started(options){const h=harness(options);await h.begin();const task=h.next();await h.flush();return {h,task};}
const bucket=h=>h.core.classify(h.stored.reviewData.records[0],h.stored.reviewData.thresholdDays).bucket;

test('stable recent evidence completes at two seconds with one script installation, never earlier',async()=>{
  const {h,task}=await started();await h.advance(1999);
  assert.equal(task.done,false);assert.equal(h.saves().length,0);
  await h.advance(1);assert.equal(task.done,true);assert.equal(task.value.completed,1);
  assert.equal(task.value.read,1);assert.equal(bucket(h),'recent');
  assert.equal(h.saves()[0].at,2000);assert.equal(h.injections.length,1);
  assert.deepEqual(h.probes.map(probe=>probe.at),[0,500,1000,1500,2000]);
});

test('positive recent evidence can finish quickly even when other repost dates are uncertain',async()=>{
  const h=harness();h.setProbe(()=>h.ready({evidence:{sampleCount:1,hasUncertainReposts:true}}));
  await h.begin();const task=h.next();await h.advance(2000);
  assert.equal(task.done,true);assert.equal(bucket(h),'recent');assert.equal(h.saves()[0].at,2000);
});

for(const [label,options] of [['old evidence',{days:300}],['custom threshold',{days:60,thresholdDays:30}]]){
  test(label+' keeps the five-second candidate observation window',async()=>{
    const h=harness({thresholdDays:options.thresholdDays||180});h.setProbe(()=>h.ready({days:options.days}));
    await h.begin();const task=h.next();await h.advance(4999);
    assert.equal(task.done,false);assert.equal(h.saves().length,0);
    await h.advance(1);assert.equal(task.done,true);assert.equal(bucket(h),'candidate');
    assert.equal(h.saves()[0].at,5000);assert.equal(h.injections.length,1);
  });
}

for(const [label,evidence] of [
  ['future timestamp',{latestPostAt:'2026-09-28T12:00:00Z'}],
  ['missing date',{latestPostAt:null}],
  ['old pinned-only sample',{sampleCount:0}],
  ['old uncertain repost sample',{hasUncertainReposts:true}]
]){
  test(label+' does not take the recent-evidence fast path',async()=>{
    const h=harness();h.setProbe(()=>h.ready({days:300,evidence}));
    await h.begin();const task=h.next();await h.advance(4999);
    assert.equal(task.done,false);assert.equal(h.saves().length,0);
    await h.advance(1);assert.equal(task.done,true);assert.equal(bucket(h),'unknown');
    assert.equal(task.value.unknown,1);assert.equal(h.saves()[0].at,5000);
  });
}

test('an unavailable profile remains unknown and waits five seconds',async()=>{
  const h=harness();h.setProbe(()=>({state:'unavailable',reason:'Protected profile.'}));
  await h.begin();const task=h.next();await h.advance(4999);assert.equal(task.done,false);
  await h.advance(1);assert.equal(task.done,true);assert.equal(bucket(h),'unknown');
  assert.equal(h.saves()[0].at,5000);assert.equal(h.injections.length,1);
});

for(const loading of ['tab','probe']){
  test('a persistently loading '+loading+' waits the full 25 seconds and saves only unknown evidence',async()=>{
    const h=harness();
    if(loading==='tab')h.setNavigationStatus('loading');
    else h.setProbe(()=>({state:'loading',reason:'Waiting for timeline.'}));
    await h.begin();const task=h.next();await h.advance(24999);
    assert.equal(task.done,false);assert.equal(h.saves().length,0);
    await h.advance(1);assert.equal(task.done,true);assert.equal(bucket(h),'unknown');
    assert.equal(h.saves()[0].at,25000);assert.equal(task.value.read,0);assert.equal(task.value.unknown,1);
    assert.equal(h.injections.length,loading==='tab'?0:1);
  });
}

test('a changed recent signature needs one full matching second before early completion',async()=>{
  const h=harness();h.setProbe(elapsed=>h.ready({days:elapsed<1500?2:1}));
  await h.begin();const task=h.next();await h.advance(2499);assert.equal(task.done,false);
  await h.advance(1);assert.equal(task.done,true);assert.equal(h.saves()[0].at,2500);
});

test('probe loading interrupts a matching recent signature and restarts the stability window',async()=>{
  const h=harness();h.setProbe(elapsed=>elapsed===1500?{state:'loading',reason:'Loading more posts.'}:h.ready());
  await h.begin();const task=h.next();await h.advance(2999);assert.equal(task.done,false);
  await h.advance(1);assert.equal(task.done,true);assert.equal(h.saves()[0].at,3000);
});

test('tab loading resets both recent evidence stability and the installed reader context',async()=>{
  const {h,task}=await started();await h.advance(1000);
  h.tabs.get(2).status='loading';await h.advance(500);
  h.tabs.get(2).status='complete';await h.advance(1499);assert.equal(task.done,false);
  await h.advance(1);assert.equal(task.done,true);assert.equal(h.saves()[0].at,3000);
  assert.equal(h.injections.length,2);
});

for(const failure of ['injection','execution']){
  test('a transient '+failure+' failure retries installation and still requires stable evidence',async()=>{
    const h=harness();if(failure==='injection')h.failInjection(1);else h.failExecution(1);
    await h.begin();const task=h.next();await h.advance(1999);assert.equal(task.done,false);
    await h.advance(1);assert.equal(task.done,true);assert.equal(bucket(h),'recent');
    assert.equal(h.injections.length,2);assert.equal(h.saves().length,1);
  });
}

test('a block or access error stops the round without saving partial recent evidence',async()=>{
  const h=harness();h.setProbe(elapsed=>elapsed>=1000?{state:'blocked',reason:'Rate limit.'}:h.ready());
  await h.begin();const task=h.next();await h.advance(1000);
  assert.equal(task.done,true);assert.equal(task.value.phase,'stopped');
  assert.equal(h.saves().length,0);assert.equal(h.stored.reviewData.records[0].evidence,undefined);
});

test('cancelling during a page wait wakes the operation and prevents late evidence writes',async()=>{
  const {h,task}=await started();await h.advance(1000);
  await h.send({type:'ACT_STOP',runId:h.stored.activityRun.runId});await h.flush();
  assert.equal(task.done,true);assert.equal(task.value.phase,'stopped');
  await h.advance(30000);assert.equal(h.saves().length,0);assert.equal(h.navigations.length,1);
});

test('concurrent ACT_NEXT requests share one profile visit and one evidence commit',async()=>{
  const h=harness();await h.begin();const first=h.next(),second=h.next();await h.advance(2000);
  assert.equal(first.done,true);assert.equal(second.done,true);
  assert.equal(first.value.completed,1);assert.equal(second.value.completed,1);
  assert.equal(h.navigations.length,1);assert.equal(h.saves().length,1);assert.equal(h.injections.length,1);
});

test('a captured handle conflicting with the target stops before any evidence is saved',async()=>{
  const h=harness();h.setProbe(()=>h.ready({handle:'another'}));await h.begin();const task=h.next();await h.flush();
  assert.equal(task.done,true);assert.equal(task.value.phase,'stopped');assert.equal(h.saves().length,0);
});

test('a captured numeric identity conflicting with the requested ID stops the round',async()=>{
  const h=harness({records:[{id:'123',handle:'target'}]});h.resolveURL(()=> 'https://x.com/target');
  h.setProbe(()=>h.ready({id:'999'}));await h.begin();const task=h.next();await h.flush();
  assert.equal(task.done,true);assert.equal(task.value.phase,'stopped');assert.equal(h.saves().length,0);
});

test('manual navigation during observation cannot save another profile under the original record',async()=>{
  const {h,task}=await started();await h.advance(1000);h.tabs.get(2).url='https://x.com/another';
  await h.advance(500);assert.equal(task.done,true);assert.equal(task.value.phase,'stopped');assert.equal(h.saves().length,0);
});

for(const invalidation of ['permission','controller']){
  test('revoking '+invalidation+' validity during a wait stops without saving',async()=>{
    const {h,task}=await started();await h.advance(1000);
    if(invalidation==='permission')h.permission(false);else h.controller(false);
    await h.advance(500);assert.equal(task.done,true);assert.equal(task.value.phase,'stopped');assert.equal(h.saves().length,0);
  });
}

test('the next profile installs a fresh reader while reusing the same dedicated tab',async()=>{
  const h=harness({records:[{handle:'target'},{handle:'another'}]});await h.begin();
  const first=h.next();await h.advance(2000);assert.equal(first.value.phase,'running');
  const second=h.next();await h.advance(2000);assert.equal(second.value.phase,'complete');
  assert.equal(second.value.completed,2);assert.equal(h.injections.length,2);assert.equal(h.saves().length,2);
  assert.deepEqual(h.navigations.map(visit=>visit.id),[2,2]);
  assert.deepEqual(h.navigations.map(visit=>visit.url),['https://x.com/target','https://x.com/another']);
});


test('a changed old signature needs the original 1.5 seconds of matching evidence',async()=>{
  const h=harness();h.setProbe(elapsed=>h.ready({days:elapsed<4500?400:300}));
  await h.begin();const task=h.next();await h.advance(5999);assert.equal(task.done,false);
  await h.advance(1);assert.equal(task.done,true);assert.equal(bucket(h),'candidate');
  assert.equal(h.saves()[0].at,6000);
});

test('a document replacement resets matching evidence even when the URL and installed probe are unchanged',async()=>{
  const {h,task}=await started();await h.advance(1000);h.replaceDocument('doc-2');
  await h.advance(1499);assert.equal(task.done,false);assert.equal(h.saves().length,0);
  await h.advance(1);assert.equal(task.done,true);assert.equal(h.saves()[0].at,2500);
});

test('a replacement document missing reader globals is reinstalled before collecting fresh stability',async()=>{
  const {h,task}=await started();await h.advance(1000);
  h.replaceDocument('doc-2',{dropGlobals:true});
  await h.advance(1999);assert.equal(task.done,false);assert.equal(h.saves().length,0);
  await h.advance(1);assert.equal(task.done,true);assert.equal(h.saves()[0].at,3000);
  assert.equal(h.injections.length,2);
});

for(const delayed of [false,true]){
  test('a threshold change invalidates recent-only evidence '+(delayed?'even after a delayed check passes five seconds':'before the early commit'),async()=>{
    const h=harness();h.setProbe(elapsed=>delayed && elapsed<5000?{state:'loading',reason:'Waiting.'}:h.ready({days:10}));
    await h.begin();const task=h.next();await h.advance(delayed?5500:1500);
    assert.equal(task.done,false);
    h.stored.reviewData.thresholdDays=5;
    await h.advance(500);
    assert.equal(task.done,true);assert.equal(task.value.phase,'stopped');
    assert.equal(task.value.index,0);assert.equal(task.value.completed,0);
    assert.equal(h.saves().length,0);assert.equal(h.stored.reviewData.records[0].evidence,undefined);
  });
}

test('a threshold edit that still classifies the observation as recent can complete',async()=>{
  const {h,task}=await started();await h.advance(1000);h.stored.reviewData.thresholdDays=90;
  await h.advance(1000);assert.equal(task.done,true);assert.equal(task.value.phase,'complete');
  assert.equal(bucket(h),'recent');assert.equal(h.saves().length,1);
});

test('multiple probes within one unchanged profile reuse the installed reader',async()=>{
  const {h,task}=await started();await h.advance(1500);
  assert.equal(task.done,false);assert.ok(h.probes.length>=2);
  assert.equal(h.injections.length,1);
  await h.send({type:'ACT_STOP',runId:h.stored.activityRun.runId});await h.flush();
  assert.equal(task.done,true);assert.equal(h.saves().length,0);
});
