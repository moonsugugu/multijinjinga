import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
const source=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(m=>!m[1].includes('src=')).map(m=>m[2]).join('\n').replace(/\nboot\(\);\s*$/, '');
function fixture(){
  let now=10000,seq=0,fail=false,echo=true;
  const timers=new Map(),writes=[],elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',style:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){},removeAttribute(){}});
    return elements.get(id);
  };
  const context={console,Date:class extends Date{static now(){return now;}},
    document:{getElementById:element},JJGDemo:{createController:()=>({start(){},stop(){}})},
    setTimeout(fn,ms){timers.set(++seq,{fn,at:now+ms});return seq;},clearTimeout(id){timers.delete(id);}};
  vm.runInNewContext(source+`\n globalThis.api={S,autoNextOf,setAutoNext,autoNextTick,nextProblem,prevProblem,syncFx,renderAutoNextProgress,
    setDb(value){db=value;},quiet(){SFX.init=()=>false;SFX.tick=()=>{};BGM.play=()=>{};BGM.stop=()=>{};}};`,context);
  const api=context.api;api.quiet();
  api.S.role='teacher';api.S.code='ROOM1';
  api.S.room={state:'presenting',settings:{autoOn:true,limitSec:20,nextOn:true,nextSec:5},
    present:{order:['one','two'],idx:0,revealed:false,countdown:null,deadline:null,nextAt:null}};
  function ref(path=''){
    return {child:p=>ref(path+'/'+p),async update(patch){
      writes.push({code:api.S.code,path,patch:structuredClone(patch)});
      if(fail)throw Error('offline');
      if(!echo)return;
      for(const [key,value]of Object.entries(patch)){
        const parts=key.split('/');let target=api.S.room;
        for(const part of parts.slice(0,-1))target=target[part]??={};
        target[parts.at(-1)]=structuredClone(value);
      }
    }};
  }
  api.setDb({ref});
  return {api,writes,elements,get now(){return now;},set now(value){now=value;},set fail(value){fail=value;},set echo(value){echo=value;},
    async advance(ms){now+=ms;for(const [id,t]of [...timers])if(t.at<=now){timers.delete(id);await t.fn();}}};
}

test('old rooms keep manual next; durations are bounded to 5–10 seconds',()=>{
  const f=fixture();f.api.S.room.settings={};assert.equal(f.api.autoNextOf().on,false);assert.equal(f.api.autoNextOf().sec,5);
  for(const [input,expected]of [[-1,5],[99,10],['bad',5],[7,7]]){f.api.S.room.settings.nextSec=input;assert.equal(f.api.autoNextOf().sec,expected);}
});

for(const seconds of [5,6,7,8,9,10])test(`advance exactly ${seconds}s after answer reveal, never during the reveal countdown`,async()=>{
  const f=fixture(),{api}=f;api.S.room.settings.nextSec=seconds;
  api.S.room.present.countdown=123;
  api.syncFx(api.S.room.present,'one',{items:['a','b','c','d','e']});
  await f.advance(2399);await api.autoNextTick();assert.equal(f.writes.length,0);
  await f.advance(1);assert.equal(api.S.room.present.revealed,true);
  assert.equal(api.S.room.present.nextAt,f.now+seconds*1000);
  await f.advance(seconds*1000-1);await api.autoNextTick();assert.equal(api.S.room.present.idx,0);
  await f.advance(1);await Promise.all([api.autoNextTick(),api.autoNextTick()]);
  assert.equal(api.S.room.present.idx,1);assert.equal(api.S.room.present.nextAt,null);assert.equal(api.S.room.present.revealed,false);
  assert.equal(f.writes.filter(w=>w.patch['present/idx']===1).length,1);
});

test('settings preserve demo and answer timer; pausing cancels the deadline and resuming restarts it',async()=>{
  const f=fixture(),{api}=f;Object.assign(api.S.room.settings,{demoBotIds:['bot'],demoTopic:'food'});
  api.S.room.present.revealed=true;
  await api.setAutoNext(true,10);assert.equal(api.S.room.present.nextAt,f.now+10000);
  await api.setAutoNext(false,10);assert.equal(api.S.room.present.nextAt,null);
  await f.advance(20000);await api.autoNextTick();assert.equal(api.S.room.present.idx,0);
  await api.setAutoNext(true,6);assert.equal(api.S.room.present.nextAt,f.now+6000);
  assert.equal(api.S.room.settings.limitSec,20);assert.equal(api.S.room.settings.autoOn,true);
  assert.equal(api.S.room.settings.demoBotIds[0],'bot');
});

test('students and non-presentation screens never advance; busy manual actions cannot race the timer',async()=>{
  const f=fixture(),{api}=f;Object.assign(api.S.room.present,{revealed:true,nextAt:1});
  api.S.role='student';await api.autoNextTick();await api.nextProblem();await api.setAutoNext(true,5);
  api.S.role='teacher';api.S.room.state='writing';await api.autoNextTick();
  api.S.room.state='presenting';api.S.teacherBusy=true;await api.autoNextTick();
  assert.equal(f.writes.length,0);
  api.S.teacherBusy=false;await Promise.all([api.nextProblem(),api.autoNextTick()]);assert.equal(f.writes.length,1);
});

test('pause takes effect after HTTP success even before its WebSocket notification',async()=>{
  const f=fixture(),{api}=f;Object.assign(api.S.room.present,{revealed:true,nextAt:1});
  f.echo=false;await api.setAutoNext(false,5);await api.autoNextTick();
  assert.equal(api.S.room.settings.nextOn,false);assert.equal(api.S.room.present.nextAt,null);assert.equal(f.writes.length,1);
});

test('the last problem automatically opens results once; manual back resets the previous deadline',async()=>{
  const f=fixture(),{api}=f;Object.assign(api.S.room.present,{idx:1,revealed:true,nextAt:1});
  await api.prevProblem();assert.equal(api.S.room.present.idx,0);assert.equal(api.S.room.present.nextAt,null);
  Object.assign(api.S.room.present,{idx:1,revealed:true,nextAt:1});
  await api.autoNextTick();await api.autoNextTick();assert.equal(api.S.room.state,'done');
  assert.equal(f.writes.filter(w=>w.patch.state==='done').length,1);
});

test('failed automatic writes stop retrying this question and allow a manual next',async()=>{
  const f=fixture(),{api}=f;Object.assign(api.S.room.present,{revealed:true,nextAt:1});
  f.fail=true;await api.autoNextTick();
  for(let i=0;i<20;i++)await api.autoNextTick();assert.equal(f.writes.length,1);
  api.renderAutoNextProgress();assert.match(f.elements.get('tp-an-status').textContent,/다음 버튼/);
  f.fail=false;await api.nextProblem();assert.equal(api.S.room.present.idx,1);
});

test('reload honors the persisted deadline, and leaving or changing questions cancels stale reveal callbacks',async()=>{
  const f=fixture(),{api}=f;Object.assign(api.S.room.present,{revealed:true,nextAt:f.now+3000});
  await f.advance(2999);await api.autoNextTick();assert.equal(f.writes.length,0);
  await f.advance(1);await api.autoNextTick();assert.equal(api.S.room.present.idx,1);
  api.S.room.present.countdown=123;api.syncFx(api.S.room.present,'two',{items:['a','b','c','d','e']});
  api.S.code='OTHER';await f.advance(2400);assert.equal(f.writes.length,1);
});
