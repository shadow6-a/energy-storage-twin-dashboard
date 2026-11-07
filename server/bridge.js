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
const M = require('./metrics');
const BOOT_TS = Date.now();

const PORT = parseInt(process.argv[2] || process.env.BRIDGE_PORT || '9001', 10);
const DATA_DIR = path.join(__dirname, 'data');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ---------------- CLI：数据源选择 ----------------
   node server/bridge.js                        → CSV 演示源（内置推演）
   node server/bridge.js 9001 --mqtt mqtt://broker.emqx.io:1883 --topic ess/#
   node server/bridge.js --mqtt mqtts://… --user u --pass p
   MQTT 模式下 CSV 只当站点名册（id/name/mw/cap），指标全部由 broker 消息驱动。 */
function cliArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const MQTT_URL = cliArg('mqtt', process.env.MQTT_URL || '');
const MQTT_TOPIC = cliArg('topic', process.env.MQTT_TOPIC || 'ess/#');
const MQTT_USER = cliArg('user', process.env.MQTT_USER || '');
const MQTT_PASS = cliArg('pass', process.env.MQTT_PASS || '');
/* 回写主题：从订阅通配推导（ess/# → ess/ops），多租户/多环境互不串台 */
const OPS_TOPIC = MQTT_TOPIC.replace(/[#*]+$/, '').replace(/\/+$/, '') + '/ops';

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
  rosterMap = new Map(stationRows.map(r => [r.id, r]));
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

/* ---------------- MQTT 数据源（真实采集） ----------------
   订阅 broker，把消息映射成站点指标 / 告警，再按 1s 节拍转成 WS scada 帧。
   消息形态（宽松识别，MQTTX 里手发 JSON 也能即刻见效）：
     {"id":"S01","power":88.5,"soc":61.2}              → 单站指标
     {"stations":[{...},{...}]}                        → 批量指标
     {"id":"A011","lv":"high","st":"S03","text":"…"}   → 新告警（进台账）
     {"t":"history"/"cluster"/"alertState", …}          → 协议帧直通（前端同构消费）
   链路老化：某站 >12s 无消息 → 视为掉线（comm=offline / power=0），不猜数。 */
const live = new Map();      /* id → {power,soc,soh,temp,status,comm,ts} */
let mqttClient = null, mqttState = 'off', mqttMsgCount = 0;

let lastMqttAt = 0;

function ingestPayload(topic, raw) {
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch (e) { M.inc('ess_mqtt_msgs_dropped_total'); return; }
  mqttMsgCount++;
  lastMqttAt = Date.now();
  M.tick('ess_mqtt_msgs');
  M.inc('ess_mqtt_msgs_total');
  if (m && typeof m.t === 'string') {
    if (m.t === 'scada' && Array.isArray(m.stations)) { m.stations.forEach(applyStation); return; }
    if (m.t === 'scada' && m.id) { applyStation(m); return; }
    if (m.t === 'alert') { pushAlert(m.alert || m); return; }
    if (m.t === 'alertState' || m.t === 'history' || m.t === 'cluster') { broadcast(m); return; }
  }
  if (m && Array.isArray(m.stations)) { m.stations.forEach(applyStation); return; }
  if (m && m.id && ('power' in m || 'soc' in m || 'soh' in m || 'temp' in m)) { applyStation(m); return; }
  if (m && m.id && (m.lv || m.text)) { pushAlert(m); return; }
}

/* 合理性闸门：真实 BMS 的坏点（跳变/NaN/超物理量程）在入口拦截，不进前端 */
let rosterMap = new Map();
function plausible(id, s, roster) {
  const r = roster.get(id);
  const mw = r ? r.mw : 200;
  if (s.power != null && (!isFinite(s.power) || Math.abs(s.power) > mw * 3)) return false;   /* 超额定 3 倍 → 坏点 */
  if (s.soc != null && (!isFinite(s.soc) || s.soc < 0 || s.soc > 100)) return false;
  if (s.soh != null && (!isFinite(s.soh) || s.soh <= 0 || s.soh > 100)) return false;
  if (s.temp != null && (!isFinite(s.temp) || s.temp < -40 || s.temp > 90)) return false;
  return true;
}

function applyStation(s) {
  if (!s || !s.id) return;
  if (!plausible(s.id, s, rosterMap)) { M.inc('ess_mqtt_msgs_dropped_total'); return; }
  const prev = live.get(s.id) || {};
  const next = Object.assign({}, prev, { ts: Date.now() });
  ['power', 'soc', 'soh', 'temp'].forEach(k => {
    if (typeof s[k] === 'number' && isFinite(s[k])) next[k] = s[k];
  });
  if (s.status) next.status = s.status;
  if (s.comm) next.comm = s.comm;
  if (typeof next.power === 'number' && !s.status) {
    next.status = next.power > 3 ? 'discharging' : (next.power < -3 ? 'charging' : 'standby');
  }
  live.set(s.id, next);
}

function pushAlert(a) {
  if (!a || !a.id) return;
  const row = {
    id: a.id, lv: a.lv || 'warn', st: a.st || '', dev: a.dev || '遥测',
    text: a.text || '(无描述)', status: alertStatus.get(a.id) || 0
  };
  alertRows = alertRows.filter(x => x.id !== row.id).concat([row]);
  broadcast({ t: 'alert', alert: row, ts: Date.now() });
  console.log('[mqtt] alert', row.id, row.lv, String(row.text).slice(0, 28));
}

/* 1s 节拍：把 MQTT 最新值（含老化判定）转成 scada 批次帧 */
function scadaFromLive() {
  const now = Date.now();
  return stationRows.map(r => {
    const v = live.get(r.id);
    if (!v || now - (v.ts || 0) > 12000) {
      return {
        id: r.id, power: 0,
        soc: v && v.soc != null ? v.soc : (parseFloat(r.soc) || 60),
        soh: parseFloat(r.soh) || 95, temp: parseFloat(r.temp) || 30,
        status: 'offline', comm: 'offline'
      };
    }
    return {
      id: r.id,
      power: v.power != null ? v.power : 0,
      soc: v.soc != null ? v.soc : (parseFloat(r.soc) || 60),
      soh: v.soh != null ? v.soh : (parseFloat(r.soh) || 95),
      temp: v.temp != null ? v.temp : (parseFloat(r.temp) || 30),
      status: v.status || 'standby',
      comm: v.comm || 'online'
    };
  });
}

function startMqtt() {
  const { createClient } = require('./mqtt');
  mqttState = 'connecting';
  mqttClient = createClient({
    url: MQTT_URL,
    clientId: 'ess-bridge-' + Math.random().toString(16).slice(2, 10),
    username: MQTT_USER || undefined,
    password: MQTT_PASS || undefined
  });
  mqttClient.on('connect', () => {
    mqttState = 'connected';
    mqttClient.subscribe([MQTT_TOPIC]);
    console.log('[mqtt] connected →', MQTT_URL, 'subscribe', MQTT_TOPIC);
  });
  mqttClient.on('message', ingestPayload);
  mqttClient.on('error', e => { mqttState = 'error'; console.warn('[mqtt] error:', e.message); });
  mqttClient.on('close', () => { if (mqttState !== 'error') mqttState = 'reconnecting'; });
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
  /* Prometheus 抓取端点：桥接自观测 + 前端遥测聚合（GET /metrics） */
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(M.render());
    return;
  }
  /* 健康检查端点：网关/运维探活用；不健康返回 503（可触发告警联动） */
  if (req.url === '/health') {
    const reasons = [];
    if (MQTT_URL && mqttState !== 'connected') reasons.push('mqtt:' + mqttState);
    if (MQTT_URL && mqttMsgCount > 0 && lastMqttAt > 0 && Date.now() - lastMqttAt > 30000) {
      /* 曾有数据流，现在断流 >30s → 数据源故障（区别于刚启动的静默） */
      reasons.push('mqtt-silent>30s');
    }
    const ok = reasons.length === 0;
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok, reasons,
      clients: clients.size, stations: stationRows.length, alerts: alertRows.length,
      source: MQTT_URL ? 'mqtt' : 'csv', mqtt: mqttState, mqttMsgs: mqttMsgCount,
      msgRate: M.rate('ess_mqtt_msgs'), liveCount: live.size,
      sample: live.get('S01') || null, uptimeS: Math.round((Date.now() - BOOT_TS) / 1000), ts: Date.now()
    }));
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
    t: 'hello', v: 2, bridge: MQTT_URL ? ('mqtt:' + (() => { try { return new URL(MQTT_URL).host; } catch (e) { return MQTT_URL; } })()) : 'csv-demo',
    stations: stationRows.map(r => r.id),
    alerts: alertRows.map(r => ({ id: r.id, lv: r.lv, st: r.st, dev: r.dev, text: r.text, status: alertStatus.get(r.id) || 0 })),
    ts: Date.now()
  });
  if (!historyCache.size) refreshHistory();
  historyCache.forEach(h => sendJson(sock, h));
});

