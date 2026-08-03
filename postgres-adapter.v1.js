/* Firebase RTDB compatibility adapter for the Moonsune PostgreSQL backend. */
(function () {
  'use strict';

  const BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://127.0.0.1:3100'
    : 'https://api.moonsunezip.com';
  const TS = { '.sv': 'timestamp' };
  const isTS = (v) => v && typeof v === 'object' && v['.sv'] === 'timestamp';
  const resolveTS = (v) => isTS(v) ? Date.now() : v;
  const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));
  const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

  function pushKey() {
    let t = Date.now(), s = '';
    for (let i = 7; i >= 0; i--) { s = PUSH_CHARS[t % 64] + s; t = Math.floor(t / 64); }
    for (let i = 0; i < 12; i++) s += PUSH_CHARS[Math.floor(Math.random() * 64)];
    return s;
  }
  async function req(path, options) {
    const r = await fetch(BASE + path, options);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`API ${r.status}: ${await r.text().catch(() => '')}`);
    return r.status === 204 ? null : r.json();
  }
  const json = (method, value) => ({ method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(value) });
  const enc = encodeURIComponent;

  class RoomStore {
    constructor(code) {
      this.code = code;
      this.tree = null;
      this.listeners = new Map();
      this.ws = null;
      this.retry = 1000;
      this.closed = false;
    }
    async load() {
      this.tree = await req(`/v1/jinjinga/rooms/${enc(this.code)}`);
      return this.tree;
    }
    read(path) {
      if (!this.tree) return null;
      let cur = this.tree;
      for (const part of String(path || '').split('/').filter(Boolean)) {
        if (cur == null || typeof cur !== 'object') return null;
        cur = cur[part];
      }
      return cur === undefined ? null : cur;
    }
    on(path, callback) {
      if (!this.listeners.has(path)) this.listeners.set(path, new Set());
      this.listeners.get(path).add(callback);
      if (this.tree) callback(this.read(path));
      this.connect();
    }
    off(path, callback) {
      this.listeners.get(path)?.delete(callback);
      if (![...this.listeners.values()].some(s => s.size)) {
        this.closed = true;
        this.ws?.close();
        this.ws = null;
      }
    }
    notify(changed) {
      for (const [path, callbacks] of this.listeners) {
        if (!path || path === changed || changed.startsWith(path + '/') || path.startsWith(changed + '/')) {
          const value = this.read(path);
          for (const cb of callbacks) try { cb(value); } catch (e) { console.error(e); }
        }
      }
    }
    notifyAll() { for (const path of this.listeners.keys()) this.notify(path); }
    connect() {
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      this.closed = false;
      const wsBase = BASE.replace(/^http/, 'ws');
      const ws = this.ws = new WebSocket(`${wsBase}/v1/realtime?room=${enc(this.code)}`);
      ws.onopen = async () => {
        this.retry = 1000;
        try { await this.load(); this.notifyAll(); } catch (e) { console.error(e); }
      };
      ws.onmessage = (event) => {
        let msg; try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'connected') return;
        this.apply(msg);
      };
      ws.onclose = () => {
        this.ws = null;
        if (!this.closed && [...this.listeners.values()].some(s => s.size)) {
          setTimeout(() => this.connect(), this.retry);
          this.retry = Math.min(this.retry * 2, 15_000);
        }
      };
    }
    apply(msg) {
      if (!this.tree && msg.action !== 'delete') return;
      const r = msg.record || {};
      if (msg.type === 'room') {
        if (msg.action === 'delete') this.tree = null;
        else Object.assign(this.tree, r);
        this.notify('state'); this.notify('topic'); this.notify('present');
        this.notify('writeTimer'); this.notify('settings');
      } else if (msg.type === 'player') {
        if (msg.action === 'delete') delete this.tree.players[r.pid]; else this.tree.players[r.pid] = r;
        this.notify('players');
      } else if (msg.type === 'problem') {
        if (msg.action === 'delete') delete this.tree.problems[r.pid]; else this.tree.problems[r.pid] = r;
        this.notify('problems/' + r.pid); this.notify('problems');
      } else if (msg.type === 'vote') {
        const votes = this.tree.votes[r.ownerPid] ||= {};
        if (msg.action === 'delete') delete votes[r.voterPid]; else votes[r.voterPid] = r.choice;
        this.notify('votes/' + r.ownerPid); this.notify('votes');
      }
    }
  }

  const stores = new Map();
  const storeFor = (code) => {
    if (!stores.has(code)) stores.set(code, new RoomStore(code));
    return stores.get(code);
  };
  const ROOM_FIELDS = new Set(['state','topic','present','writeTimer','settings','createdAt']);

  function setNested(target, parts, value, remove) {
    let cur = target;
    for (let i=0;i<parts.length-1;i++) cur = cur[parts[i]] ||= {};
    if (remove) delete cur[parts.at(-1)]; else cur[parts.at(-1)] = resolveTS(value);
  }
  async function writePath(code, path, value, mode) {
    const st = storeFor(code);
    if (!st.tree && mode !== 'set') await st.load();
    const parts = String(path || '').split('/').filter(Boolean);
    if (!parts.length) {
      if (mode === 'remove') { await req(`/v1/jinjinga/rooms/${enc(code)}`, {method:'DELETE'}); stores.delete(code); return; }
      if (mode === 'set') {
        const b = clone(value || {}); for (const k of Object.keys(b)) b[k] = resolveTS(b[k]);
        const room = await req(`/v1/jinjinga/rooms/${enc(code)}`, json('POST', b));
        st.tree = {...room,players:{},problems:{},votes:{}}; return;
      }
      const roomPatch = {};
      for (const [key,val] of Object.entries(value || {})) {
        const ps=key.split('/');
        if (ROOM_FIELDS.has(ps[0])) {
          if (ps.length===1) roomPatch[ps[0]]=resolveTS(val);
          else { const base=clone(roomPatch[ps[0]] ?? st.read(ps[0]) ?? {}); setNested(base,ps.slice(1),val,false); roomPatch[ps[0]]=base; }
        } else await writePath(code,key,val,'set');
      }
      if(Object.keys(roomPatch).length) {
        const updated=await req(`/v1/jinjinga/rooms/${enc(code)}`,json('PATCH',roomPatch));
        if(st.tree&&updated)Object.assign(st.tree,updated);
      }
      return;
    }
    const [head,...rest]=parts;
    if(ROOM_FIELDS.has(head)) {
      if(!rest.length) {
        const updated=await req(`/v1/jinjinga/rooms/${enc(code)}`,json('PATCH',{[head]:mode==='remove'?null:resolveTS(value)}));
        if(st.tree&&updated)Object.assign(st.tree,updated); return updated;
      }
      const current=clone(st.read(head)||{}); setNested(current,rest,value,mode==='remove');
      const updated=await req(`/v1/jinjinga/rooms/${enc(code)}`,json('PATCH',{[head]:current}));
      if(st.tree&&updated)Object.assign(st.tree,updated); return updated;
    }
    if(head==='players' && rest[0]) {
      const pid=rest[0], url=`/v1/jinjinga/rooms/${enc(code)}/players/${enc(pid)}`;
      if(mode==='remove') return req(url,{method:'DELETE'});
      const merged={...(clone(st.read(`players/${pid}`))||{}),...(value||{})};
      for(const k of Object.keys(merged)) merged[k]=resolveTS(merged[k]);
      return req(url,json('PUT',merged));
    }
    if(head==='problems' && rest[0]) {
      const pid=rest[0], url=`/v1/jinjinga/rooms/${enc(code)}/problems/${enc(pid)}`;
      if(mode==='remove') return req(url,{method:'DELETE'});
      const merged={...(clone(st.read(`problems/${pid}`))||{}),...(value||{})};
      for(const k of Object.keys(merged)) merged[k]=resolveTS(merged[k]);
      return req(url,json('PUT',merged));
    }
    if(head==='votes' && rest[0] && rest[1]) {
      const url=`/v1/jinjinga/rooms/${enc(code)}/votes/${enc(rest[0])}/${enc(rest[1])}`;
      return mode==='remove' ? req(url,{method:'DELETE'}) : req(url,json('PUT',{choice:Number(value)}));
    }
  }

  function snap(v) { return { val:()=>v===undefined?null:v, exists:()=>v!==null&&v!==undefined }; }
  class Ref {
    constructor(kind,code,path,key){this.kind=kind;this.code=code;this.path=path||'';this.key=key||(this.path?this.path.split('/').at(-1):null);}
    child(p){return new Ref(this.kind,this.code,this.path?this.path+'/'+p:p);}
    push(){const key=pushKey();return new Ref(this.kind,this.code,this.path?this.path+'/'+key:key,key);}
    async get(){
      if(this.kind==='info')return snap(0); if(this.kind==='quota')return snap(null);
      if(this.kind==='index'){const rows=await req('/v1/jinjinga/rooms');const map={};for(const r of rows||[])map[r.code]=r.createdAt;return snap(this.path?map[this.path]??null:map);}
      const st=storeFor(this.code);await st.load();return snap(st.read(this.path));
    }
    set(v){if(this.kind!=='room')return Promise.resolve();return writePath(this.code,this.path,v,'set');}
    update(v){if(this.kind!=='room')return Promise.resolve();return writePath(this.code,this.path,v,'update');}
    remove(){if(this.kind==='index'||this.kind==='quota'||this.kind==='info')return Promise.resolve();return writePath(this.code,this.path,null,'remove');}
    on(event,cb){
      if(event!=='value')return cb; if(this.kind==='info'){cb(snap(0));return cb;} if(this.kind!=='room'){cb(snap(null));return cb;}
      const wrapped=v=>cb(snap(v)); cb._wsWrapped=wrapped; const st=storeFor(this.code);
      if(!st.tree) st.load().then(()=>st.on(this.path,wrapped)).catch(console.error); else st.on(this.path,wrapped);
      return cb;
    }
    off(event,cb){if(this.kind==='room'&&cb)storeFor(this.code).off(this.path,cb._wsWrapped||cb);}
  }
  function makeRef(full){
    const p=String(full||'').replace(/^\/+|\/+$/g,'');
    if(p.startsWith('.info'))return new Ref('info',null,p);
    if(p.startsWith('quota'))return new Ref('quota',null,p.slice(6));
    if(p==='rooms/JJG_INDEX'||p.startsWith('rooms/JJG_INDEX/'))return new Ref('index',null,p.slice(15).replace(/^\//,''));
    const m=p.match(/^rooms\/JJG_([^/]+)\/?(.*)$/);if(m)return new Ref('room',m[1],m[2]);
    return new Ref('room','__unknown__',p);
  }

  const user={uid:'local-teacher',isAnonymous:false,displayName:'선생님',email:null};
  const auth={currentUser:user,onAuthStateChanged(cb){setTimeout(()=>cb(user),0);return()=>{};},signInAnonymously:async()=>({user}),
    signInWithPopup:async()=>({user}),signInWithRedirect:async()=>{},getRedirectResult:async()=>({user:null}),signOut:async()=>{}};
  window.firebase={initializeApp(){return{};},auth:Object.assign(()=>auth,{GoogleAuthProvider:function(){}}),
    database:Object.assign(()=>({ref:makeRef}),{ServerValue:{TIMESTAMP:TS}})};
  console.log('[postgres-adapter] room-scoped backend:',BASE);
})();
