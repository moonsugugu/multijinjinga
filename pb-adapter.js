/* ════════════════════════════════════════════════════════════════════
   Firebase Realtime Database → PocketBase 어댑터
   멀티진진가 전용 · 문수네집 홈서버

   [무엇을 하는 파일인가]
   앱(index.html)은 Firebase RTDB 문법(db.ref().child().set() ...)으로
   작성돼 있습니다. 1,749줄을 전부 고치는 대신, 그 문법을 그대로 받아
   PocketBase 로 번역해 주는 계층을 넣었습니다.
   덕분에 앱 로직은 손대지 않았습니다.

   [데이터 매핑]
     rooms/JJG_<코드>                     → jjg_rooms   레코드 1개
     rooms/JJG_<코드>/players/<pid>       → jjg_players 레코드
     rooms/JJG_<코드>/problems/<pid>      → jjg_problems 레코드
     rooms/JJG_<코드>/votes/<주인>/<투표자> → jjg_votes   레코드

   학생별로 레코드를 나눈 이유: 방 전체를 JSON 한 덩어리로 저장하면
   30명이 동시에 제출할 때 서로를 덮어써서 데이터가 사라집니다.

   [로그인]
   홈서버에는 요금이 없으므로 구글 로그인과 하루 10회 제한을 없앴습니다.
   방 코드를 모르면 들어올 수 없다는 점이 접근 통제 역할을 합니다.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // 같은 도메인이면 상대경로, 로컬 개발이면 PocketBase 직접 주소
  const PB = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://127.0.0.1:8090'
    : 'https://db.moonsunezip.com';

  const API = PB + '/api/collections';
  const TS = { '.sv': 'timestamp' };          // ServerValue.TIMESTAMP 표식

  const isTS = (v) => v && typeof v === 'object' && v['.sv'] === 'timestamp';
  const now = () => Date.now();
  const resolveTS = (v) => (isTS(v) ? now() : v);

  // Firebase push key 흉내 (시간순 정렬되는 20자 ID)
  const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  function pushKey() {
    let t = now(), s = '';
    for (let i = 7; i >= 0; i--) { s = PUSH_CHARS[t % 64] + s; t = Math.floor(t / 64); }
    for (let i = 0; i < 12; i++) s += PUSH_CHARS[Math.floor(Math.random() * 64)];
    return s;
  }

  async function req(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error('PB ' + r.status + ' ' + url + ' ' + body);
    }
    return r.status === 204 ? null : r.json();
  }
  const jsonOpts = (method, body) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const q = encodeURIComponent;

  /* ─────────────────────────────────────────────────────────
     방 하나의 상태를 통째로 들고 있는 저장소.
     PocketBase 4개 컬렉션을 구독해 Firebase 트리 모양으로 조립한다.
     ───────────────────────────────────────────────────────── */
  class RoomStore {
    constructor(code) {
      this.code = code;
      this.roomId = null;
      this.tree = null;                 // { state, topic, players:{}, ... }
      this.listeners = new Map();       // path -> Set<cb>
      this.ready = null;
    }

    async load() {
      const list = await req(`${API}/jjg_rooms/records?filter=${q(`code="${this.code}"`)}&perPage=1`);
      const rec = list.items[0];
      if (!rec) { this.roomId = null; this.tree = null; return null; }

      this.roomId = rec.id;
      const f = `room="${rec.id}"`;
      const [pl, pr, vo] = await Promise.all([
        req(`${API}/jjg_players/records?filter=${q(f)}&perPage=200`),
        req(`${API}/jjg_problems/records?filter=${q(f)}&perPage=200`),
        req(`${API}/jjg_votes/records?filter=${q(f)}&perPage=500`),
      ]);

      this.tree = {
        createdAt: rec.createdAt,
        state: rec.state,
        topic: rec.topic,
        present: rec.present || null,
        writeTimer: rec.writeTimer || {},
        settings: rec.settings || {},
        players: {},
        problems: {},
        votes: {},
      };
      pl.items.forEach((r) => { this.tree.players[r.pid] = this._player(r); });
      pr.items.forEach((r) => { this.tree.problems[r.pid] = this._problem(r); });
      vo.items.forEach((r) => {
        (this.tree.votes[r.ownerPid] = this.tree.votes[r.ownerPid] || {})[r.voterPid] = r.choice;
      });
      return this.tree;
    }

    _player(r) {
      const o = { name: r.name, submitted: !!r.submitted, joinedAt: r.joinedAt, _id: r.id };
      if (r.rejoinedAt) o.rejoinedAt = r.rejoinedAt;
      return o;
    }
    _problem(r) {
      return { items: r.items || [], fakeIndex: r.fakeIndex, realValue: r.realValue, submittedAt: r.submittedAt, _id: r.id };
    }

    /* 경로별 리스너 등록/해제 */
    on(path, cb) {
      if (!this.listeners.has(path)) this.listeners.set(path, new Set());
      this.listeners.get(path).add(cb);
      if (this.tree) cb(this.read(path));      // 첫 값 즉시 전달 (Firebase 동작과 동일)
      return cb;
    }
    off(path, cb) {
      const s = this.listeners.get(path);
      if (s) s.delete(cb);
    }

    /* 트리에서 경로 값 읽기 */
    read(path) {
      if (!this.tree) return null;
      if (!path) return this.tree;
      let cur = this.tree;
      for (const seg of path.split('/')) {
        if (cur == null || typeof cur !== 'object') return null;
        cur = cur[seg];
      }
      return cur === undefined ? null : cur;
    }

    /* 변경된 경로와 그 조상 경로의 리스너를 깨운다 */
    notify(changed) {
      for (const [path, set] of this.listeners) {
        // 'players' 리스너는 'players/abc' 변경에도 반응해야 한다
        if (path === changed || changed.startsWith(path + '/') || path.startsWith(changed + '/') || path === '') {
          const v = this.read(path);
          set.forEach((cb) => { try { cb(v); } catch (e) { console.error(e); } });
        }
      }
    }

    /* 실시간 이벤트 반영 */
    applyEvent(coll, action, rec) {
      if (!this.tree || !this.roomId) return;
      if (coll === 'jjg_rooms') {
        if (rec.id !== this.roomId) return;
        if (action === 'delete') { this.tree = null; this.notify('state'); return; }
        Object.assign(this.tree, {
          createdAt: rec.createdAt, state: rec.state, topic: rec.topic,
          present: rec.present || null, writeTimer: rec.writeTimer || {}, settings: rec.settings || {},
        });
        ['state', 'topic', 'present', 'writeTimer', 'settings'].forEach((p) => this.notify(p));
        return;
      }
      if (rec.room !== this.roomId) return;

      if (coll === 'jjg_players') {
        if (action === 'delete') delete this.tree.players[rec.pid];
        else this.tree.players[rec.pid] = this._player(rec);
        this.notify('players');
      } else if (coll === 'jjg_problems') {
        if (action === 'delete') delete this.tree.problems[rec.pid];
        else this.tree.problems[rec.pid] = this._problem(rec);
        this.notify('problems/' + rec.pid);
        this.notify('problems');
      } else if (coll === 'jjg_votes') {
        const m = (this.tree.votes[rec.ownerPid] = this.tree.votes[rec.ownerPid] || {});
        if (action === 'delete') delete m[rec.voterPid];
        else m[rec.voterPid] = rec.choice;
        this.notify('votes/' + rec.ownerPid);
        this.notify('votes');
      }
    }
  }

  /* ─────────────────────────────────────────────────────────
     PocketBase 실시간 (SSE) — SDK 없이 직접 구현
     ───────────────────────────────────────────────────────── */
  const STORES = new Map();             // code -> RoomStore
  const COLLS = ['jjg_rooms', 'jjg_players', 'jjg_problems', 'jjg_votes'];
  let es = null;

  function startRealtime() {
    if (es) return;
    es = new EventSource(PB + '/api/realtime');

    es.addEventListener('PB_CONNECT', (e) => {
      const { clientId } = JSON.parse(e.data);
      // 재연결될 때마다 구독을 다시 등록해야 한다
      fetch(PB + '/api/realtime', jsonOpts('POST', { clientId, subscriptions: COLLS }))
        .catch((err) => console.error('구독 등록 실패', err));
    });

    COLLS.forEach((c) => {
      es.addEventListener(c, (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        STORES.forEach((st) => st.applyEvent(c, msg.action, msg.record));
      });
    });

    es.onerror = () => { /* EventSource 가 알아서 재연결한다 */ };
  }

  function storeFor(code) {
    if (!STORES.has(code)) STORES.set(code, new RoomStore(code));
    return STORES.get(code);
  }

  /* ─────────────────────────────────────────────────────────
     쓰기 — 경로를 보고 알맞은 컬렉션으로 번역
     ───────────────────────────────────────────────────────── */
  const ROOM_FIELDS = ['state', 'topic', 'present', 'writeTimer', 'settings', 'createdAt'];

  async function ensureRoom(code) {
    const st = storeFor(code);
    if (st.roomId) return st.roomId;
    await st.load();
    return st.roomId;
  }

  async function findSub(coll, roomId, extra) {
    const f = `room="${roomId}" && ` + extra;
    const r = await req(`${API}/${coll}/records?filter=${q(f)}&perPage=1`);
    return r.items[0] || null;
  }

  // 중첩 경로를 담은 update({"present/idx":1}) 를 개별 쓰기로 분해
  function expand(base, obj) {
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
      out.push([base ? base + '/' + k : k, v]);
    }
    return out;
  }

  async function writePath(code, path, value, mode) {
    const st = storeFor(code);
    const segs = path ? path.split('/').filter(Boolean) : [];

    /* ── 방 전체 ── */
    if (segs.length === 0) {
      if (mode === 'remove') {
        if (!st.roomId) await st.load();
        if (st.roomId) { await req(`${API}/jjg_rooms/records/${st.roomId}`, { method: 'DELETE' }); STORES.delete(code); }
        return;
      }
      const body = { code };
      for (const f of ROOM_FIELDS) if (value && f in value) body[f] = resolveTS(value[f]);
      if (mode === 'set') {
        if (!('createdAt' in body)) body.createdAt = now();
        if (!st.roomId) await st.load();
        if (st.roomId) await req(`${API}/jjg_rooms/records/${st.roomId}`, jsonOpts('PATCH', body));
        else { const rec = await req(`${API}/jjg_rooms/records`, jsonOpts('POST', body)); st.roomId = rec.id; }
      } else {
        // update: 슬래시가 섞인 키를 분해해서 개별 처리
        const roomId = await ensureRoom(code);
        const patch = {};
        // update({"present/idx":1, "present/revealed":true}) 처럼 같은 필드를 여러 번
        // 건드릴 때, 매번 원본을 다시 읽으면 앞의 변경이 지워진다.
        // 그래서 patch 에 누적된 값을 기준으로 이어서 수정한다.
        const workingCopy = (field) => {
          if (!(field in patch) || typeof patch[field] !== 'object' || patch[field] === null) {
            patch[field] = JSON.parse(JSON.stringify(st.read(field) || {}));
          }
          return patch[field];
        };
        for (const [p, v] of expand('', value)) {
          const ps = p.split('/');
          if (ROOM_FIELDS.includes(ps[0])) {
            if (ps.length === 1) patch[ps[0]] = resolveTS(v);
            else {
              let o = workingCopy(ps[0]);
              for (let i = 1; i < ps.length - 1; i++) o = (o[ps[i]] = o[ps[i]] || {});
              o[ps[ps.length - 1]] = resolveTS(v);
            }
          } else {
            await writePath(code, p, v, 'set');
          }
        }
        if (Object.keys(patch).length) await req(`${API}/jjg_rooms/records/${roomId}`, jsonOpts('PATCH', patch));
      }
      return;
    }

    const [head, ...rest] = segs;

    /* ── 방 레코드의 필드 (state, present/idx 등) ── */
    if (ROOM_FIELDS.includes(head)) {
      const roomId = await ensureRoom(code);
      if (rest.length === 0) {
        await req(`${API}/jjg_rooms/records/${roomId}`, jsonOpts('PATCH', { [head]: mode === 'remove' ? null : resolveTS(value) }));
      } else {
        const cur = JSON.parse(JSON.stringify(st.read(head) || {}));
        let o = cur;
        for (let i = 0; i < rest.length - 1; i++) o = (o[rest[i]] = o[rest[i]] || {});
        const last = rest[rest.length - 1];
        if (mode === 'remove') delete o[last];
        else if (mode === 'update' && typeof value === 'object' && value) Object.assign(o[last] = o[last] || {}, value);
        else o[last] = resolveTS(value);
        await req(`${API}/jjg_rooms/records/${roomId}`, jsonOpts('PATCH', { [head]: cur }));
      }
      return;
    }

    /* ── players / problems / votes ── */
    const roomId = await ensureRoom(code);
    if (!roomId) return;

    if (head === 'players') {
      const pid = rest[0];
      if (!pid) return;
      const found = await findSub('jjg_players', roomId, `pid="${pid}"`);
      if (mode === 'remove') { if (found) await req(`${API}/jjg_players/records/${found.id}`, { method: 'DELETE' }); return; }
      const body = { room: roomId, pid };
      for (const [k, v] of Object.entries(value || {})) {
        if (['name', 'submitted', 'joinedAt', 'rejoinedAt'].includes(k)) body[k] = resolveTS(v);
      }
      if (found) await req(`${API}/jjg_players/records/${found.id}`, jsonOpts('PATCH', body));
      else await req(`${API}/jjg_players/records`, jsonOpts('POST', body));
      return;
    }

    if (head === 'problems') {
      const pid = rest[0];
      if (!pid) return;
      const found = await findSub('jjg_problems', roomId, `pid="${pid}"`);
      if (mode === 'remove') { if (found) await req(`${API}/jjg_problems/records/${found.id}`, { method: 'DELETE' }); return; }
      const body = { room: roomId, pid };
      for (const [k, v] of Object.entries(value || {})) {
        if (['items', 'fakeIndex', 'realValue', 'submittedAt'].includes(k)) body[k] = resolveTS(v);
      }
      if (found) await req(`${API}/jjg_problems/records/${found.id}`, jsonOpts('PATCH', body));
      else await req(`${API}/jjg_problems/records`, jsonOpts('POST', body));
      return;
    }

    if (head === 'votes') {
      const [owner, voter] = rest;
      if (!owner || !voter) return;
      const found = await findSub('jjg_votes', roomId, `ownerPid="${owner}" && voterPid="${voter}"`);
      if (mode === 'remove') { if (found) await req(`${API}/jjg_votes/records/${found.id}`, { method: 'DELETE' }); return; }
      const body = { room: roomId, ownerPid: owner, voterPid: voter, choice: Number(value) };
      if (found) await req(`${API}/jjg_votes/records/${found.id}`, jsonOpts('PATCH', body));
      else await req(`${API}/jjg_votes/records`, jsonOpts('POST', body));
      return;
    }
  }

  /* ─────────────────────────────────────────────────────────
     Firebase Ref 흉내
     ───────────────────────────────────────────────────────── */
  function snap(v) {
    return { val: () => (v === undefined ? null : v), exists: () => v !== null && v !== undefined };
  }

  class Ref {
    constructor(kind, code, path, key) {
      this.kind = kind;              // 'room' | 'index' | 'quota' | 'info'
      this.code = code;
      this.path = path || '';
      this.key = key || (this.path ? this.path.split('/').pop() : null);
    }
    child(p) {
      return new Ref(this.kind, this.code, this.path ? this.path + '/' + p : p);
    }
    push() {
      const k = pushKey();
      return new Ref(this.kind, this.code, this.path ? this.path + '/' + k : k, k);
    }

    async get() {
      if (this.kind === 'info') return snap(0);
      if (this.kind === 'quota') return snap(null);            // 제한 없음
      if (this.kind === 'index') {
        const r = await req(`${API}/jjg_rooms/records?perPage=200&fields=code,createdAt`);
        const m = {};
        r.items.forEach((x) => { m[x.code] = x.createdAt; });
        return snap(this.path ? m[this.path] ?? null : m);
      }
      const st = storeFor(this.code);
      if (!st.tree) await st.load();
      return snap(st.read(this.path));
    }

    async set(v) {
      if (this.kind === 'quota' || this.kind === 'index' || this.kind === 'info') return;
      return writePath(this.code, this.path, v, 'set');
    }
    async update(v) {
      if (this.kind === 'quota' || this.kind === 'index' || this.kind === 'info') return;
      return writePath(this.code, this.path, v, 'update');
    }
    async remove() {
      if (this.kind === 'quota' || this.kind === 'info') return;
      if (this.kind === 'index') return;                       // 방을 지우면 색인도 함께 사라짐
      return writePath(this.code, this.path, null, 'remove');
    }

    on(evt, cb) {
      if (evt !== 'value') return cb;
      if (this.kind === 'info') { cb(snap(0)); return cb; }     // serverTimeOffset = 0
      if (this.kind !== 'room') { cb(snap(null)); return cb; }
      const st = storeFor(this.code);
      const wrapped = (v) => cb(snap(v));
      startRealtime();
      if (!st.tree) {
        st.load().then(() => st.on(this.path, wrapped)).catch((e) => console.error(e));
        // 로드 중에도 리스너는 등록해 둔다
        if (!st.listeners.has(this.path)) st.listeners.set(this.path, new Set());
        st.listeners.get(this.path).add(wrapped);
      } else {
        st.on(this.path, wrapped);
      }
      cb._w = wrapped;
      return cb;
    }
    off(evt, cb) {
      if (this.kind !== 'room' || !cb) return;
      storeFor(this.code).off(this.path, cb._w || cb);
    }
  }

  /* db.ref(path) 진입점 — 경로 앞부분을 보고 종류를 정한다 */
  function makeRef(full) {
    const p = String(full || '').replace(/^\/+|\/+$/g, '');
    if (p.startsWith('.info')) return new Ref('info', null, p);
    if (p.startsWith('quota')) return new Ref('quota', null, p.slice(6));
    if (p === 'rooms/JJG_INDEX' || p.startsWith('rooms/JJG_INDEX/')) {
      return new Ref('index', null, p.slice('rooms/JJG_INDEX'.length).replace(/^\//, ''));
    }
    const m = p.match(/^rooms\/JJG_([^/]+)\/?(.*)$/);
    if (m) return new Ref('room', m[1], m[2]);
    return new Ref('room', '__unknown__', p);
  }

  /* ─────────────────────────────────────────────────────────
     Firebase 전역 객체 흉내
     로그인을 없앴으므로 항상 "선생님"으로 로그인된 것처럼 동작한다.
     ───────────────────────────────────────────────────────── */
  const FAKE_USER = { uid: 'local-teacher', isAnonymous: false, displayName: '선생님', email: null };
  const authCbs = [];

  const authApi = {
    currentUser: FAKE_USER,
    onAuthStateChanged(cb) { authCbs.push(cb); setTimeout(() => cb(FAKE_USER), 0); return () => { const i = authCbs.indexOf(cb); if (i >= 0) authCbs.splice(i, 1); }; },
    signInAnonymously: async () => ({ user: FAKE_USER }),
    signInWithPopup: async () => ({ user: FAKE_USER }),
    signInWithRedirect: async () => {},
    getRedirectResult: async () => ({ user: null }),
    signOut: async () => {},
  };

  window.firebase = {
    initializeApp() { return {}; },
    auth: Object.assign(() => authApi, { GoogleAuthProvider: function () {} }),
    database: Object.assign(() => ({ ref: makeRef }), { ServerValue: { TIMESTAMP: TS } }),
  };

  console.log('[pb-adapter] PocketBase 연결:', PB);
})();