/* ---------------- 处置回写：op → ops.jsonl + 广播同步 ----------------
   反向控制闭环（outbox 模式）：本地审计先落盘（不可丢），
   MQTT 投递失败进重试队列（2s 间隔，上限 5 次），前端通过 opAck 帧拿到最终结果。 */
const opsQueue = [];   /* 待重试的 {rec, tries} */
let opAckSeq = 0;

function publishOps(rec) {
  if (!(mqttClient && mqttState === 'connected')) return false;
  try { mqttClient.publish(OPS_TOPIC, JSON.stringify(rec)); return true; } catch (e) { return false; }
}

setInterval(() => {
  if (!opsQueue.length) return;
  for (let i = opsQueue.length - 1; i >= 0; i--) {
    const item = opsQueue[i];
    item.tries++;
    M.inc('ess_ops_retry_total');
    if (publishOps(item.rec)) {
      opsQueue.splice(i, 1);
      M.set('ess_ops_queue_depth', opsQueue.length);
      broadcast({ t: 'opAck', op: item.rec.ids.join(','), action: item.rec.action, delivered: true, tries: item.tries, ts: Date.now() });
      console.log('[op] retry ok, tries =', item.tries);
    } else if (item.tries >= 5) {
      opsQueue.splice(i, 1);
      M.set('ess_ops_queue_depth', opsQueue.length);
      M.inc('ess_ops_dead_total');
      broadcast({ t: 'opAck', op: item.rec.ids.join(','), action: item.rec.action, delivered: false, tries: item.tries, ts: Date.now() });
      console.warn('[op] dead-letter after 5 tries:', item.rec.action, item.rec.ids.join(','));
    }
  }
}, 2000);

