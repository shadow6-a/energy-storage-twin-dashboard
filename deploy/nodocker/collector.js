#!/usr/bin/env node
/* ============================================================
   零 Docker 可观测性采集器（只用 Node 内置模块）
   ------------------------------------------------------------
   定时抓桥接 /metrics + /health → 内存滚动窗口 + CSV 落盘
   → 本地 Web 服务（内置四联曲线仪表盘 + JSON API + 告警条）
   用法：node deploy/nodocker/collector.js --bridge http://127.0.0.1:9001 --web 9099 --interval 5
   ============================================================ */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const BRIDGE = arg('bridge', 'http://127.0.0.1:9001');
const WEB_PORT = parseInt(arg('web', '9099'), 10);
const INTERVAL = Math.max(1, parseInt(arg('interval', '5'), 10)) * 1000;
const MAX_POINTS = parseInt(arg('max', '720'), 10);       // 720 @5s = 1h
const HERE = __dirname;
const CSV = path.join(HERE, 'metrics-history.csv');
const ALERT_LOG = path.join(HERE, 'alerts.log');

const NAMES = [
  'ess_mqtt_msgs_rate', 'ess_mqtt_msgs_total', 'ess_mqtt_msgs_dropped_total', 'ess_mqtt_msgs_stale_total',
  'ess_mqtt_connected', 'ess_stations_online', 'ess_ws_clients', 'ess_ws_msgs_rate',
  'ess_ops_queue_depth', 'ess_ops_dead_total', 'ess_ops_retry_total', 'ess_ops_writeback_ms',
  'ess_ui_heap_mb', 'ess_ui_fps', 'ess_ui_reconnects', 'ess_ui_last_data_age_seconds',
  'ess_bridge_heap_mb', 'ess_bridge_rss_mb', 'ess_bridge_eventloop_lag_ms'
];
const series = new Map(NAMES.map(n => [n, []]));
let lastHealth = { ok: null, reasons: [], checkedAt: 0, httpStatus: 0 };
let alerts = [], samples = 0, lastSampleAt = 0;

function fetchText(url, cb) {
  let req;
  try { req = http.get(url, res => {
    let b = '';
    res.on('data', c => { b += c; });
    res.on('end', () => cb(b, res.statusCode));
  }); } catch (e) { cb('', 0); return; }
  req.setTimeout(2000, () => req.destroy());
  req.on('error', () => cb('', 0));
}

function pushAlert(text) {
  const a = { ts: new Date().toISOString(), text };
  alerts.unshift(a);
  if (alerts.length > 50) alerts.pop();
  try { fs.appendFileSync(ALERT_LOG, JSON.stringify(a) + '\n'); } catch (e) { /* 磁盘不可写不致命 */ }
  console.log('[alert]', a.ts, text);
}

function onHealth(body, status) {
  let ok = false, reasons = [];
  try {
    const j = JSON.parse(body);
    ok = status === 200 && j.ok === true;
    reasons = Array.isArray(j.reasons) ? j.reasons : [];
  } catch (e) { reasons = ['unreachable or invalid /health']; }
  const prev = lastHealth.ok;
  if (prev !== ok) {
    pushAlert(ok ? 'bridge recovered (/health 200)' :
      'bridge unhealthy: ' + (reasons.join(', ') || 'HTTP ' + status));
  }
  lastHealth = { ok, reasons, checkedAt: Date.now(), httpStatus: status };
}

function onMetrics(body, status) {
  if (status !== 200) return;
  const vals = {};
  body.split(/\r?\n/).forEach(line => {
    const m = /^([a-z_][a-z0-9_]*)\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.exec(line.trim());
    if (m && series.has(m[1])) vals[m[1]] = parseFloat(m[2]);
  });
  const t = Date.now();
  for (const name of NAMES) {
    const arr = series.get(name);
    arr.push({ t, v: vals[name] != null ? vals[name] : null });
    if (arr.length > MAX_POINTS) arr.shift();
  }
  samples++;
  lastSampleAt = t;
  const header = 'ts,' + NAMES.join(',') + '\n';
  if (!fs.existsSync(CSV)) { try { fs.writeFileSync(CSV, header); } catch (e) { /* noop */ } }
  const row = [new Date(t).toISOString()].concat(NAMES.map(n => vals[n] != null ? vals[n] : ''));
  try { fs.appendFileSync(CSV, row.join(',') + '\n'); } catch (e) { /* noop */ }
}

function sample() {
  fetchText(BRIDGE + '/metrics', onMetrics);
  fetchText(BRIDGE + '/health', onHealth);
}
setInterval(sample, INTERVAL);
sample();

/* 单个 API handler 的异常不得让采集器整体退出（长跑场景必须自愈） */
process.on('uncaughtException', e => console.error('[collector] handled error:', e.message));

const html = fs.readFileSync(path.join(HERE, 'dashboard.html'));
http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  if (u === '/api/series' || u === '/api/health') {
    const payload = u === '/api/health'
      ? { collector: 'ok', bridge: BRIDGE, intervalSec: INTERVAL / 1000, samples, lastSampleAt, health: lastHealth, alerts: alerts.slice(0, 10) }
      : {
          now: Date.now(), bridge: BRIDGE, intervalSec: INTERVAL / 1000, samples,
          names: NAMES, data: Object.fromEntries(series),
          health: lastHealth, alerts: alerts.slice(0, 10), csv: 'metrics-history.csv'
        };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
    return;
  }
  res.writeHead(404); res.end('404');
}).listen(WEB_PORT, '127.0.0.1', () => {
  console.log('[collector] dashboard  http://127.0.0.1:' + WEB_PORT + '/');
  console.log('[collector] bridge     ' + BRIDGE + '  (interval ' + INTERVAL / 1000 + 's)');
  console.log('[collector] history    ' + CSV);
  console.log('[collector] alert log  ' + ALERT_LOG);
});
