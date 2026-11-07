#!/usr/bin/env node
/* ============================================================
   储能大屏 · 实时数据桥接服务（v2.0）
   ------------------------------------------------------------
   职责：把「任意数据源」转成大屏 WebSocket 协议（docs/data-contract.md）
     推送：scada 指标帧 1s/帧 · history 曲线帧 30s/帧 · hello 握手
     回写：接收 {t:'op'} 处置指令 → 落盘 ops.jsonl → 广播 alertState
   数据源：
     - CSV 文件（server/data/stations.csv / alerts.csv，mtime 变更热加载）
       → 本地联调 / 无后端演示用
     - MQTT / Modbus / 关系库：实现 sources/ 下适配器后替换 loadStations()
   运行：node server/bridge.js  [端口默认 9001]
   零依赖：WebSocket 服务端为手写 RFC6455 最小实现（握手/文本帧/心跳）
   ============================================================ */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || process.env.BRIDGE_PORT || '9001', 10);
const DATA_DIR = path.join(__dirname, 'data');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ---------------- 计划曲线（与前端 data.js PLAN_PTS 同源） ---------------- */
const PLAN_PTS = [[0, -110], [5.5, -110], [7, -20], [8.5, 128], [10.5, 150], [11.5, 80],
  [13, -40], [16, 0], [17.5, 168], [20, 176], [21.5, 30], [23, -58], [24, -110]];
const smooth = t => t * t * (3 - 2 * t);
function planAt(h) {
  h = ((h % 24) + 24) % 24;
  for (let i = 0; i < PLAN_PTS.length - 1; i++) {
    const a = PLAN_PTS[i], b = PLAN_PTS[i + 1];
    if (h >= a[0] && h <= b[0]) {
      const t = (h - a[0]) / (b[0] - a[0] || 1);
      return a[1] + (b[1] - a[1]) * smooth(t);
    }
  }
  return -110;
}
const nowH = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };

/* ---------------- CSV 数据源（mtime 热加载） ---------------- */
function parseCsv(file) {
  const txt = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = txt.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  const head = lines[0].split(',').map(s => s.trim());
  return lines.slice(1).map(l => {
    const cells = l.split(',').map(s => s.trim());
    const o = {};
    head.forEach((k, i) => { o[k] = cells[i]; });
    return o;
  });
}

function loadCsv(name, fallback) {
  const f = path.join(DATA_DIR, name);
  try {
    const st = fs.statSync(f);
    const cached = fallback && fallback._mtime && fallback._mtime === st.mtimeMs;
    if (cached) return fallback;
    const rows = parseCsv(f);
    rows._mtime = st.mtimeMs;
    return rows;
  } catch (e) {
    console.warn('[bridge] 读取失败:', name, e.message);
    return fallback || [];
  }
}

let stationRows = [];
let alertRows = [];
let alertStatus = new Map();   /* alertId -> 0/1/2/3（回写状态机，含跨客户端同步） */
let opsLog = path.join(DATA_DIR, 'ops.jsonl');

function loadAll() {
  stationRows = loadCsv('stations.csv', stationRows);
  alertRows = loadCsv('alerts.csv', alertRows);
}

/* ---------------- 指标推演（演示数据源：真实部署替换为采集值） ----------------
   以 CSV 基线为初值做随机游走 + 计划曲线关联，模拟「真实波动」；
   接 MQTT/数据库后删掉本函数，直接把采集值填进 stations 数组即可。 */
const walk = new Map();
function simulateStations() {
  const h = nowH(), plan = planAt(h);
  return stationRows.map(r => {
    const id = r.id;
    const mw = parseFloat(r.mw) || 50;
    const cap = parseFloat(r.cap) || 100;
    if (!walk.has(id)) walk.set(id, { soc: parseFloat(r.soc) || 60, p: 0 });
    const w = walk.get(id);
    const comm = (r.comm || 'online') !== 'offline';
    let status = r.status || 'discharging';
    let power, soc;
    if (!comm) {
      power = 0; soc = w.soc; status = 'offline';
    } else {
      const bias = parseFloat(r.bias) || 1;                  /* CSV 可配站点出力系数 */
      const noise = (Math.random() - 0.5) * mw * 0.03;       /* ±1.5% 额定噪声 */
      power = +(plan * (mw / 620) * bias + noise).toFixed(1);
      status = power > 3 ? 'discharging' : (power < -3 ? 'charging' : 'standby');
      const dSoc = (-power * (1 / 3600) / cap) * 100;        /* 1s 电量积分 */
      soc = Math.max(8, Math.min(96, w.soc + dSoc));
      w.soc = soc; w.p = power;
    }
    return {
      id, power, soc: +soc.toFixed(2),
      soh: parseFloat(r.soh) || 95,
      temp: +( (parseFloat(r.temp) || 30) + (Math.random() - 0.5) * 0.4 ).toFixed(1),
      status, comm: comm ? 'online' : 'offline'
    };
  });
}

function buildHistory(id) {
  const r = stationRows.find(x => x.id === id);
  if (!r) return null;
  const mw = parseFloat(r.mw) || 50;
  const cap = parseFloat(r.cap) || 100;
  const share = mw / 620;
  const n = 96, nowIdx = Math.floor(nowH() * 4);
  const labels = [], plan = [], actual = [], soc = [], socPlan = [];
  let s = parseFloat(r.soc) || 60, sp = s;
  for (let i = 0; i < n; i++) {
    const h = i * 0.25 + 0.125;
    const p = planAt(h) * share;
    labels.push(h);
    plan.push(+p.toFixed(2));
    if (i < nowIdx) actual.push(+(p * 0.985 + Math.sin(i / 7) * 2.4).toFixed(2));
    else if (i === nowIdx) actual.push(+(p * 0.9).toFixed(2));
    else actual.push(null);
    const d = (-p * 0.25 / cap) * 100;
    s = Math.max(8, Math.min(96, s + d)); soc.push(+s.toFixed(1));
    sp = Math.max(20, Math.min(90, sp + d * 0.92)); socPlan.push(+sp.toFixed(1));
  }
  return { t: 'history', st: id, labels, plan, actual, soc, socPlan, nowIdx, ts: Date.now() };
}