function onMessage(sock, m) {
  M.inc('ess_ws_msgs_in_total');
  M.tick('ess_ws_msgs');
  if (m.t === 'ping') { sendJson(sock, { t: 'pong', ts: m.ts }); return; }
  /* 前端遥测：FPS / Heap / 重连次数 / 数据新鲜度 → /metrics（取所有客户端最新值） */
  if (m.t === 'telemetry') {
    M.set('ess_ui_fps', +m.fps || 0);
    M.set('ess_ui_heap_mb', Math.round((+m.heapMB || 0) * 10) / 10);
    M.set('ess_ui_reconnects', +m.reconnects || 0);
    M.set('ess_ui_last_data_age_seconds', Math.max(0, Math.round(+m.lastDataAge || 0)));
    M.set('ess_ui_ts', Date.now());
    return;
  }
  if (m.t !== 'op' || !Array.isArray(m.ids)) return;
  const t0 = process.hrtime.bigint();
  const rec = { ts: new Date().toISOString(), by: String(m.by || 'web'), action: String(m.action || '?'), ids: m.ids, result: 'ok' };
  try {
    fs.appendFileSync(opsLog, JSON.stringify(rec) + '\n');
  } catch (e) { rec.result = 'log-failed: ' + e.message; }
  const logMs = Number(process.hrtime.bigint() - t0) / 1e6;
  M.set('ess_ops_writeback_ms', Math.round(logMs * 10) / 10);
  M.inc('ess_ops_total');
  console.log('[op]', JSON.stringify(rec));
  /* MQTT 模式：投递失败不阻塞本地审计，进重试队列（2s×5），终态以 opAck 通知前端 */
  if (publishOps(rec)) {
    M.inc('ess_ops_published_total');
  } else if (MQTT_URL) {
    opsQueue.push({ rec, tries: 0 });
    M.set('ess_ops_queue_depth', opsQueue.length);
    M.inc('ess_ops_retry_total');
  }
  sendJson(sock, { t: 'opAck', op: rec.ids.join(','), action: rec.action, logged: true, delivered: MQTT_URL ? !!(mqttClient && mqttState === 'connected') : true, ts: Date.now() });
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
  loadAll();   /* CSV 热加载（mtime 未变时零开销；MQTT 模式下仅作站点名册） */
  if (!clients.size) return;
  broadcast({ t: 'scada', ts: Date.now(), stations: MQTT_URL ? scadaFromLive() : simulateStations() });
}, 1000);

