'use strict';
// FUTPOINTS · servidor dedicado
// - Sirve public/index.html y acepta WebSockets en /ws
// - Ejecuta la MISMA simulación del juego que hay dentro de index.html (los trozos marcados con
//   los comentarios SIM y END), una instancia aislada por sala. Así, si cambias poderes o modos en
//   index.html, el servidor los recoge solo al reiniciarse: no hay que tocar nada aquí.
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const MAX_ROOMS = +process.env.MAX_ROOMS || 20;
const GRACE_MS = 30000;      // tiempo que se guarda el puesto de quien pierde la conexión
const EMPTY_MS = 60000;      // sala sin nadie conectado: se borra
const STEP = 1000 / 60;      // la física va a 60 Hz; se emite a 30 Hz (20 Hz con sala llena)
const HTML_PATH = path.join(__dirname, 'public', 'index.html');

/* ---------- carga de la simulación desde index.html ---------- */
const html = fs.readFileSync(HTML_PATH, 'utf8');
const chunks = [...html.matchAll(/\/\*@SIM\*\/([\s\S]*?)\/\*@END\*\//g)].map(m => m[1]);
if (chunks.length < 6) throw new Error('No encuentro los marcadores /*@SIM*/ en public/index.html');

const PRE = `
var conns=[];var isHost=true,myId='srv';var ADMIN='';
function fev(e){G.ev.push(e)}
function netTx(c,s,soft){return SEND(c,s,soft)}
function netJ(c,o,soft){return SEND(c,JSON.stringify(o),soft)}
function netAll(o){const s=JSON.stringify(o);for(const c of conns)SEND(c,s,false)}
function setTeams(i1,i2){const ok=i=>i===-1||!!TEAMS[i];if(!ok(i1)||!ok(i2)||(i1===i2&&i1!==-1))return;TS=[i1,i2]}
`;

const POST = `
var tick=0;
var _ss=snapStatic;snapStatic=function(){const o=_ss();o.ad=ADMIN;return o};
function S_one(){step();G.players.forEach(p=>{if(p.kn){const r=p.kr||[0,0,0];p.in.k=r[0];p.in.d=r[1];p.in.u=r[2];p.kn=0}});const SR=conns.length>8?3:conns.length>6?2:1;/* 60 envíos/s con hasta 6 jugadores */if(++tick%SR===0)broadcast()}
function S_force(){stN=4}
function S_add(id,name,num){if(G.players.size>=MAXP)return false;G.players.set(id,mk(id,String(name||'Jugador').slice(0,12),num));return true}
function S_del(id){G.players.delete(id)}
function S_zero(id){const p=G.players.get(id);if(p)p.in={x:0,y:0,k:0,d:0,s:0,u:0}}
function S_pings(){const o={};G.players.forEach((p,id)=>{if(!p.bot)o[id]=p.pg|0});return o}
function S_msg(id,m){
 const p=G.players.get(id);if(!p)return;
 if(m.t==='in'){const x=+m.x,y=+m.y,k=m.k?1:0,d=m.d?1:0,u=m.u?1:0;p.kr=[k,d,u];p.kn=(p.kn||0)|k|(d<<1)|(u<<2);p.in={x:clamp(isFinite(x)?x:0,-1,1),y:clamp(isFinite(y)?y:0,-1,1),k:(k||(p.kn&1))?1:0,d:(d||(p.kn&2))?1:0,s:m.s?1:0,u:(u||(p.kn&4))?1:0}}
 else if(m.t==='team')setTeam(p,+m.v);
 else if(m.t==='chat'){
  const n=Date.now();if(n-(p.cl||0)<500)return;p.cl=n;
  const txt=String(m.m||'').trim().slice(0,120);if(!txt)return;
  netAll({t0:'chat',n:p.name,m:txt,k:p.team|0});
 }
 else if(m.t==='rx'){
  const e=m.e|0;if(e<0||e>4)return;
  const n=Date.now();if(n-(p.rl||0)<800)return;p.rl=n;
  netAll({t0:'rx',id:p.id,e});
 }
 else if(m.t==='ping'){if(m.r!==undefined)p.pg=clamp(Math.round(+m.r)||0,0,999);if(m.d!==undefined)p.pd=clamp(Math.round(+m.d)||0,0,250)}
}
function S_adm(a,v){
 const lobby=G.phase==='lobby';
 if(a==='start')startStop();
 else if(a==='mode'){v=v|0;if(lobby&&MODES[v])setMode(v,true)}
 else if(a==='gm'){if(lobby)setMode(v?3:lastStd,true)}
 else if(a==='gl'){if(lobby){LIM=clamp(v|0,0,99);if(!LIM&&!TIME)TIME=180;G.time=TIME}}
 else if(a==='tt'){if(lobby){TIME=clamp(v|0,0,3600);if(!TIME&&!LIM)LIM=3;G.time=TIME}}
 else if(a==='pw'){pwOn=!!v;clearPow()}
 else if(a==='sp')spi=clamp(v|0,0,2);
 else if(a==='ct')cti=clamp(v|0,0,2);
 else if(a==='df')diff=clamp(v|0,0,2);
 else if(a==='bot'){if(Array.isArray(v)){const t=v[0]|0;if(t===1||t===2){(v[1]|0)>0?addBot(t):delBot(t)}}}
 else if(a==='team'){if(Array.isArray(v)){const q=G.players.get(String(v[0]));if(q)setTeam(q,+v[1])}}
 else if(a==='tms'){if(Array.isArray(v)&&Number.isInteger(+v[0])&&Number.isInteger(+v[1]))setTeams(+v[0],+v[1])}
 else if(a==='rand'){
  const hs=[...G.players.values()].filter(p=>!p.bot);
  for(let i=hs.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[hs[i],hs[j]]=[hs[j],hs[i]]}
  const c=[0,0,0];G.players.forEach(p=>{if(p.bot&&p.team)c[p.team]++});
  for(const p of hs){const t=c[1]<c[2]?1:c[2]<c[1]?2:(Math.random()<.5?1:2);c[t]++;setTeam(p,t)}
  netAll({t0:'chat',n:'⚙',m:'Equipos aleatorios',k:0});
 }
}
`;

const script = new vm.Script(PRE + '\n' + chunks.join('\n') + '\n' + POST, { filename: 'sim.js' });

function sendTo(c, s, soft) {
  const w = c && c.ws;
  if (!w || w.readyState !== 1) return false;
  if (soft && w.bufferedAmount > 8192) return false; // cliente lento: salta este snapshot en vez de acumular cola
  try { w.send(s); return true; } catch (e) { return false; }
}

/* ---------- salas ---------- */
const rooms = new Map();

function makeRoom(code) {
  const ctx = vm.createContext({ SEND: sendTo });
  script.runInContext(ctx);
  return { code, ctx, clients: new Map(), nextId: 1, acc: 0, last: performance.now(), emptySince: 0, admin: '' };
}
function newCode() {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.random() * 10000 | 0).padStart(4, '0');
    if (!rooms.has(c)) return c;
  }
  return null;
}
const jsend = (ws, o) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} };
function connectedClients(room) { return [...room.clients.values()].filter(c => c.ws); }
function setAdmin(room, id) { room.admin = id; room.ctx.ADMIN = id; room.ctx.S_force(); }

