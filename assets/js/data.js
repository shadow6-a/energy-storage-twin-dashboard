/* ============================================================
   模拟数据层（生产环境替换为 WebSocket / REST 数据源）
   ============================================================ */
(function (global) {
  'use strict';

  const STATIONS = [
    { id:'S01', name:'无锡锡山储能站', short:'无锡锡山', x:200, z:-60, cap:200, mw:100, type:'独立储能', soc:62.4, soh:95.8, temp:29.4, cabins:6, status:'discharging', comm:'online' },
    { id:'S02', name:'苏州吴江储能站', short:'苏州吴江', x:380, z:40,  cap:180, mw:90,  type:'电网侧',   soc:58.7, soh:94.2, temp:31.2, cabins:5, status:'discharging', comm:'online' },
    { id:'S03', name:'常州金坛储能站', short:'常州金坛', x:30,  z:-30, cap:160, mw:80,  type:'风光配套', soc:71.2, soh:93.6, temp:33.8, cabins:5, status:'charging',     comm:'online' },
    { id:'S04', name:'南京江北储能站', short:'南京江北', x:-340, z:-120, cap:200, mw:100, type:'独立储能', soc:66.8, soh:96.1, temp:27.6, cabins:6, status:'standby',    comm:'online' },
    { id:'S05', name:'镇江扬中储能站', short:'镇江扬中', x:-140, z:-180, cap:120, mw:60, type:'用户侧',   soc:54.3, soh:92.4, temp:30.1, cabins:4, status:'discharging', comm:'online' },
    { id:'S06', name:'南通如东储能站', short:'南通如东', x:400, z:-250, cap:100, mw:50, type:'风光配套', soc:48.6, soh:89.7, temp:35.2, cabins:3, status:'offline',     comm:'offline' },
    { id:'S07', name:'扬州仪征储能站', short:'扬州仪征', x:-190, z:90, cap:140, mw:70, type:'独立储能', soc:69.5, soh:95.1, temp:28.8, cabins:4, status:'charging',     comm:'online' },
    { id:'S08', name:'泰州靖江储能站', short:'泰州靖江', x:210, z:170, cap:140, mw:70, type:'电网侧',   soc:61.9, soh:94.8, temp:29.9, cabins:4, status:'discharging', comm:'online' }
  ];

  const ALERTS = [
    { id:'A001', lv:'crit', lvName:'紧急', status:0, st:'S01', dev:'2#电池舱 / 电池簇 C-07', text:'单体电压极差 320mV，超阈值 200mV，持续 6 分钟', time:'14:02', age:26 },
    { id:'A002', lv:'crit', lvName:'紧急', status:1, st:'S02', dev:'PCS-3', text:'直流侧过流保护动作，已自动限功率至 40% 运行', time:'13:47', age:41 },
    { id:'A003', lv:'high', lvName:'重要', status:0, st:'S03', dev:'1#电池舱 / 液冷机组', text:'冷却液出水温度 32.8℃，超告警阈值 30℃', time:'13:30', age:58 },
    { id:'A004', lv:'high', lvName:'重要', status:0, st:'S01', dev:'并网点 / 计量单元', text:'功率因数 0.92，低于考核下限 0.95，需调整无功出力', time:'13:22', age:66 },
    { id:'A005', lv:'high', lvName:'重要', status:1, st:'S04', dev:'BMS 通信网关', text:'通信丢包率 3.2%，已持续 5 分钟，链路自动重连 2 次', time:'12:58', age:90 },
    { id:'A006', lv:'high', lvName:'重要', status:0, st:'S06', dev:'站控层 / 远动通道', text:'站控与调度主站通信中断，已切换就地控制策略', time:'12:41', age:107 },
    { id:'A007', lv:'warn', lvName:'一般', status:0, st:'S02', dev:'2#电池舱 / 空调', text:'回风温度 31.4℃ 偏高，制冷量不足预警', time:'12:20', age:128 },
    { id:'A008', lv:'warn', lvName:'一般', status:3, st:'S06', dev:'消防主机', text:'自检提示：3 号探测器灵敏度漂移（已抑制至检修窗口）', time:'11:55', age:153 },
    { id:'A009', lv:'warn', lvName:'一般', status:2, st:'S05', dev:'电池簇 C-12', text:'SOC 校准偏差 4.6%，已执行满充满放重校并闭环', time:'10:32', age:236 },
    { id:'A010', lv:'info', lvName:'提示', status:1, st:'S08', dev:'站用电系统', text:'站用电已切换至备用回路，供电正常', time:'09:48', age:280 }
  ];

  const STATUS_TEXT = { 0:'未确认', 1:'已确认', 2:'已闭环', 3:'已抑制' };

  /* ---------------- 集群功率计划（正=放电上网，负=充电） ---------------- */
  const PLAN_PTS = [
    [0,-110],[5.5,-110],[7,-20],[8.5,128],[10.5,150],[11.5,80],
    [13,-40],[16,0],[17.5,168],[20,176],[21.5,30],[23,-58],[24,-110]
  ];

  function smoothstep(t){ return t * t * (3 - 2 * t); }

  function planAt(h) {
    h = ((h % 24) + 24) % 24;
    if (h >= 24) return -110;
    for (let i = 0; i < PLAN_PTS.length - 1; i++) {
      const a = PLAN_PTS[i], b = PLAN_PTS[i + 1];
      if (h >= a[0] && h <= b[0]) {
        const t = (h - a[0]) / (b[0] - a[0] || 1);
        return a[1] + (b[1] - a[1]) * smoothstep(t);
      }
    }
    return -110;
  }

  function mulberry(seed) {
    let s = seed >>> 0;
    return function () {
      s += 0x6D2B79F5; let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashCode(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  const TOTAL_CAP = STATIONS.reduce((a, s) => a + s.cap, 0);

  function stationById(id) { return STATIONS.find(s => s.id === id) || null; }

  function alertsOf(id) { return ALERTS.filter(a => a.st === id); }

  /* ---------------- 24h 曲线 ---------------- */
  function nowHours() {
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60;
  }

  function buildSeries(scope) {
    const cap = scope ? scope.cap : TOTAL_CAP;
    const share = scope ? scope.mw / 620 : 1;
    const rand = mulberry(scope ? hashCode(scope.id) : 7);
    const n = 96;
    const labels = [], plan = [], actual = [], soc = [], socPlan = [];
    const nowH = nowHours();
    const nowIdx = nowH * 4;

    let s = scope ? Math.max(18, scope.soc - 8) : 46;
    let sp = s;

    for (let i = 0; i < n; i++) {
      const h = i * 0.25 + 0.125;
      const p = planAt(h) * share;
      labels.push(h);
      plan.push(+p.toFixed(2));

      // 实际：截止当前时刻，含轻微偏差与噪声
      if (i < nowIdx) {
        const bias = scope ? 1 : 0.985;
        actual.push(+(p * bias + (rand() - 0.5) * 9 + Math.sin(i / 7) * 2.4).toFixed(2));
      } else if (i === Math.floor(nowIdx)) {
        actual.push(+(p * 0.9).toFixed(2));
      } else {
        actual.push(null);
      }

      // SOC 推演（按容量积分）
      const dSoc = (-p * 0.25 / cap) * 100;
      s = Math.max(8, Math.min(96, s + dSoc));
      soc.push(+s.toFixed(1));
      sp = Math.max(20, Math.min(90, sp + dSoc * 0.92));
      socPlan.push(+sp.toFixed(1));
    }
    return { labels, plan, actual, soc, socPlan, nowIdx };
  }

  /* ---------------- 舱 / 簇 ---------------- */
  function cabinCount(st) { return st.cabins; }

  function cabinOf(stId, idx) {
    const st = stationById(stId);
    if (!st) return null;
    const rnd = mulberry(hashCode(stId + 'cab' + idx));
    // 告警舱：与告警台账联动（锡山 2#舱 C-07）
    const isAlertCabin = stId === 'S01' && idx === 1;
    const clusters = [];
    for (let i = 0; i < 12; i++) {
      const r2 = mulberry(hashCode(stId + 'cl' + idx + '-' + i));
      const base = st.soc + (rnd() - 0.5) * 9;
      clusters.push({
        id: 'C-' + String(i + 1).padStart(2, '0'),
        soc: +(Math.max(6, Math.min(98, base + (r2() - 0.5) * 7))).toFixed(1),
        soh: +(Math.max(80, st.soh + (rnd() - 0.5) * 4)).toFixed(1),
        temp: +(st.temp + (rnd() - 0.5) * 5 + (isAlertCabin && i === 6 ? 4.2 : 0)).toFixed(1),
        voltDiff: +(8 + r2() * 34 + (isAlertCabin && i === 6 ? 260 : 0)).toFixed(0),
        current: +(r2() * 60 + 20).toFixed(1),
        status: isAlertCabin && i === 6 ? 'warn' : 'ok'
      });
    }
    return {
      id: 'CAB-' + String(idx + 1).padStart(2, '0'),
      idx,
      name: (idx + 1) + '#电池舱',
      stationId: stId,
      warn: isAlertCabin,
      soc: +(st.soc + (rnd() - 0.5) * 6).toFixed(1),
      soh: +(st.soh - rnd() * 1.6).toFixed(1),
      temp: +(st.temp + (rnd() - 0.5) * 2 + (isAlertCabin ? 1.8 : 0)).toFixed(1),
      clusters
    };
  }

  function clusterOf(stId, cabinIdx, clusterId) {
    const cab = cabinOf(stId, cabinIdx);
    const cl = cab.clusters.find(c => c.id === clusterId) || cab.clusters[0];
    const rnd = mulberry(hashCode(stId + clusterId + cabinIdx));
    const cells = [];
    const base = 3.32;
    for (let i = 0; i < 32; i++) {
      const v = base + (rnd() - 0.5) * 0.05 - (i / 32) * 0.006;
      cells.push({
        idx: i + 1,
        v: +v.toFixed(3),
        t: +(cl.temp + (rnd() - 0.5) * 3.6).toFixed(1)
      });
    }
    return {
      ...cl,
      cabin: cab,
      cells,
      vMax: Math.max(...cells.map(c => c.v)),
      vMin: Math.min(...cells.map(c => c.v)),
      insulation: +(2 + rnd() * 8).toFixed(1),
      cycleCount: Math.round(820 + rnd() * 620)
    };
  }

  /* ---------------- 聚合 ---------------- */
  function aggregate() {
    let socSum = 0, sohSum = 0, wSum = 0;
    STATIONS.forEach(s => { socSum += s.soc * s.cap; sohSum += s.soh * s.cap; wSum += s.cap; });
    return { soc: socSum / wSum, soh: sohSum / wSum };
  }

  function todayEnergy(scope) {
    const share = scope ? scope.mw / 620 : 1;
    const cap = scope ? scope.cap : TOTAL_CAP;
    const nowH = nowHours();
    let ch = 0, dis = 0;
    for (let h = 0; h < nowH; h += 0.25) {
      const p = planAt(h + 0.125) * share;
      if (p < 0) ch += -p * 0.25; else dis += p * 0.25;
    }
    return { charge: ch, discharge: dis, revenue: dis * 0.62 + ch * 0.06 + 0.9 };
  }

  function healthBuckets(scope) {
    const stations = scope ? [scope] : STATIONS;
    let excellent = 0, good = 0, attention = 0, risk = 0;
    stations.forEach(st => {
      for (let c = 0; c < st.cabins; c++) {
        const cab = cabinOf(st.id, c);
        cab.clusters.forEach(cl => {
          if (cl.soh >= 95) excellent++;
          else if (cl.soh >= 92) good++;
          else if (cl.soh >= 88) attention++;
          else risk++;
        });
      }
    });
    return [
      { label:'优 ≥95%', value:excellent, color:'#3ea87b' },
      { label:'良 92–95%', value:good, color:'#3fb6c9' },
      { label:'关注 88–92%', value:attention, color:'#d8b24a' },
      { label:'预警 <88%', value:risk, color:'#e0523f' }
    ];
  }

  function tempByStation() {
    return STATIONS.map(s => ({ label:s.short.replace('储能站',''), value:s.temp, id:s.id }));
  }

  function hm(h) {
    const hh = Math.floor(h) % 24;
    const mm = Math.round((h - Math.floor(h)) * 60);
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  function statusOf(st) {
    if (st.comm === 'offline') return { key:'offline', text:'离线', cls:'offline' };
    const a = ALERTS.some(x => x.st === st.id && x.status === 0 && (x.lv === 'crit'));
    if (a) return { key:'alert', text:'告警', cls:'alert' };
    if (st.status === 'charging') return { key:'charging', text:'充电中', cls:'dis' };
    if (st.status === 'discharging') return { key:'discharging', text:'放电中', cls:'dis' };
    return { key:'standby', text:'待机', cls:'' };
  }

  /* ================= 模拟 WebSocket 数据源（v1.2） =================
     与视图层解耦的事件推送通道：真实接入时把 MockWS 换成原生 WebSocket，
     消费端（app.js connectLive）零改动——消息协议即接口边界。
     URL ?ws=mock 启用；hz=推送频率(默认2Hz)；chaos=1 附加随机告警流（压测用）。 */
  class MockWS {
    constructor(hz, chaos) {
      this.hz = hz || 2;
      this.chaos = !!chaos;
      this.readyState = 0; // CONNECTING
      this.onmessage = null;
      this.onclose = null;
      this._timers = [];
    }
    /* 模拟建连：300ms 后 OPEN，开始周期推送 SCADA 帧（soc 微抖动 + 功率漂移） */
    connect() {
      this._timers.push(setTimeout(() => {
        this.readyState = 1; // OPEN
        this._timers.push(setInterval(() => this._scadaFrame(), Math.round(1000 / this.hz)));
        if (this.chaos) this._timers.push(setInterval(() => this._chaosAlert(), 2000));
      }, 300));
      return this;
    }
    _emit(msg) { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
    _scadaFrame() {
      // 全站一帧：SOC 慢速随机游走（±0.3%）、功率漂移（±8%），贴近 SCADA 高频小幅特征
      // 源只发消息不写模型——消费端（app.js connectLive）按消息协议写 DATA，保证真实/模拟可替换
      const nowH = nowHours(), base = planAt(nowH);
      STATIONS.forEach(st => {
        const soc = Math.round(clamp(st.soc + (Math.random() - 0.48) * 0.6, 5, 100) * 10) / 10;
        const power = Math.round((base + (Math.random() - 0.5) * base * 0.16) * 10) / 10;
        this._emit({ t: 'scada', id: st.id, soc, power });
      });
    }
    _chaosAlert() {
      // 压测：随机站点插入一条告警（高频告警场景），10s 后自动闭环
      const st = STATIONS[Math.floor(Math.random() * STATIONS.length)];
      const lv = ['crit', 'high', 'warn', 'info'][Math.floor(Math.random() * 4)];
      const id = 'WS' + Date.now().toString(36);
      this._emit({ t: 'alert', id, st: st.id, lv, dev: 'BMS', text: st.short + ' 模拟推送告警（压测流）', age: 0 });
      this._timers.push(setTimeout(() => this._emit({ t: 'alertAck', id }), 10000));
    }
    close() { this._timers.forEach(t => { clearTimeout(t); clearInterval(t); }); this.readyState = 3; if (this.onclose) this.onclose(); }
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  global.DATA = {
    STATIONS, ALERTS, STATUS_TEXT, TOTAL_CAP,
    stationById, alertsOf, planAt, buildSeries, cabinOf, clusterOf, cabinCount,
    aggregate, todayEnergy, healthBuckets, tempByStation, hm, statusOf,
    mulberry, hashCode, nowHours,
    MockWS /* v1.2：模拟 WS 适配器（真实接入替换点） */
  };
})(window);
