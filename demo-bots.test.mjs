import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('./demo-bots.js',import.meta.url),'utf8');
const bank=JSON.parse(await readFile(new URL('./demo-bank.json',import.meta.url),'utf8'));
const context={window:{},setTimeout};vm.runInNewContext(source,context);
const api=context.window.JJGDemo;
function fixture() {
  let nextId=0;
  const state={role:'teacher',code:'ROOM1',room:{state:'writing',topic:'원래 주제',players:{},problems:{},votes:{},settings:{autoOn:true}},ref:null};
  const writes=[];
  function ref(path='') {
    const parts=path.split('/').filter(Boolean);
    function parent(){let node=state.room;for(const p of parts.slice(0,-1))node=node[p]??={};return node;}
    return {key:parts.at(-1),child:p=>ref(path?path+'/'+p:p),push:()=>ref(path+'/bot-'+(++nextId)),
      async set(value){writes.push({code:state.code,path,value});parent()[parts.at(-1)]=structuredClone(value);},
      async update(value){writes.push({code:state.code,path,value});const node=parts.length?(parent()[parts.at(-1)]??={}):state.room;Object.assign(node,structuredClone(value));},
      async remove(){writes.push({code:state.code,path,remove:true});delete parent()[parts.at(-1)];}};
  }
  state.ref=ref();
  const controller=api.createController({getContext:()=>state,loadBank:async()=>bank,sleep:async()=>{}});
  return {state,writes,controller};
}
test('3 demo themes contain 100 unique five-statement profiles each',()=>{
  assert.equal(bank.length,3);
  for(const topic of bank) {
    assert.equal(topic.profiles.length,100);
    assert.equal(new Set(topic.profiles.map(p=>JSON.stringify(p))).size,100);
    for(const profile of topic.profiles){assert.equal(profile.truths.length,5);assert.equal(profile.fakes.length,5);}
  }
});
test('incremental creation reaches 50, submits real problems and writes per-student rows',async()=>{
  const f=fixture();
  await f.controller.add('food',1);await f.controller.add('food',5);await f.controller.add('food',50);
  assert.equal(Object.keys(f.state.room.players).length,50);
  assert.equal(Object.keys(f.state.room.problems).length,50);
  assert.equal(new Set(Object.values(f.state.room.players).map(p=>p.name)).size,50);
  assert.ok(Object.values(f.state.room.players).every(p=>p.submitted));
  assert.equal(f.state.room.settings.demoBotIds.length,50);
  assert.ok(f.writes.filter(w=>w.path.startsWith('problems/')).length>=50);
  await assert.rejects(f.controller.add('food',1));
  await assert.rejects(f.controller.add('unknown',1));
});
test('bots vote once per question, exclude their own presentation, and accuracy changes choices',async()=>{
  const f=fixture();await f.controller.add('sport',25);
  const owner=Object.keys(f.state.room.players)[0];
  f.state.room.state='presenting';f.state.room.present={order:[owner],idx:0,revealed:false};
  for(let i=0;i<40;i++)await f.controller.tick();
  assert.equal(Object.keys(f.state.room.votes[owner]).length,24);
  assert.equal(f.state.room.votes[owner][owner],undefined);
  assert.ok(Object.values(f.state.room.votes[owner]).every(v=>Number.isInteger(v)&&v>=0&&v<=4));
  const before=f.writes.length;await f.controller.tick();assert.equal(f.writes.length,before);
  assert.equal(api.chooseVote(2,1,()=>.5),2);
  assert.notEqual(api.chooseVote(2,0,()=>.5),2);
});
test('50-bot presentation accuracy changes gradually between consecutive questions',async()=>{
  const f=fixture();await f.controller.add('food',50);await f.controller.tick();
  const owners=Object.keys(f.state.room.players);
  f.state.room.state='presenting';f.state.room.present={order:owners,idx:0,revealed:false};
  const rates=[];
  for(let index=0;index<5;index++) {
    f.state.room.present.idx=index;
    for(let i=0;i<55;i++)await f.controller.tick();
    const owner=owners[index],fake=f.state.room.problems[owner].fakeIndex;
    const votes=Object.values(f.state.room.votes[owner]);
    assert.equal(votes.length,49);
    rates.push(votes.filter(v=>v===fake).length/49);
  }
  for(let i=1;i<rates.length;i++)assert.ok(rates[i]>rates[i-1]&&rates[i]-rates[i-1]<.12);
});
test('pause, teacher leave and refresh do not generate repeated or cross-room writes',async()=>{
  const f=fixture();await f.controller.add('animal',5);
  const owner=Object.keys(f.state.room.players)[0];
  f.state.room.state='presenting';f.state.room.present={order:[owner],idx:0,revealed:false};
  f.controller.pause();const before=f.writes.length;await f.controller.tick();assert.equal(f.writes.length,before);
  f.controller.pause();for(let i=0;i<8;i++)await f.controller.tick();
  const refreshed=api.createController({getContext:()=>f.state,loadBank:async()=>bank,sleep:async()=>{}});
  const after=f.writes.length;await refreshed.tick();assert.equal(f.writes.length,after);
  refreshed.stop();f.state.code='OTHER';await refreshed.tick();assert.equal(f.writes.length,after);
});
test('double-click during bank loading is rejected and leaving cancels creation',async()=>{
  const f=fixture();let resolveBank;
  const controller=api.createController({getContext:()=>f.state,loadBank:()=>new Promise(r=>resolveBank=r),sleep:async()=>{}});
  const first=controller.add('food',50);
  await assert.rejects(controller.add('food',50));
  controller.stop();f.state.code='OTHER';resolveBank(bank);
  await assert.rejects(first);assert.equal(f.writes.length,0);
});
test('clearing affects only bots and future ordinary teaching remains available',async()=>{
  const f=fixture();await f.controller.add('food',5);
  f.state.room.players.human={name:'학생',submitted:false};
  await f.controller.clear();
  assert.deepEqual(Object.keys(f.state.room.players),['human']);
  assert.equal(f.state.room.settings.demoTopic,undefined);
  assert.equal(Object.keys(f.state.room.problems).length,0);
  assert.equal(f.state.room.settings.autoOn,true);
});
