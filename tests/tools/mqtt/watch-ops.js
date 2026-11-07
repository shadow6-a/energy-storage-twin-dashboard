/* 测试夹具：监听 ess/ops 处置回写，结果写入 server/_probe.log
   用法：node tests/tools/mqtt/watch-ops.js [mqttUrl] [topic] [seconds] */
'use strict';
const fs = require('fs');
const path = require('path');
const { createClient } = require(path.join(__dirname, '../../../server/mqtt'));

const url = process.argv[2] || 'mqtt://broker.emqx.io:1883';
const topic = process.argv[3] || 'ess/ops';
const secs = parseInt(process.argv[4] || '8', 10);
const log = path.join(__dirname, '../../../server/_probe.log');

const c = createClient({ url, clientId: 'fixture-watch-' + Math.random().toString(16).slice(2, 8) });
c.on('connect', () => c.subscribe([topic]));
c.on('message', (t, b) => fs.appendFileSync(log, t + ' ' + b.toString('utf8') + '\n'));
setTimeout(() => { c.end(); process.exit(0); }, secs * 1000);
