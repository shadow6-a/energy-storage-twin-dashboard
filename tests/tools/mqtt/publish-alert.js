/* 测试夹具：模拟第三方系统向 broker 发一条告警
   用法：node tests/tools/mqtt/publish-alert.js [mqttUrl] [topic] */
'use strict';
const path = require('path');
const { createClient } = require(path.join(__dirname, '../../../server/mqtt'));

const url = process.argv[2] || 'mqtt://broker.emqx.io:1883';
const topic = process.argv[3] || 'ess/alert';
const c = createClient({ url, clientId: 'fixture-pub-' + Math.random().toString(16).slice(2, 8) });
c.on('connect', () => {
  c.publish(topic, JSON.stringify({
    t: 'alert', id: 'MQ-TEST-01', lv: 'crit', st: 'S01',
    dev: '2#电池舱 / 电池簇 C-07', text: 'MQTT 端到端验证：单体压差 340mV 超限'
  }));
  console.log('published alert MQ-TEST-01 ->', topic);
  setTimeout(() => { c.end(); process.exit(0); }, 800);
});
c.on('error', e => { console.error(e.message); process.exit(1); });