function attach(room, cl, ws) {
  cl.ws = ws;
  clearTimeout(cl.grace);
  if (!room.ctx.conns.includes(cl)) room.ctx.conns.push(cl);
  room.emptySince = 0;
  const adm = room.clients.get(room.admin);
  if (!adm || !adm.ws) setAdmin(room, cl.id);
  jsend(ws, { t0: 'welcome', id: cl.id, code: room.code, tok: cl.tok });
  room.ctx.S_force();
}
function removeClient(room, cl) {
  const a = room.ctx.conns, i = a.indexOf(cl);
  if (i >= 0) a.splice(i, 1);
  room.ctx.S_del(cl.id);
  room.clients.delete(cl.id);
  clearTimeout(cl.grace);
  if (room.admin === cl.id) {
    const nx = connectedClients(room)[0];
    setAdmin(room, nx ? nx.id : '');
  }
}
function detach(room, cl) {
  cl.ws = null;
  const a = room.ctx.conns, i = a.indexOf(cl);
  if (i >= 0) a.splice(i, 1);
  room.ctx.S_zero(cl.id);
  if (room.admin === cl.id) {
    const nx = connectedClients(room)[0];
    if (nx) setAdmin(room, nx.id);
  }
  cl.grace = setTimeout(() => removeClient(room, cl), GRACE_MS);
  if (!connectedClients(room).length) room.emptySince = performance.now();
}