setInterval(() => {
  refreshHistory();
  if (clients.size) historyCache.forEach(h => broadcast(h));
}, 30000);

/* 5s 刷新自观测 gauge：/metrics 与 /health 共用 */
setInterval(() => {
  M.set('ess_uptime_seconds', Math.round((Date.now() - BOOT_TS) / 1000));
  M.set('ess_ws_clients', clients.size);
  M.set('ess_ws_msgs_rate', M.rate('ess_ws_msgs'));
  M.set('ess_mqtt_msgs_rate', M.rate('ess_mqtt_msgs'));
  M.set('ess_mqtt_connected', mqttState === 'connected' ? 1 : 0);
  M.set('ess_stations_online', MQTT_URL ? scadaFromLive().filter(s => s.comm === 'online').length : stationRows.length);
  M.set('ess_alerts_total', alertRows.length);
  const mu = process.memoryUsage();
  M.set('ess_bridge_heap_mb', Math.round(mu.heapUsed / 1048576 * 10) / 10);
  M.set('ess_bridge_rss_mb', Math.round(mu.rss / 1048576 * 10) / 10);
  M.set('ess_bridge_eventloop_lag_ms', eventLoopLagMs);
}, 5000);

/* 事件循环延迟探针（每拍实际触发时刻 vs 计划时刻的差，即真实 lag） */
let eventLoopLagMs = 0;
let lagBase = process.hrtime.bigint();
setInterval(() => {
  const now = process.hrtime.bigint();
  eventLoopLagMs = Math.max(0, Math.round(Number(now - lagBase) / 1e6 - 1000));
  lagBase = now;
}, 1000);

/* 新告警注入演示：向 server/data/alerts.csv 追加一行并保存，10s 内全端弹出台账 */

loadAll();
if (MQTT_URL) startMqtt();
server.listen(PORT, () => {
  console.log(`[bridge] ws://127.0.0.1:${PORT}/ws   health: http://127.0.0.1:${PORT}/health`);
  if (MQTT_URL) {
    console.log(`[bridge] 数据源: MQTT ${MQTT_URL}  topic ${MQTT_TOPIC}（站点名册 ${stationRows.length} 站，指标由 broker 驱动）`);
  } else {
    console.log(`[bridge] 数据源: server/data/stations.csv (${stationRows.length} 站) / alerts.csv (${alertRows.length} 条)`);
  }
  console.log('[bridge] 处置回写: server/data/ops.jsonl' + (MQTT_URL ? ' + mqtt ' + OPS_TOPIC : ''));
});
