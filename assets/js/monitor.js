/* 前端遥测（工程化 v2.2）：FPS / Heap / WS 重连 / 数据新鲜度
   - rAF 采样每秒帧数；performance.memory 仅 Chromium 提供，缺失报 0
   - 每 10s 经 DataIO.send({t:'telemetry',...}) 上报，桥接聚合进 /metrics
   - lastDataAge：距最近一次收到 scada 帧的秒数（数据源断流即可见）
   - 零依赖、零 DOM 副作用；失败静默（演示页无后端也能跑） */
(function (global) {
  'use strict';

  const T = { fps: 0, heapMB: 0, reconnects: 0, lastDataAge: 0, _frames: 0, _t0: 0 };

  function loop(ts) {
    T._frames++;
    if (!T._t0) T._t0 = ts;
    if (ts - T._t0 >= 1000) {
      T.fps = Math.round(T._frames * 1000 / (ts - T._t0));
      T._frames = 0; T._t0 = ts;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function sampleHeap() {
    if (global.performance && performance.memory && performance.memory.usedJSHeapSize) {
      T.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10;
    }
  }

  function report() {
    sampleHeap();
    const s = (global.DataIO && global.DataIO.status) ? global.DataIO.status() : {};
    T.reconnects = s.reconnects || 0;
    T.lastDataAge = s.lastDataTs ? Math.round((Date.now() - s.lastDataTs) / 1000) : -1;
    global.DataIO.send({
      t: 'telemetry',
      fps: T.fps,
      heapMB: T.heapMB,
      reconnects: T.reconnects,
      lastDataAge: T.lastDataAge,
      ua: (navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/) || ['unknown'])[0],
      ts: Date.now()
    });
  }

  global.Monitor = {
    snapshot() { sampleHeap(); return Object.assign({}, T); },
    start(intervalMs) { setInterval(report, intervalMs || 10000); report(); }
  };
})(window);
