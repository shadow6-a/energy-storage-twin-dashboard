/* ============================================================
   最小 Prometheus 指标注册表（零依赖）
   ------------------------------------------------------------
   const M = require('./metrics');
   M.inc('ess_ops_total');           // counter
   M.set('ess_ws_clients', 3);       // gauge
   res.end(M.render());              // text/plain exposition
   ============================================================ */
'use strict';

const registry = new Map();          /* name -> {type, help, value} */

function ensure(name, type, help) {
  if (!registry.has(name)) registry.set(name, { type: type || 'gauge', help: help || '', value: 0 });
  return registry.get(name);
}

function inc(name, v, help, type) {
  const m = ensure(name, type || 'counter', help);
  m.value += (v === undefined ? 1 : v);
  return m.value;
}

function set(name, v, help, type) {
  const m = ensure(name, type || 'gauge', help);
  m.value = v;
  return m.value;
}

function get(name) { const m = registry.get(name); return m ? m.value : undefined; }

/* 5s 滑动窗口速率（msgs/s 这类指标用） */
const windows = new Map();           /* name -> {sum, samples:[{t,v}]} */
function rate(name) {
  const w = windows.get(name);
  if (!w) return 0;
  const now = Date.now();
  w.samples = w.samples.filter(s => now - s.t < 5000);
  if (w.samples.length < 2) return 0;
  const span = (now - w.samples[0].t) / 1000;
  return span > 0 ? +(w.sum / span).toFixed(2) : 0;
}
function tick(name, v) {
  v = v === undefined ? 1 : v;
  let w = windows.get(name);
  if (!w) { w = { sum: 0, samples: [] }; windows.set(name, w); }
  w.sum += v;
  w.samples.push({ t: Date.now(), v });
  if (w.samples.length > 100) { const drop = w.samples.splice(0, w.samples.length - 100)[0]; w.sum -= drop.v; }
}

function render() {
  const lines = [];
  for (const [name, m] of registry) {
    if (m.help) lines.push(`# HELP ${name} ${m.help}`);
    lines.push(`# TYPE ${name} ${m.type}`);
    lines.push(`${name} ${typeof m.value === 'number' ? (Math.round(m.value * 1000) / 1000) : m.value}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { inc, set, get, tick, rate, render };