/* ---------- HTTP + WebSocket ---------- */
const gz = zlib.gzipSync(Buffer.from(html), { level: 9 });
const htmlBuf = Buffer.from(html);
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    const useGz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
    if (useGz) h['Content-Encoding'] = 'gzip';
    res.writeHead(200, h);
    res.end(useGz ? gz : htmlBuf);
    return;
  }
  res.writeHead(404); res.end('404');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048, perMessageDeflate: false });

wss.on('connection', ws => {
  ws.isAlive = true;
  let room = null, cl = null, cnt = 0, cntT = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  ws.on('message', (data, isBin) => {
    if (isBin) return;
    const t = Date.now();
    if (t - cntT > 1000) { cnt = 0; cntT = t; }
    if (++cnt > 150) return; // anti-flood
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (!room) {
      if (m.t === 'create') {
        if (rooms.size >= MAX_ROOMS) { jsend(ws, { t0: 'err', m: 'El servidor está lleno ahora mismo. Prueba en unos minutos.' }); ws.close(); return; }
        const code = newCode();
        if (!code) { jsend(ws, { t0: 'err', m: 'No se pudo crear la sala.' }); ws.close(); return; }
        room = makeRoom(code); rooms.set(code, room);
      } else if (m.t === 'join') {
        room = rooms.get(String(m.code));
        if (!room) { jsend(ws, { t0: 'err', m: 'Sala no encontrada. Revisa el código.' }); ws.close(); return; }
      } else return;

      // ¿vuelve alguien que había perdido la conexión?
      const tok = typeof m.tok === 'string' ? m.tok.slice(0, 40) : '';
      let old = tok ? [...room.clients.values()].find(c => c.tok === tok) : null;
      if (old) {
        if (old.ws && old.ws !== ws) { try { old.ws.close(); } catch (e) {} }
        cl = old; attach(room, cl, ws); return;
      }
      const id = 'p' + (room.nextId++);
      if (!room.ctx.S_add(id, m.n, m.u)) {
        jsend(ws, { t0: 'full' });
        if (!room.clients.size) rooms.delete(room.code);
        setTimeout(() => ws.close(), 200); room = null; return;
      }
      cl = { id, tok: crypto.randomBytes(12).toString('hex'), ws: null, grace: null };
      room.clients.set(id, cl);
      attach(room, cl, ws);
      return;
    }

    if (m.t === 'ping') {
      jsend(ws, { t0: 'pong', n: m.n });
      room.ctx.S_msg(cl.id, m);
    } else if (m.t === 'adm') {
      if (room.admin === cl.id) room.ctx.S_adm(m.a, m.v);
    } else if (m.t === 'bye') {
      removeClient(room, cl); cl.ws = null;
      try { ws.close(); } catch (e) {}
    } else {
      room.ctx.S_msg(cl.id, m);
    }
  });
  ws.on('close', () => {
    if (room && cl && cl.ws === ws && room.clients.has(cl.id)) detach(room, cl);
  });
});

/* ---------- bucle principal ---------- */
setInterval(() => {
  const now = performance.now();
  for (const r of rooms.values()) {
    const dt = now - r.last; r.last = now;
    if (!r.ctx.conns.length) continue;
    r.acc = Math.min(r.acc + dt, 100);
    while (r.acc >= STEP) { r.ctx.S_one(); r.acc -= STEP; }
  }
}, 4);

/* latencias de cada jugador, solo para el administrador (lista de jugadores) */
setInterval(() => {
  for (const r of rooms.values()) {
    const ad = r.clients.get(r.admin);
    if (ad && ad.ws) jsend(ad.ws, { t0: 'pgs', pg: r.ctx.S_pings() });
  }
}, 2000);

/* limpieza: salas vacías y conexiones muertas */
setInterval(() => {
  const now = performance.now();
  for (const [code, r] of rooms) {
    if (!connectedClients(r).length && r.emptySince && now - r.emptySince > EMPTY_MS) {
      for (const c of r.clients.values()) clearTimeout(c.grace);
      rooms.delete(code);
    }
  }
}, 5000);
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  });
}, 15000);

server.listen(PORT, () => console.log('FUTPOINTS servidor en el puerto ' + PORT + ' · ' + chunks.length + ' bloques de simulación'));
