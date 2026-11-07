/* ============================================================
   最小 MQTT 3.1.1 客户端（零依赖，Node net 直连）
   ------------------------------------------------------------
   只实现桥接需要的子集：
     CONNECT/CONNACK · SUBSCRIBE/SUBACK · PUBLISH(QoS0 收发) · PINGREQ/PINGRESP · DISCONNECT
   QoS1/2、遗嘱、TLS 不支持（内网采集网关 99% 用 QoS0 遥测；需要 TLS 时套 tls.connect）。
   用法：
     const c = createClient({ url: 'mqtt://broker.emqx.io:1883', clientId: 'x' });
     c.on('connect', () => c.subscribe(['ess/#']));
     c.on('message', (topic, buf) => ...);
     c.publish('ess/scada', JSON.stringify(obj));
   ============================================================ */
'use strict';

const net = require('net');

/* ---- 可变长度整数（MQTT Remaining Length） ---- */
function encodeLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

function decodeLen(buf, offset) {
  let mult = 1, value = 0, i = offset, b;
  for (;;) {
    if (i >= buf.length) return null;            /* 包头不完整，等下一批数据 */
    b = buf[i++];
    value += (b & 0x7f) * mult;
    if ((b & 0x80) === 0) break;
    mult *= 128;
    if (mult > 128 * 128 * 128) return null;
  }
  return { value, bytes: i - offset };
}

function utf8(str) {
  const b = Buffer.from(str, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length, 0);
  return Buffer.concat([len, b]);
}

/* ---- 报文构造 ---- */
function pkt(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLen(body.length), body]);
}

function buildConnect(opts) {
  const ka = Buffer.alloc(2); ka.writeUInt16BE(opts.keepalive || 60, 0);
  let flags = 0x02;                               /* clean session */
  if (opts.username) flags |= 0x80;
  if (opts.password) flags |= 0x40;
  const parts = [utf8('MQTT'), Buffer.from([4, flags]), ka, utf8(opts.clientId)];
  if (opts.username) parts.push(utf8(opts.username));
  if (opts.password) parts.push(utf8(opts.password));
  return pkt(1, 0, Buffer.concat(parts));
}

function buildSubscribe(id, filters) {
  const parts = [Buffer.from([(id >> 8) & 0xff, id & 0xff])];
  filters.forEach(f => { parts.push(utf8(f)); parts.push(Buffer.from([0])); });   /* QoS0 */
  return pkt(8, 0x02, Buffer.concat(parts));
}

function buildPublish(topic, payload, retain) {
  const body = Buffer.concat([utf8(topic), Buffer.from(payload)]);
  return pkt(3, retain ? 0x01 : 0x00, body);
}

/* ---- 客户端 ---- */
function createClient(opts) {
  const url = new URL(opts.url || 'mqtt://127.0.0.1:1883');
  const host = url.hostname;
  const port = parseInt(url.port || '1883', 10);
  const clientId = opts.clientId || ('ess-twin-' + Math.random().toString(16).slice(2, 10));
  const keepalive = opts.keepalive || 60;
  const handlers = { connect: [], message: [], error: [], close: [] };
  const api = {
    connected: false,
    on(ev, fn) { (handlers[ev] || (handlers[ev] = [])).push(fn); return api; },
    emit(ev, ...a) { (handlers[ev] || []).forEach(f => { try { f(...a); } catch (e) { console.error('[mqtt] handler err', e.message); } }); }
  };

  let sock = null, buf = Buffer.alloc(0), pid = 1;
  let filters = [];
  let retry = 0, timer = null, pingTimer = null, dead = false;
  let suppressUntil = 0;                          /* 混沌演练：drop(ms) 后抑制重连至该时刻 */

  function send(b) { if (sock && !sock.destroyed) sock.write(b); }

  function connect() {
    if (dead) return;
    sock = net.connect(port, host);
    sock.setNoDelay(true);
    sock.on('connect', () => {
      retry = 0;
      send(buildConnect({ clientId, keepalive, username: opts.username, password: opts.password }));
    });
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) break;
        const head = buf[0], type = head >> 4;
        const l = decodeLen(buf, 1);
        if (!l) break;
        const total = 1 + l.bytes + l.value;
        if (buf.length < total) break;
        const body = buf.slice(1 + l.bytes, total);
        buf = buf.slice(total);
        onPacket(type, head & 0x0f, body);
      }
    });
    sock.on('error', e => api.emit('error', e));
    sock.on('close', () => {
      api.connected = false;
      clearInterval(pingTimer);
      api.emit('close');
      if (!dead) {
        const backoff = Math.min(30000, 1000 * Math.pow(2, retry++));   /* 指数退避，30s 封顶 */
        const suppressed = Math.max(0, suppressUntil - Date.now());      /* 混沌窗口未结束则延后重连 */
        timer = setTimeout(connect, backoff + suppressed);
      }
    });
  }

  function onPacket(type, flags, body) {
    if (type === 2) {                                   /* CONNACK */
      const rc = body[1];
      if (rc !== 0) { api.emit('error', new Error('CONNACK rc=' + rc)); sock.destroy(); return; }
      api.connected = true;
      api.emit('connect');
      if (filters.length) api.subscribe(filters);
      pingTimer = setInterval(() => send(Buffer.from([0xc0, 0x00])), keepalive * 500);
    } else if (type === 3) {                            /* PUBLISH */
      const qos = (flags >> 1) & 0x03;
      const tlen = body.readUInt16BE(0);
      const topic = body.slice(2, 2 + tlen).toString('utf8');
      let off = 2 + tlen;
      if (qos > 0) off += 2;                            /* packetId */
      api.emit('message', topic, body.slice(off));
      if (qos === 1) { /* 未订阅 QoS1，保守回 PUBACK */ }
    } else if (type === 9) {                            /* SUBACK */
      api.emit('suback', body.slice(2));
    } else if (type === 13) {                           /* PINGRESP：链路存活 */
      api.lastPong = Date.now();
    }
  }

  api.subscribe = list => {
    filters = list;
    if (!api.connected) return api;
    send(buildSubscribe(pid++ & 0xffff, list));
    return api;
  };
  api.publish = (topic, payload, o) => {
    send(buildPublish(topic, Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'), !!(o && o.retain)));
    return api;
  };
  /* 混沌演练原语：强拆 TCP（不清 dead 标志，close→退避重连），ms>0 时抑制重连至窗口结束 */
  api.drop = ms => {
    suppressUntil = Date.now() + (ms || 0);
    if (sock && !sock.destroyed) sock.destroy();
    return api;
  };
  api.end = () => {
    dead = true;
    clearTimeout(timer); clearInterval(pingTimer);
    if (api.connected) send(Buffer.from([0xe0, 0x00]));
    if (sock) sock.destroy();
  };

  connect();
  return api;
}

module.exports = { createClient };
