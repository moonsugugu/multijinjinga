import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source=fs.readFileSync(new URL('./postgres-adapter.v1.js',import.meta.url),'utf8');
const turn=()=>new Promise(resolve=>setTimeout(resolve,5));
function fixture(fetcher) {
  const sockets=[], requests=[], delays=[];
  class Socket {
    constructor(url){this.url=url;this.readyState=0;sockets.push(this);}
    open(){this.readyState=1;return this.onopen?.();}
    emit(msg){this.onmessage?.({data:JSON.stringify(msg)});}
    close(){this.readyState=3;queueMicrotask(()=>this.onclose?.());}
  }
  const timers=new Set();
  const context={window:{},location:{hostname:'127.0.0.1'},crypto:webcrypto,AbortController,console:{log(){},error(){}},WebSocket:Socket,
    setTimeout(fn,delay){delays.push(delay);const timer=setTimeout(fn,Math.min(delay,2));timers.add(timer);return timer;},
    clearTimeout(timer){clearTimeout(timer);timers.delete(timer);},
    fetch:async(url,options={})=>{
      requests.push({url,...options});
      if(fetcher) return fetcher(url,options,requests);
      return response({state:'writing',players:{},problems:{},votes:{}});
    }};
  vm.runInNewContext(source,context);
  return {db:context.window.firebase.database(),sockets,requests,delays,cleanup(){for(const timer of timers)clearTimeout(timer);}};
}
const response=(value,status=200)=>({status,ok:status>=200&&status<300,json:async()=>structuredClone(value),text:async()=>''});

test('parallel child reads share one room snapshot and preserve room isolation',async()=>{
  const f=fixture();
  const room=f.db.ref('rooms/JJG_AAAA');
  await Promise.all(Array.from({length:25},()=>room.child('players').get()));
  assert.equal(f.requests.length,1);
  await f.db.ref('rooms/JJG_BBBB/state').get();
  assert.equal(f.requests.length,2);f.cleanup();
});
test('overlapping vote subscriptions receive each event once, without cross-room notifications',async()=>{
  const f=fixture();let parent=0,child=0,other=0;
  const r=f.db.ref('rooms/JJG_AAAA');const a=()=>parent++,b=()=>child++,c=()=>other++;
  r.child('votes').on('value',a);r.child('votes/owner').on('value',b);
  f.db.ref('rooms/JJG_BBBB/votes').on('value',c);
  await f.sockets[0].open();await f.sockets[1].open();parent=child=other=0;
  f.sockets[0].emit({type:'vote',action:'upsert',record:{ownerPid:'owner',voterPid:'voter',choice:2}});
  assert.equal(parent,1);assert.equal(child,1);assert.equal(other,0);f.cleanup();
});
test('events arriving during reload are replayed over the snapshot',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>resolve=r));let latest;
  const r=f.db.ref('rooms/JJG_AAAA/players');const cb=s=>latest=s.val();r.on('value',cb);
  const opening=f.sockets[0].open();
  f.sockets[0].emit({type:'player',action:'upsert',record:{pid:'one',name:'가람'}});
  resolve(response({state:'writing',players:{},problems:{},votes:{}}));await opening;
  assert.equal(latest.one.name,'가람');r.off('value',cb);f.cleanup();
});
test('unsubscribe during initial load prevents late callbacks and reconnect',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>resolve=r));let calls=0;
  const r=f.db.ref('rooms/JJG_AAAA/state');const cb=()=>calls++;r.on('value',cb);
  const opening=f.sockets[0].open();r.off('value',cb);
  resolve(response({state:'writing',players:{},problems:{},votes:{}}));await opening;await turn();
  assert.equal(calls,0);assert.equal(f.sockets.length,1);f.cleanup();
});
test('old socket close cannot replace a new room connection; disconnect reconnects',async()=>{
  const f=fixture();const r=f.db.ref('rooms/JJG_AAAA/state');const cb=()=>{};
  r.on('value',cb);await f.sockets[0].open();r.off('value',cb);r.on('value',cb);
  await turn();assert.equal(f.sockets.length,2);await f.sockets[1].open();
  f.sockets[1].close();await turn();assert.equal(f.sockets.length,3);r.off('value',cb);f.cleanup();
});
test('room deletion followed by a child deletion cannot crash',async()=>{
  const f=fixture();const r=f.db.ref('rooms/JJG_AAAA/state');const cb=()=>{};r.on('value',cb);await f.sockets[0].open();
  f.sockets[0].emit({type:'room',action:'delete'});
  assert.doesNotThrow(()=>f.sockets[0].emit({type:'player',action:'delete',record:{pid:'one'}}));r.off('value',cb);f.cleanup();
});
test('25 concurrent writes use distinct rows and preserve each requestId across retries',async()=>{
  const ids=new Set(),rows=new Map(),attempts=new Map();let mutations=0;
  const f=fixture((url,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.requestId,options.headers['X-Request-Id']);
    attempts.set(body.requestId,(attempts.get(body.requestId)||0)+1);
    if(!ids.has(body.requestId)){ids.add(body.requestId);rows.set(url,body);mutations++;return response(null,503);}
    return response(body);
  });
  await Promise.all(Array.from({length:25},(_,i)=>f.db.ref(`rooms/JJG_AAAA/problems/p${i}`).set({items:[String(i)]})));
  assert.equal(rows.size,25);assert.equal(mutations,25);assert.equal(ids.size,25);
  assert.ok([...attempts.values()].every(n=>n===2));f.cleanup();
});
for(const status of [409,503,'offline','timeout'])test(`bounded retries for ${status}`,async()=>{
  const f=fixture((_url,options)=>{
    if(status==='offline')throw new TypeError('offline');
    if(status==='timeout')return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('timeout'))));
    return response(null,status);
  });
  await assert.rejects(f.db.ref('rooms/JJG_AAAA/votes/owner/voter').set(1));
  assert.equal(f.requests.length,4);
  assert.equal(new Set(f.requests.map(r=>r.headers['X-Request-Id'])).size,1);f.cleanup();
});
test('production inline scripts are syntactically valid',()=>{
  const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))if(!match[1].includes('src='))new vm.Script(match[2]);
});
