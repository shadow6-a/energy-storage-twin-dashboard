#!/usr/bin/env node
/* ============================================================
   MQTT 数据模拟器（EMS 替身）
   ------------------------------------------------------------
   每 1s 向 broker 发布 8 站遥测，每 20~30s 随机发一条告警，
   用来在没有真实 EMS 的情况下验证「MQTT → 桥接 → 大屏」全链路。
   用法：
     node server/mqtt-sim.js
     node server/mqtt-sim.js --mqtt mqtt://broker.emqx.io:1883 --prefix ess
     node server/mqtt-sim.js --prefix testtopic        # 在 MQTTX 里订阅 testtopic/# 可直接围观
   字段即协议（docs/data-contract.md §2）：
     ess/scada   {"stations":[{id,power,soc,soh,temp,status}]}
     ess/alert   {"id","lv","st","dev","text"}
   ============================================================ */
'use strict';

const { createClient } = require('./mqtt');

function cliArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const URL_ = cliArg('mqtt', process.env.MQTT_URL || 'mqtt://broker.emqx.io:1883');
const PREFIX = cliArg('prefix', 'ess');
const USER = cliArg('user', process.env.MQTT_USER || '');
const PASS = cliArg('pass', process.env.MQTT_PASS || '');

/* 站点名册（与前端 data.js STATIONS 对齐） */
const STATIONS = [
  { id: 'S01', name: '无锡锡山储能站', mw: 100, cap: 200, soc: 62.4, soh: 95.8, temp: 29.4 },
  { id: 'S02', name: '苏州吴江储能站', mw: 90, cap: 180, soc: 58.7, soh: 94.2, temp: 31.2 },
  { id: 'S03', name: '常州金坛储能站', mw: 80, cap: 160, soc: 71.2, soh: 93.6, temp: 33.8 },
  { id: 'S04', name: '南京江北储能站', mw: 100, cap: 200, soc: 66.8, soh: 96.1, temp: 27.6 },
  { id: 'S05', name: '镇江扬中储能站', mw: 60, cap: 120, soc: 54.3, soh: 92.4, temp: 30.1 },
  { id: 'S06', name: '南通如东储能站', mw: 50, cap: 100, soc: 48.6, soh: 89.7, temp: 35.2 },
  { id: 'S07', name: '扬州仪征储能站', mw: 70, cap: 140, soc: 69.5, soh: 95.1, temp: 28.8 },
  { id: 'S08', name: '泰州靖江储能站', mw: 70, cap: 140, soc: 61.9, soh: 94.8, temp: 29.9 }
];

/* 与 data.js PLAN_PTS 同源的计划曲线 */
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

const state = STATIONS.map(s => Object.assign({}, s));

function tick() {
  const plan = planAt(nowH());
  return state.map(s => {
    const noise = (Math.random() - 0.5) * s.mw * 0.04;
    let power = plan * (s.mw / 620) + noise;
    if (s.id === 'S06') power = 0;                        /* 演示：S06 通信中断，桥接端会判掉线 */
    power = +power.toFixed(1);
    const dSoc = (-power / 3600 / s.cap) * 100;
    s.soc = Math.max(8, Math.min(96, s.soc + dSoc));
    s.temp = Math.max(20, Math.min(45, s.temp + (Math.random() - 0.5) * 0.2));
    const status = s.id === 'S06' ? 'offline' : (power > 3 ? 'discharging' : power < -3 ? 'charging' : 'standby');
    return { id: s.id, power, soc: +s.soc.toFixed(2), soh: s.soh, temp: +s.temp.toFixed(1), status, comm: s.id === 'S06' ? 'offline' : 'online' };
  });
}

const ALERT_POOL = [
  { lv: 'crit', st: 'S01', dev: '2#电池舱 / 电池簇 C-07', text: '单体电压极差 320mV，超阈值 200mV' },
  { lv: 'high', st: 'S03', dev: '1#电池舱 / 液冷机组', text: '冷却液出水温度 32.8℃，超告警阈值 30℃' },
  { lv: 'high', st: 'S02', dev: 'PCS-3', text: '直流侧电流偏高，已自动限功率至 85%' },
  { lv: 'warn', st: 'S05', dev: '2#电池舱 / 空调', text: '回风温度 31.4℃ 偏高，制冷量不足预警' },
  { lv: 'info', st: 'S08', dev: '站用电系统', text: '站用电切换至备用回路，供电正常' }
];
let alertSeq = 0;

const client = createClient({
  url: URL_,
  clientId: 'ess-sim-' + Math.random().toString(16).slice(2, 10),
  username: USER || undefined,
  password: PASS || undefined
});

client.on('connect', () => {
  console.log(`[sim] connected → ${URL_}，发布 ${PREFIX}/scada 1Hz，${PREFIX}/alert 20~30s/条`);
  setInterval(() => {
    client.publish(`${PREFIX}/scada`, JSON.stringify({ t: 'scada', stations: tick() }));
  }, 1000);
  const sendAlert = () => {
    const a = ALERT_POOL[Math.floor(Math.random() * ALERT_POOL.length)];
    alertSeq++;
    const id = 'M' + String(alertSeq).padStart(3, '0');
    client.publish(`${PREFIX}/alert`, JSON.stringify(Object.assign({ t: 'alert', id, time: new Date().toTimeString().slice(0, 5) }, a)));
    console.log('[sim] alert', id, a.lv, a.text.slice(0, 20));
    setTimeout(sendAlert, 20000 + Math.random() * 10000);
  };
  setTimeout(sendAlert, 8000);
});
client.on('error', e => console.warn('[sim] error:', e.message));