/* ---------------- WebSocket（RFC6455 最小实现） ---------------- */
const clients = new Set();

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/* 编码一帧（服务端不出掩码）；opcode: 1=text 8=close 9=ping 10=pong */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

function sendText(sock, str) {
  if (sock.destroyed) return;
  try { sock.write(encodeFrame(1, Buffer.from(str, 'utf8'))); } catch (e) { drop(sock); }
}

function sendJson(sock, obj) { sendText(sock, JSON.stringify(obj)); }

function broadcast(obj) {
  const s = JSON.stringify(obj);
  clients.forEach(c => sendText(c, s));
}

function drop(sock) {
  if (clients.delete(sock)) { try { sock.destroy(); } catch (e) { /* noop */ } }
}

/* 解析客户端帧（浏览器必掩码）；返回 {opcode, payload, rest} */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (masked) { if (buf.length < off + 4 + len) return null; }
  else if (buf.length < off + len) return null;
  let payload;
  if (masked) {
    const mask = buf.slice(off, off + 4);
    payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i % 4];
    off += 4 + len;
  } else payload = buf.slice(off, off + len);
  return { opcode, payload, rest: buf.slice(off) };
}

const server = http.createServer((req, res) => {
  /* 健康检查端点：网关/运维探活用 */
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, stations: stationRows.length, alerts: alertRows.length, ts: Date.now() }));
    return;
  }
  res.writeHead(426); res.end('WebSocket upgrade required');
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade.toLowerCase() !== 'websocket') { sock.destroy(); return; }
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  sock.setNoDelay(true);
  clients.add(sock);
  let buf = Buffer.alloc(0);

  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const f = decodeFrame(buf);
      if (!f) break;
      buf = f.rest;
      if (f.opcode === 8) { drop(sock); return; }                       /* close */
      if (f.opcode === 9) { try { sock.write(encodeFrame(10, f.payload)); } catch (e) { /* noop */ } continue; }  /* ping→pong */
      if (f.opcode !== 1) continue;
      let m;
      try { m = JSON.parse(f.payload.toString('utf8')); } catch (e) { continue; }
      onMessage(sock, m);
    }
  });
  sock.on('error', () => drop(sock));
  sock.on('close', () => drop(sock));

  /* 握手帧：协议版本 + 站点清单 + 当前告警全量 + 24h 曲线（新客户端秒级对齐，不用等 30s tick） */
  sendJson(sock, {
    t: 'hello', v: 2, bridge: 'csv-demo',
    stations: stationRows.map(r => r.id),
    alerts: alertRows.map(r => ({ id: r.id, lv: r.lv, st: r.st, dev: r.dev, text: r.text, status: alertStatus.get(r.id) || 0 })),
    ts: Date.now()
  });
  if (!historyCache.size) refreshHistory();
  historyCache.forEach(h => sendJson(sock, h));
});

/* ---------------- 处置回写：op → ops.jsonl + 广播同步 ---------------- */
function onMessage(sock, m) {
  if (m.t === 'ping') { sendJson(sock, { t: 'pong', ts: m.ts }); return; }
  if (m.t !== 'op' || !Array.isArray(m.ids)) return;
  const rec = { ts: new Date().toISOString(), by: String(m.by || 'web'), action: String(m.action || '?'), ids: m.ids, result: 'ok' };
  try {
    fs.appendFileSync(opsLog, JSON.stringify(rec) + '\n');
  } catch (e) { rec.result = 'log-failed: ' + e.message; }
  console.log('[op]', JSON.stringify(rec));
  m.ids.forEach(id => {
    let status;
    if (m.action === 'ack') status = 1;
    else if (m.action === 'close') status = 2;
    else if (m.action === 'undo') status = alertStatus.get(id) === 2 ? 0 : 0;  /* 演示：撤销回未确认 */
    else status = alertStatus.get(id) || 0;
    alertStatus.set(id, status);
    broadcast({ t: 'alertState', id, status, by: rec.by, ts: Date.now() });
  });
}

/* ---------------- 推送循环 ---------------- */
const historyCache = new Map();

function refreshHistory() {
  stationRows.forEach(r => {
    const h = buildHistory(r.id);
    if (h) historyCache.set(r.id, h);
  });
}

setInterval(() => {
  loadAll();   /* CSV 热加载（mtime 未变时零开销） */
  if (clients.size) broadcast({ t: 'scada', ts: Date.now(), stations: simulateStations() });
}, 1000);

setInterval(() => {
  refreshHistory();
  if (clients.size) historyCache.forEach(h => broadcast(h));
}, 30000);

/* 新告警注入演示：向 server/data/alerts.csv 追加一行并保存，10s 内全端弹出台账 */

loadAll();
server.listen(PORT, () => {
  console.log(`[bridge] ws://127.0.0.1:${PORT}/ws   health: http://127.0.0.1:${PORT}/health`);
  console.log(`[bridge] 数据源: server/data/stations.csv (${stationRows.length} 站) / alerts.csv (${alertRows.length} 条)`);
  console.log('[bridge] 处置回写落盘: server/data/ops.jsonl');
});
