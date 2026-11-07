/* ============================================================
   DataIO——真实数据链路客户端（v2.0，纯原生零依赖）
   ------------------------------------------------------------
   职责：
   1. WebSocket 连接管理：指数退避重连 / 心跳 / 页面离线事件
   2. 消息协议 v2 解析（见 docs/data-contract.md），兼容 v1 单站 scada 帧
   3. 数据落到 DATA.*（与 data.js 同一契约），UI 消费逻辑零改动
   4. 处置回写：确认/闭环/撤销 → {t:'op'} 帧（桥接服务落盘/转发 EMS）
   5. 状态汇报：DataIO.status() 供顶栏链路角标使用

   设计边界：
   - 不做 UI 渲染；不持有业务状态（告警/站点仍在 DATA）
   - 断线不弹窗，只降级为「演示数据」并持续静默重连
   - 所有帧解析失败一律丢弃（计数），绝不让坏帧打断渲染循环
   ============================================================ */
(function (global) {
  'use strict';

  const cfg = Object.assign(
    { source: 'mock', url: 'ws://127.0.0.1:9001/ws', heartbeatSec: 25, backoffMaxSec: 30 },
    global.DATA_CONFIG || {}
  );

  const state = {
    mode: 'off',            /* off | mock | ws */
    ws: null,
    connected: false,
    attempts: 0,            /* 当前连续重连次数（退避依据） */
    lastMsgAt: 0,
    msgCount: 0,
    badFrames: 0,
    history: new Map(),     /* stId -> buildSeries 形状的覆盖数据 */
    clusters: new Map(),    /* 'S01|1|C-07' -> 簇覆盖数据 */
    hooks: {},
    hbTimer: null,
    hbMiss: 0,
    retryTimer: null,
    closedByUs: false
  };

  function backoffSec() {
    return Math.min(cfg.backoffMaxSec, Math.round(Math.pow(2, Math.min(state.attempts, 5)) / 2) || 1);
  }

  function setStatus(patch) {
    Object.assign(state, patch);
    if (state.hooks.onStatus) { try { state.hooks.onStatus(status()); } catch (e) { /* 渲染异常不影响链路 */ } }
  }

  function status() {
    return {
      mode: state.mode,
      connected: state.connected,
      attempts: state.attempts,
      nextRetrySec: state.connected || state.mode !== 'ws' ? 0 : backoffSec(),
      lastMsgAt: state.lastMsgAt,
      msgCount: state.msgCount,
      badFrames: state.badFrames
    };
  }

  /* ---------------- 连接管理 ---------------- */

  function connect(url) {
    if (state.ws) { state.closedByUs = true; try { state.ws.close(); } catch (e) { /* noop */ } }
    state.closedByUs = false;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { scheduleRetry(); return; }
    state.ws = ws;

    ws.onopen = () => {
      state.attempts = 0;
      setStatus({ connected: true });
      startHeartbeat();
    };
    ws.onmessage = ev => {
      state.lastMsgAt = Date.now();
      state.msgCount++;
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { state.badFrames++; return; }
      if (!m || typeof m.t !== 'string') { state.badFrames++; return; }
      dispatch(m);
    };
    ws.onclose = () => {
      stopHeartbeat();
      setStatus({ connected: false });
      if (!state.closedByUs && state.mode === 'ws') scheduleRetry();
    };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* noop */ } };
  }

  function scheduleRetry() {
    if (state.retryTimer || state.mode !== 'ws') return;
    state.attempts++;
    const wait = backoffSec() * 1000;
    setStatus({});
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (state.mode === 'ws') connect(cfg.url);
    }, wait);
  }

  function startHeartbeat() {
    stopHeartbeat();
    state.hbMiss = 0;
    state.hbTimer = setInterval(() => {
      if (!state.ws || state.ws.readyState !== 1) return;
      if (state.hbMiss >= 2) { try { state.ws.close(); } catch (e) { /* noop */ } return; }
      try { state.ws.send(JSON.stringify({ t: 'ping', ts: Date.now() })); state.hbMiss++; } catch (e) { /* noop */ }
    }, cfg.heartbeatSec * 1000);
  }

  function stopHeartbeat() { clearInterval(state.hbTimer); state.hbTimer = null; }

  /* 服务端对 ping 回 {t:'pong'} 或协议层 pong 都算活 */
  global.addEventListener('online', () => { if (state.mode === 'ws' && !state.connected) { state.attempts = 0; connect(cfg.url); } });
  global.addEventListener('offline', () => { if (state.ws) { state.closedByUs = true; try { state.ws.close(); } catch (e) { /* noop */ } } });

  /* ---------------- 协议分发（v2，兼容 v1） ---------------- */

  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  function dispatch(m) {
    const H = state.hooks;
    switch (m.t) {
      case 'ping': send({ t: 'pong', ts: m.ts }); return;
      case 'pong': state.hbMiss = 0; return;
      case 'hello':
        state.attempts = 0;
        setStatus({});
        if (H.onHello) H.onHello(m);
        return;
      case 'scada':
        /* v2 批量帧：{t:'scada', ts, stations:[{id,power,soc,soh,temp,status,comm}]}
           v1 单站帧：{t:'scada', id, soc, power} */
        if (Array.isArray(m.stations)) H.onScada(m.stations, m.ts);
        else if (m.id) H.onScada([{ id: m.id, power: num(m.power, 0), soc: num(m.soc, 0) }], m.ts);
        return;
      case 'alert':
        if (m.alert && m.alert.id && H.onAlert) H.onAlert(m.alert);
        return;
      case 'alertState':
        if (m.id && H.onAlertState) H.onAlertState(m);
        return;
      case 'history':
        if (m.st && m.plan) {
          state.history.set(m.st, {
            labels: m.labels, plan: m.plan, actual: m.actual,
            soc: m.soc, socPlan: m.socPlan || m.soc,
            nowIdx: typeof m.nowIdx === 'number' ? m.nowIdx : (m.actual ? m.actual.lastIndexOf(v => v !== null && v !== undefined) : 0),
            live: true
          });
          if (H.onHistory) H.onHistory(m.st);
        }
        return;
      case 'cluster':
        if (m.st && m.cluster) {
          state.clusters.set(m.st + '|' + (m.cabin || 0) + '|' + m.cluster, m.data || m.cluster);
          if (H.onCluster) H.onCluster(m.st, m.cabin, m.cluster);
        }
        return;
      default: state.badFrames++; return;
    }
  }

  /* ---------------- 对外 API ---------------- */

  /* 初始化并按配置连接。
     hooks: {onScada,onAlert,onAlertState,onHistory,onCluster,onHello,onStatus}
     opts:  缺省按 config.js（source/url）；显式传 {mode:'ws', url} 可覆盖（URL 参数 ?ws= 路径） */
  function init(hooks, opts) {
    state.hooks = hooks || {};
    if (state.mode === 'ws') return status();           /* 幂等：重复 init 不重复建连 */
    const o = opts || {};
    const wantWs = o.mode ? o.mode === 'ws' : cfg.source === 'ws';
    const url = o.url || cfg.url;
    if (wantWs && /^wss?:\/\//.test(url)) {
      state.mode = 'ws';
      setStatus({});
      connect(url);
    } else {
      state.mode = 'off';
      setStatus({});
    }
    return status();
  }

  /* 供 ?ws=mock 演示路径复用（mode=mock：不做连接管理，只走消费函数） */
  function setModeMock() { state.mode = 'mock'; setStatus({}); }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) {
      try { state.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }
    return false;
  }

  /* 处置回写：action ∈ ack|close|undo；ids 为告警 id 数组。断线时静默丢弃（审计仍留本地） */
  function sendOp(action, ids, by) {
    return send({ t: 'op', action, ids: Array.isArray(ids) ? ids : [ids], by: by || 'web', ts: Date.now() });
  }

  function historyFor(stId) {
    const h = state.history.get(stId);
    return h && h.plan && h.plan.length ? h : null;
  }

  function clusterFor(stId, cabinIdx, clusterId) {
    return state.clusters.get(stId + '|' + cabinIdx + '|' + clusterId) || null;
  }

  global.DataIO = { init, status, sendOp, send, historyFor, clusterFor, setModeMock };
})(window);
