/* ============================================================
   应用编排：状态 / 渲染 / 下钻 / 告警闭环 / 策略下发
   ============================================================ */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad2 = n => String(n).padStart(2, '0');
  const fmt = (v, d) => Number(v).toFixed(d === undefined ? 1 : d);

  const STRATEGY = {
    peak: {
      name: '削峰填谷', factor: 1,
      window: '低谷充电 23:30–06:30 / 晚峰放电 17:30–21:00',
      note: '按分时电价两充两放，SOC 保持 15%–95%'
    },
    freq: {
      name: '调频响应', factor: 0.55,
      window: 'AGC 调频里程 1,860 MW · 响应死区 ±2 MW',
      note: '预留 55% 调节容量，优先跟踪调度 AGC 指令'
    },
    reserve: {
      name: '自主备用', factor: 0.28,
      window: '离网备电 30 min · SOC 维持 55%–65%',
      note: '降低吞吐，保障重要负荷后备容量'
    }
  };

  const state = {
    level: 0,
    stationId: null,
    cabinIndex: null,
    clusterId: null,
    strategy: 'peak',
    linkDown: false,
    paused: false,
    role: 'admin',
    stationFilter: 'all',
    alertFilter: 'open',
    alertLimit: 5,
    chartTab: 'power',
    layers: { alert: true, link: true, label: true },
    topView: false,
    transitioning: false,
    focusing: false,
    tickCount: 0,
    /* v1.3：告警批量处置（多选态 + 已勾选集合） */
    batch: false,
    picked: new Set()
  };

  let twin = null;
  /* v1.1.1：Space 手动暂停实时刷新（值守场景键盘流快捷键） */
  /* 动效默认轻量化（v0.9.4）：脉冲扩散/链路流光默认关（静态描边），
     仅保留告警红点与静态圈；演示需要动效时经导览「性能轻量化」开关恢复 */
  const FX_DEFAULT_LITE = true;

  /* ================= 异常态演示场景 ================= */
  const SCENARIOS = {
    offline: {
      label: '异常演示 · 全站通信中断',
      apply() {
        DATA.STATIONS.forEach(s => { s.comm = 'offline'; });
        DATA.ALERTS.push(
          { id: 'A011', st: 'S01', lv: 'crit', lvName: '紧急', text: '调度主站通信中断，全站进入就地运行模式', dev: 'EMS 网关', age: 4, status: 0 },
          { id: 'A012', st: 'S04', lv: 'crit', lvName: '紧急', text: '调度主站通信中断，全站进入就地运行模式', dev: 'EMS 网关', age: 4, status: 0 },
          { id: 'A013', st: 'S06', lv: 'high', lvName: '重要', text: '站控遥测数据停止刷新，疑似网关掉电', dev: '站控主机', age: 12, status: 1 }
        );
      }
    },
    multi: {
      label: '异常演示 · 多告警并发（含抑制冲突）',
      apply() {
        DATA.ALERTS.push(
          { id: 'A011', st: 'S02', lv: 'crit', lvName: '紧急', text: 'PCS-2 直流过流保护动作，全站闭锁', dev: 'PCS-2', age: 3, status: 0 },
          { id: 'A012', st: 'S05', lv: 'high', lvName: '重要', text: '3#电池簇绝缘电阻降至 280Ω，低于告警阈值', dev: '3#电池舱', age: 6, status: 0 },
          { id: 'A013', st: 'S07', lv: 'crit', lvName: '紧急', text: '消防主机通信中断，消防联动策略失效', dev: '消防主机', age: 9, status: 1 },
          { id: 'A014', st: 'S03', lv: 'warn', lvName: '一般', text: '空调回风温度 31.2℃ 持续偏高（已抑制）', dev: '站用变', age: 30, status: 3 },
          { id: 'A015', st: 'S01', lv: 'warn', lvName: '一般', text: 'C-07 与簇间 SOC 极差 6.8%，一致性劣化（已抑制）', dev: '2#电池舱', age: 45, status: 3 }
        );
      }
    },
    overtemp: {
      label: '异常演示 · 电池簇严重超温',
      apply() {
        const s01 = DATA.stationById('S01');
        if (s01) s01.temp = 41.5;
        DATA.ALERTS.push(
          { id: 'A011', st: 'S01', lv: 'crit', lvName: '紧急', text: 'C-07 单体最高温度 43.8℃，触发二级温控降功率', dev: '2#电池舱 C-07', age: 2, status: 0 },
          { id: 'A012', st: 'S01', lv: 'crit', lvName: '紧急', text: '2#电池舱烟感预动作，消防联动待命', dev: '2#电池舱', age: 2, status: 0 },
          { id: 'A013', st: 'S01', lv: 'high', lvName: '重要', text: '液冷机组压缩机高频告警，制冷量下降 40%', dev: '液冷机组', age: 8, status: 1 }
        );
      }
    }
  };

  function applyScenarioFromURL() {
    const name = new URLSearchParams(location.search).get('anomaly');
    state.scenario = name || '';
    if (!name || !SCENARIOS[name]) return;
    SCENARIOS[name].apply();
    const tag = $('#scenarioTag');
    if (tag) {
      tag.textContent = SCENARIOS[name].label;
      tag.hidden = false;
    }
    setTimeout(() => toast(SCENARIOS[name].label + '（演示数据）', 'warn'), 800);
  }

  /* ================= 基础数据刷新 ================= */
  /* v0.9.5 动效自动提权：存在「紧急且未闭环」告警时，仅对应拓扑节点恢复动态脉冲；
     处置（确认/闭环）后自动回落轻量化。全局强制开关仍在演示导览。 */
  function syncCritPulse() {
    if (!twin) return;
    twin.critIds = new Set(DATA.ALERTS.filter(a => a.lv === 'crit' && a.status === 0).map(a => a.st));
  }
  function refreshLive() {
    const nowH = DATA.nowHours();
    const base = DATA.planAt(nowH);
    /* v2.0：实时链路已连接时指标由 scada 帧接管，本地只做派生（告警计数/着色）不再推演 */
    const live = DataIO.status().mode === 'ws' && DataIO.status().connected;
    DATA.STATIONS.forEach((st, i) => {
      const list = DATA.ALERTS.filter(x => x.st === st.id);
      st.openAlerts = list.filter(x => x.status < 2).length;
      st.hasCrit = list.some(x => x.status < 2 && x.lv === 'crit');
      st.totalClusters = st.cabins * 12;
      if (live) return;
      if (st.comm === 'offline') {
        st.power = 0;
        st.status = 'offline';
      } else {
        const jitter = 1 + Math.sin(nowH * 2.4 + i) * 0.035 + (Math.random() - 0.5) * 0.012;
        st.power = +(base * (st.mw / 620) * jitter).toFixed(1);
        st.status = st.power > 3 ? 'discharging' : (st.power < -3 ? 'charging' : 'standby');
      }
      if (st.status === 'charging') st.soc = clamp(st.soc + 0.012, 8, 96);
      else if (st.status === 'discharging') st.soc = clamp(st.soc - 0.015, 8, 96);
    });
    syncCritPulse();
  }

  function buildCabins(st) {
    st.cabinList = [];
    for (let i = 0; i < st.cabins; i++) st.cabinList.push(DATA.cabinOf(st.id, i));
    return st.cabinList;
  }

  const getStation = () => DATA.stationById(state.stationId);
  const getCabin = () => {
    const st = getStation();
    if (!st || !st.cabinList) return null;
    return st.cabinList[state.cabinIndex] || null;
  };
  const getCluster = () => {
    const st = getStation(), cab = getCabin();
    if (!st || !cab || !state.clusterId) return null;
    const cl = DATA.clusterOf(st.id, state.cabinIndex, state.clusterId);
    /* v2.0：实时链路有该簇的推送数据（soc/soh/temp/cells）时覆盖模拟值 */
    const lv = DataIO.clusterFor(st.id, state.cabinIndex, state.clusterId);
    return lv ? Object.assign(cl, lv) : cl;
  };

  function regionPower() {
    return DATA.STATIONS.reduce((a, s) => a + s.power, 0);
  }

  function strategyFactor() {
    return STRATEGY[state.strategy].factor;
  }

  /* ================= 提示 ================= */
  function toast(msg, type) {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s ease, transform .25s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 260);
    }, 2600);
  }

  function timeAgo(min) {
    const d = new Date(Date.now() - min * 60000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ================= 顶部 ================= */
  function renderHeader() {
    const p = regionPower();
    const el = $('#hdrPower');
    el.innerHTML = (p >= 0 ? '+' : '') + fmt(p) + '<i>MW</i>';
    el.style.color = p >= 0 ? '#e8f2fb' : '#7fd0e6';

    const online = DATA.STATIONS.filter(s => s.comm !== 'offline').length;
    $('#hdrComm').innerHTML = online + '/' + DATA.STATIONS.length + '<i>站</i>';
    $('#hdrComm').style.color = online === DATA.STATIONS.length ? '#7fd0b0' : '#eebd85';
  }

  function tickClock() {
    const d = new Date();
    $('#clockTime').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    const wd = '日一二三四五六'[d.getDay()];
    $('#clockDate').textContent = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' 周' + wd;
  }

  /* ================= 左侧：电站 ================= */
  function renderStationFilters() {
    const list = DATA.STATIONS;
    const cAll = list.length;
    const cAlert = list.filter(s => s.openAlerts > 0).length;
    const cOff = list.filter(s => s.comm === 'offline').length;
    $('#stationFilters').innerHTML = `
      <button class="chip ${state.stationFilter === 'all' ? 'is-on' : ''}" data-filter="all" title="全部电站 ${cAll} 座"><span class="t">全部</span><i>${cAll}</i></button>
      <button class="chip ${state.stationFilter === 'alert' ? 'is-on' : ''}" data-filter="alert" title="有未闭环告警的电站 ${cAlert} 座"><span class="t">告警</span><i>${cAlert}</i></button>
      <button class="chip ${state.stationFilter === 'offline' ? 'is-on' : ''}" data-filter="offline" title="通信离线电站 ${cOff} 座"><span class="t">离线</span><i>${cOff}</i></button>`;
  }

  /* SOC 区间分色（v1.1.1）：进度条从「统一色细线」升级为状态信号——低电量红、中黄、健康绿 */
  function socColor(soc) {
    return soc < 20 ? '#e0523f' : soc < 40 ? '#dfab52' : '#3ea87b';
  }

  function renderStations() {
    renderStationFilters();
    const all = DATA.STATIONS;
    let arr = all;
    if (state.stationFilter === 'alert') arr = all.filter(s => s.openAlerts > 0);
    if (state.stationFilter === 'offline') arr = all.filter(s => s.comm === 'offline');

    $('#stationCount').textContent = all.length + ' 座';
    const host = $('#stationList');
    host.innerHTML = arr.map(st => {
      const dotCls = st.hasCrit ? 'alert' : (st.comm === 'offline' ? 'offline' : (st.status === 'charging' ? 'chg' : (st.status === 'discharging' ? 'dis' : '')));
      const on = st.id === state.stationId && state.level > 0 ? ' is-on' : '';
      const badge = st.openAlerts > 0 ? `<span class="badge">${st.openAlerts}</span>` : '';
      return `<button class="st-row${on}" data-id="${st.id}" title="${st.type}">
        <span class="st-dot ${dotCls}"></span>
        <div>
          <div class="st-name"><span class="full">${st.name}</span><span class="short">${st.short}</span>${badge}</div>
          <div class="st-sub">${st.cap} MWh<span class="mw"> · ${st.mw} MW</span></div>
        </div>
        <div class="st-soc">
          <b>${fmt(st.soc)}%</b>
          <i class="mini-bar"><u style="width:${clamp(st.soc, 2, 100)}%;background:${socColor(st.soc)}"></u></i>
        </div>
      </button>`;
    }).join('') || `<div class="al-empty">当前筛选下无电站</div>`;
  }

  /* ================= 左侧：告警 ================= */
  function renderAlertFilters() {
    const counts = { all: DATA.ALERTS.length, crit: 0, high: 0, warn: 0, info: 0 };
    DATA.ALERTS.forEach(a => counts[a.lv]++);
    const openN = DATA.ALERTS.filter(a => a.status < 2).length;
    $('#alertFilters').innerHTML = `
      <button class="chip ${state.alertFilter === 'open' ? 'is-on' : ''}" data-filter="open">未闭环 <i>${openN}</i></button>
      <button class="chip ${state.alertFilter === 'all' ? 'is-on' : ''}" data-filter="all">全部 <i>${counts.all}</i></button>
      <button class="chip lv-crit ${state.alertFilter === 'crit' ? 'is-on' : ''}" data-filter="crit">紧急 <i>${counts.crit}</i></button>
      <button class="chip lv-high ${state.alertFilter === 'high' ? 'is-on' : ''}" data-filter="high">重要 <i>${counts.high}</i></button>
      <button class="chip lv-warn ${state.alertFilter === 'warn' ? 'is-on' : ''}" data-filter="warn">一般 <i>${counts.warn}</i></button>
      <button class="chip lv-info ${state.alertFilter === 'info' ? 'is-on' : ''}" data-filter="info">提示 <i>${counts.info}</i></button>`;
  }

  function renderAlerts() {
    renderAlertFilters();
    renderBatchBar();
    const open = DATA.ALERTS.filter(a => a.status < 2).length;
    $('#alertOpen').textContent = '未闭环 ' + open;

    let arr = DATA.ALERTS.slice();
    if (state.alertFilter === 'open') arr = arr.filter(a => a.status < 2);
    else if (state.alertFilter !== 'all') arr = arr.filter(a => a.lv === state.alertFilter);

    const lvRank = { crit: 0, high: 1, warn: 2, info: 3 };
    const stRank = a => a.status === 0 ? 0 : a.status === 1 ? 1 : a.status === 2 ? 2 : 3;
    arr.sort((a, b) => stRank(a) - stRank(b) || lvRank[a.lv] - lvRank[b.lv] || a.age - b.age);

    const host = $('#alertList');
    const visible = state.alertLimit ? arr.slice(0, state.alertLimit) : arr;
    const rows = visible.map(a => {
      const st = DATA.stationById(a.st);
      const statusTxt = DATA.STATUS_TEXT[a.status];
      /* v1.1：操作图标化（悬浮 title + aria-label 全称），行内空间让给描述 */
      const act = a.status === 0
        ? `<button class="al-act" data-act="ack" data-id="${a.id}" title="确认告警" aria-label="确认该${a.lvName}告警">✓</button>`
        : a.status === 1
          ? `<button class="al-act" data-act="close" data-id="${a.id}" title="闭环告警" aria-label="闭环该${a.lvName}告警">✓</button>`
          : '';
      /* v1.3：批量模式下整行即勾选项（操作按钮由 CSS 收起），勾选态写进 aria-label 尾部
         —— 保持「等级告警，状态，全文」前缀不变，回归脚本的 aria-label 断言继续有效 */
      const picked = state.batch && state.picked.has(a.id);
      return `<div class="al-row ${a.lv} ${a.status >= 2 ? 'done' : ''}${picked ? ' picked' : ''}" data-id="${a.id}" role="listitem" aria-label="${a.lvName}告警，${statusTxt}，${a.text}${picked ? '，已勾选' : ''}">
        ${state.batch ? '<span class="al-check" aria-hidden="true"></span>' : ''}
        <div class="al-top">
          <span class="lv-tag ${a.lv}">${a.lvName}</span>
          <span class="al-time">${timeAgo(a.age)}</span>
          <span class="al-st">${st ? st.short : '—'}</span>
          <span class="al-status s${a.status}">${statusTxt}</span>
          <span class="al-ics">${act}<button class="al-act" data-act="locate" data-id="${a.id}" title="定位站点" aria-label="定位到告警站点">➤</button></span>
        </div>
        <div class="al-txt" title="${a.text}">${a.text}</div>
        <div class="al-foot"><span>${st ? st.short : '—'} · ${a.dev}</span></div>
      </div>`;
    });

    const hidden = arr.length - visible.length;
    if (hidden > 0) {
      rows.push(`<button class="al-more" data-act="limit">${state.alertLimit === 5 ? '查看全部 ' + arr.length + ' 条 ›' : '▴ 收起，只看最新 5 条'}</button>`);
    }
    host.innerHTML = rows.join('') || `<div class="al-empty" role="status"><b>系统运行平稳</b>暂无${state.alertFilter === 'open' ? '未闭环' : '该等级'}告警</div>`;
  }

  /* ================= v1.3 告警批量处置 + 操作审计 ================= */
  const AUDIT_KEY = 'uiAuditLog';
  const AUDIT_MAX = 200;          /* 本地留存上限，超出淘汰最旧（与 WS 告警池同策略） */
  const ROLE_NAME = { admin: '管理员', dispatcher: '调度员', inspector: '运维巡检' };
  let auditLog = [];
  let undoStack = [];             /* 处置撤销栈（内存态，刷新即清空——与告警状态生命周期一致） */

  function auditLoad() {
    try { auditLog = JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]'); } catch (e) { auditLog = []; }
    if (!Array.isArray(auditLog)) auditLog = [];
    auditLog = auditLog.slice(-AUDIT_MAX);
    const n = $('#auditCount');
    if (n) n.textContent = auditLog.length;
  }
  function auditSave() {
    try { localStorage.setItem(AUDIT_KEY, JSON.stringify(auditLog.slice(-AUDIT_MAX))); } catch (e) { /* 隐私模式忽略 */ }
  }
  function hms() {
    const d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function auditAdd(act, target, result) {
    auditLog.push({ t: hms(), role: state.role, act, target, result });
    if (auditLog.length > AUDIT_MAX) auditLog = auditLog.slice(-AUDIT_MAX);
    auditSave();
    const n = $('#auditCount');
    if (n) n.textContent = auditLog.length;
    if ($('#auditDrawer').classList.contains('on')) renderAudit();
  }

  function renderAudit() {
    const body = $('#auditBody');
    if (!body) return;
    const rows = auditLog.slice().reverse().map(e => `<div class="au-row" role="listitem">
        <div class="au-l1">
          <span class="au-t">${e.t || '--:--:--'}</span>
          <span class="au-role r-${e.role || 'admin'}">${ROLE_NAME[e.role] || e.role || '未知'}</span>
          <span class="au-act">${e.act || ''}</span>
          <span class="au-res">${e.result || ''}</span>
        </div>
        <div class="au-obj" title="${e.target || ''}">${e.target || ''}</div>
      </div>`).join('');
    body.innerHTML = `
      <div class="au-hd">
        <span>共 <b>${auditLog.length}</b> 条 · 本地留存最近 ${AUDIT_MAX} 条</span>
        <button class="link-btn" data-audit-act="csv">导出 CSV</button>
        <button class="link-btn" data-audit-act="clear">清空</button>
      </div>
      <div class="au-list" role="list">${rows || `<div class="al-empty" role="status"><b>暂无操作记录</b>告警确认 / 闭环 / 撤销 / 策略下发均会留痕</div>`}</div>`;
  }

  /* 两个抽屉共用一个遮罩：任一打开即锁滚动、隐藏演示 FAB（否则 z-index 421 的 FAB 会压在抽屉上） */
  function syncDrawerMask() {
    const any = $('#aiDrawer').classList.contains('on') || $('#auditDrawer').classList.contains('on');
    $('#scrim').classList.toggle('on', any);
    document.body.classList.toggle('drawer-open', any);
    document.body.style.overflow = any ? 'hidden' : '';
  }

  function openAudit() {
    renderAudit();
    $('#auditDrawer').classList.add('on');
    $('#auditDrawer').setAttribute('aria-hidden', 'false');
    $('#navMenu').hidden = true;
    syncDrawerMask();
  }
  function closeAudit() {
    $('#auditDrawer').classList.remove('on');
    $('#auditDrawer').setAttribute('aria-hidden', 'true');
    syncDrawerMask();
  }

  function exportAuditCsv() {
    if (!auditLog.length) { toast('暂无可导出的审计记录', 'warn'); return; }
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = ['时间,角色,动作,对象,结果'];
    auditLog.forEach(e => lines.push([
      e.t, ROLE_NAME[e.role] || e.role || '', esc(e.act), esc(e.target), esc(e.result)
    ].join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '操作审计_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('已导出 ' + auditLog.length + ' 条审计记录（模拟，上线对接后端审计接口）');
  }

  /* 处置后的统一刷新（告警 / 站点 / 指标 / 底栏四处联动） */
  function afterAlertChange() {
    refreshLive();
    renderAlerts();
    renderStations();
    renderMetrics();
    renderBottom();
  }

  function pushUndo(label, items) {
    undoStack.push({ label, items });
    if (undoStack.length > 20) undoStack.shift();
  }

  /* 单条处置：状态变更 + 撤销栈 + 审计留痕，三件事一处完成（批量也走这里的状态机语义） */
  function setAlertStatus(a, to, actName, silent) {
    if (!a || a.status === to) return false;
    const from = a.status;
    a.status = to;
    pushUndo(actName + ' ' + a.id, [{ id: a.id, from, to }]);
    auditAdd(actName, a.id + ' · ' + String(a.text || '').slice(0, 20), '成功');
    DataIO.sendOp(to === 2 ? 'close' : 'ack', a.id);   /* v2.0：实时链路下回写后端（断线静默丢弃，本地审计不受影响） */
    afterAlertChange();
    if (!silent) toast(actName + ' · ' + a.id + (undoStack.length ? '（Ctrl+Z 可撤销）' : ''));
    return true;
  }

  function renderBatchBar() {
    const bar = $('#alertBatchBar');
    if (!bar) return;
    bar.hidden = !state.batch;
    $('#alertPanel').classList.toggle('batch', state.batch);
    const btn = $('#btnAlertBatch');
    if (btn) {
      btn.classList.toggle('is-on', state.batch);
      btn.setAttribute('aria-pressed', state.batch ? 'true' : 'false');
    }
    const cnt = $('#abCount');
    if (cnt) cnt.textContent = '已选 ' + state.picked.size + ' 条';
  }

  function toggleBatch(on) {
    state.batch = on === undefined ? !state.batch : on;
    state.picked.clear();
    renderAlerts();
    if (state.batch) toast('批量模式 · 勾选告警后可一次性确认 / 闭环（Esc 退出）');
    else if (on === false) toast('已退出批量模式');
  }

  function pickAlert(id) {
    if (state.picked.has(id)) state.picked.delete(id);
    else state.picked.add(id);
    renderAlerts();
  }

  function applyBatch(kind) {
    const ids = Array.from(state.picked);
    if (!ids.length) { toast('请先勾选告警', 'warn'); return; }
    const actName = kind === 'ack' ? '批量确认' : '批量闭环';
    const items = [];
    ids.forEach(id => {
      const a = DATA.ALERTS.find(x => x.id === id);
      if (!a) return;
      const from = a.status;
      const to = kind === 'ack' ? (from === 0 ? 1 : from) : (from < 2 ? 2 : from);
      if (to === from) return;
      a.status = to;
      items.push({ id, from, to });
    });
    if (!items.length) {
      toast('所选告警当前状态无需' + (kind === 'ack' ? '确认' : '闭环'), 'warn');
      return;
    }
    pushUndo(actName, items);
    auditAdd(actName, items.length + ' 条告警（' + items.map(i => i.id).join('、') + '）', '成功');
    DataIO.sendOp(kind === 'ack' ? 'ack' : 'close', items.map(i => i.id));   /* v2.0：批量处置回写 */
    state.picked.clear();
    afterAlertChange();
    toast(actName + '完成 · ' + items.length + ' 条（Ctrl+Z 可撤销）');
  }

  function undoLast() {
    const rec = undoStack.pop();
    if (!rec) { toast('没有可撤销的处置操作', 'warn'); return; }
    rec.items.forEach(it => {
      const a = DATA.ALERTS.find(x => x.id === it.id);
      if (a) a.status = it.from;
    });
    auditAdd('撤销', rec.label + ' · ' + rec.items.length + ' 条', '已恢复原状态');
    DataIO.sendOp('undo', rec.items.map(i => i.id));   /* v2.0：撤销回写 */
    afterAlertChange();
    toast('已撤销：' + rec.label + '（' + rec.items.length + ' 条）', 'ok');
  }

  /* ================= 指标 ================= */
  function mCard(o) {
    return `<div class="m-card ${o.cls || ''}">
      <div class="m-lab"><span>${o.lab}</span><span class="d">${o.right || ''}</span></div>
      <div class="m-val ${o.txt ? 'txt' : ''} ${o.sm ? 'sm' : ''}">${o.val}<i>${o.unit || ''}</i></div>
      <div class="m-sub">${o.sub || ''}</div>
      ${o.spark || ''}
    </div>`;
  }

  function renderMetrics() {
    const host = $('#metricGrid');
    const scopeName = state.level === 0 ? '区域集群'
      : state.level === 1 ? getStation().short
        : state.level === 2 ? getCabin().name
          : '簇 ' + state.clusterId;
    $('#metricScope').textContent = scopeName;
    $('#btnScopeBack').hidden = state.level === 0;

    const spark = (seed, up) => {
      const vals = [];
      let v = 50;
      for (let i = 0; i < 14; i++) { v += Math.sin(i * 0.7 + seed) * 6 + (up ? 1.2 : -1.2); vals.push(v); }
      return Charts.sparkline(vals, up ? '#3ea87b' : '#df8b52');
    };

    if (state.level === 0) {
      const agg = DATA.aggregate();
      const p = regionPower();
      const e = DATA.todayEnergy(null);
      host.innerHTML = [
        mCard({ lab: '总 SOC', right: 'WEIGHTED', val: fmt(agg.soc), unit: '%', sub: '较昨日同时段 <em>+1.8%</em>', spark: spark(1, true) }),
        mCard({ lab: '总 SOH', right: 'HEALTH', val: fmt(agg.soh), unit: '%', sub: '最低 89.7% · 南通如东', cls: 'okc' }),
        mCard({ lab: '电网交互功率', right: p > 3 ? '放电' : p < -3 ? '充电' : '待机', val: (p >= 0 ? '+' : '') + fmt(p), unit: 'MW', sub: p > 3 ? '上网 · 功率因数 0.96' : p < -3 ? '谷段充电 · 下网' : '无功率交换' }),
        `<div class="m-card wide slim">
          <div class="m-wide-l">
            <div class="m-lab"><span>今日充放电量</span><span class="d">截至 ${DATA.hm(DATA.nowHours())}</span></div>
            <div class="m-sub">峰谷套利收益 <em>¥${fmt(e.revenue, 1)} 万</em> · 等效循环 0.62 次</div>
          </div>
          <div class="m-wide-r">
            <div>充电<b class="ch">${fmt(e.charge, 0)}<i>MWh</i></b></div>
            <div>放电<b class="dis">${fmt(e.discharge, 0)}<i>MWh</i></b></div>
          </div>
        </div>`
      ].join('');
      return;
    }

    if (state.level === 1) {
      const st = getStation();
      const e = DATA.todayEnergy(st);
      const cab = st.cabinList || [];
      const maxT = Math.max(...cab.map(c => c.temp), st.temp);
      host.innerHTML = [
        mCard({ lab: '站内 SOC', right: 'SOC', val: fmt(st.soc), unit: '%', sub: `可用容量 ${fmt(st.cap * st.soc / 100, 0)} MWh`, spark: spark(2, true) }),
        mCard({ lab: '站内 SOH', right: 'SOH', val: fmt(st.soh), unit: '%', sub: `舱体 ${st.cabins} 座 · 簇 ${st.totalClusters} 个`, cls: 'okc' }),
        mCard({ lab: '并网点功率', right: DATA.statusOf(st).text, val: (st.power >= 0 ? '+' : '') + fmt(st.power), unit: 'MW', sub: st.comm === 'offline' ? '通信中断 · 快照数据' : '功率因数 0.96', cls: st.comm === 'offline' ? 'warnc' : '' }),
        `<div class="m-card wide slim">
          <div class="m-wide-l">
            <div class="m-lab"><span>今日充放电量</span><span class="d">最高温度 ${fmt(maxT)}℃</span></div>
            <div class="m-sub">站内效率 <em>88.6%</em> · 可用率 99.2%</div>
          </div>
          <div class="m-wide-r">
            <div>充电<b class="ch">${fmt(e.charge, 0)}<i>MWh</i></b></div>
            <div>放电<b class="dis">${fmt(e.discharge, 0)}<i>MWh</i></b></div>
          </div>
        </div>`
      ].join('');
      return;
    }

    if (state.level === 2) {
      const cab = getCabin();
      const warn = cab.clusters.filter(c => c.status === 'warn').length;
      const maxT = Math.max(...cab.clusters.map(c => c.temp));
      host.innerHTML = [
        mCard({ lab: '舱 SOC', right: 'SOC', val: fmt(cab.soc), unit: '%', sub: `额定 ${fmt(getStation().cap / getStation().cabins, 0)} MWh · 12 簇`, spark: spark(3, true) }),
        mCard({ lab: '舱 SOH', right: 'SOH', val: fmt(cab.soh), unit: '%', sub: '本月衰减 0.03%', cls: 'okc' }),
        mCard({ lab: '簇在线', right: 'ONLINE', val: (12 - warn) + '/12', txt: false, sub: warn ? `异常簇 <em>${warn}</em> 个` : '全部簇通信正常', cls: warn ? 'warnc' : '' }),
        mCard({ lab: '舱内温度', right: 'TEMP', val: fmt(cab.temp), unit: '℃', sub: `最高 ${fmt(maxT)}℃ · 阈值 32℃`, cls: maxT > 32 ? 'warnc' : '' }),
        `<div class="m-card wide">
          <div class="m-wide-l">
            <div class="m-lab"><span>簇运行一致性</span><span class="d">BMS 2.4</span></div>
            <div class="m-sub">SOC 极差 <em>4.6%</em> · 压差 22mV</div>
          </div>
          <div class="m-wide-r">
            <div>充电<b class="ch">1.2<i>MWh</i></b></div>
            <div>放电<b class="dis">1.0<i>MWh</i></b></div>
          </div>
        </div>`
      ].join('');
      return;
    }

    const st = getStation();
    const cl = getCluster();
    host.innerHTML = [
      mCard({ lab: '簇 SOC', right: cl.id, val: fmt(cl.soc), unit: '%', sub: `剩余可充 ${fmt(100 - cl.soc, 1)}%`, spark: spark(4, true) }),
      mCard({ lab: '簇 SOH', right: 'SOH', val: fmt(cl.soh), unit: '%', sub: `循环 ${cl.cycleCount} 次`, cls: 'okc' }),
      mCard({ lab: '单体最大压差', right: 'ΔV', val: fmt((cl.vMax - cl.vMin) * 1000, 0), unit: 'mV', sub: `阈值 200 mV`, cls: (cl.vMax - cl.vMin) * 1000 > 60 ? 'warnc' : '' }),
      mCard({ lab: '最高单体温度', right: 'TEMP', val: fmt(Math.max(...cl.cells.map(c => c.t))), unit: '℃', sub: `绝缘 ${fmt(cl.insulation)} MΩ`, cls: 'warnc' }),
      `<div class="m-card wide">
        <div class="m-wide-l">
          <div class="m-lab"><span>单体电压范围</span><span class="d">32 CELLS</span></div>
          <div class="m-sub">均值 ${fmt((cl.vMax + cl.vMin) / 2, 3)} V · 采样周期 500ms</div>
        </div>
        <div class="m-wide-r">
          <div>最低<b class="ch">${fmt(cl.vMin, 3)}</b>V</div>
          <div>最高<b class="dis">${fmt(cl.vMax, 3)}</b>V</div>
        </div>
      </div>`
    ].join('');
  }

  /* ================= 图表 ================= */
  function tempColor(v) {
    if (v >= 34) return '#e0523f';
    if (v >= 32) return '#df8a2e';
    if (v >= 30) return '#d8b24a';
    return 'rgba(63,182,201,.62)';
  }

  function sohBuckets(list) {
    let a = 0, b = 0, c = 0, d = 0;
    list.forEach(v => {
      if (v >= 95) a++; else if (v >= 92) b++; else if (v >= 88) c++; else d++;
    });
    return [
      { label: '优 ≥95%', value: a, color: '#3ea87b' },
      { label: '良 92–95%', value: b, color: '#3fb6c9' },
      { label: '关注 88–92%', value: c, color: '#d8b24a' },
      { label: '预警 <88%', value: d, color: '#e0523f' }
    ];
  }

  function renderCharts() {
    const hovered = $$('.chart-box').some(el => el.dataset.hover === '1');
    if (hovered) return;
    const folded = $('#chartsPanel').classList.contains('folded');

    const main = $('#chartMain'), tempBox = $('#chartTemp'), healthBox = $('#chartHealth');
    if (!main || !main.clientWidth) return;

    const tab = state.chartTab;
    const lg = $('.chart-title .lg');
    const mainTitle = $('#mainChartTitle');
    const tempTitle = $('#tempChartTitle');
    const healthTitle = $('#healthChartTitle');
    const tabs = $$('#chartTabs button');
    const meta = $('#chartMeta');
    $('#chartTabs').style.display = 'flex';

    const st = state.level >= 1 ? getStation() : null;

    if (state.level <= 1) {
      tabs[0].textContent = '功率';
      tabs[1].textContent = 'SOC';
      tabs[0].title = tabs[1].title = '';
      lg.style.display = 'flex';
      meta.textContent = '对照';
      meta.title = '主图对照：计划 vs 实际';

      /* v2.0：实时链路推送过该站 24h 曲线时用真实数据，否则本地推演（L0 时 st 为 null，曲线走全集群） */
      const s = (st && DataIO.historyFor(st.id)) || DATA.buildSeries(st);
      const factor = strategyFactor();
      const plan = s.plan.map(v => +(v * factor).toFixed(2));

      if (tab === 'power') {
        mainTitle.textContent = '并网功率 · 计划 / 实际';
        Charts.areaChart(main, {
          labels: s.labels,
          series: [
            { data: plan, color: '#7d93a8', dashed: true, label: '计划' },
            { data: s.actual, color: '#3fb6c9', label: '实际', fill: true }
          ],
          unit: 'MW', zeroLine: true, nowIndex: Math.floor(s.nowIdx), dec: 1
        });
      } else {
        mainTitle.textContent = 'SOC 曲线 · 实际 / 目标';
        Charts.areaChart(main, {
          labels: s.labels,
          series: [
            { data: s.socPlan, color: '#7d93a8', dashed: true, label: '目标' },
            { data: s.soc, color: '#3fb6c9', label: '实际', fill: true }
          ],
          unit: '%', yMin: 0, yMax: 100, nowIndex: Math.floor(s.nowIdx), dec: 1
        });
      }

      if (!folded) {
        if (state.level === 0) {
          tempTitle.textContent = '各站最高温度';
          const arr = DATA.tempByStation();
          Charts.barChart(tempBox, {
            labels: arr.map(x => x.label.slice(0, 2)),
            values: arr.map(x => x.value),
            colors: arr.map(x => tempColor(x.value)),
            threshold: 32, unit: '℃', max: 40, dec: 1, tipLabel: i => arr[i].label + '储能站'
          });
        } else {
          tempTitle.textContent = '舱体温度分布';
          const arr = st.cabinList;
          Charts.barChart(tempBox, {
            labels: arr.map((c, i) => (i + 1) + '#'),
            values: arr.map(c => c.temp),
            colors: arr.map(c => tempColor(c.temp)),
            threshold: 32, unit: '℃', max: 40, dec: 1, tipLabel: i => arr[i].name
          });
        }

        healthTitle.textContent = '电池簇健康度';
        const buckets = DATA.healthBuckets(st);
        Charts.donutChart(healthBox, {
          items: buckets,
          centerValue: buckets.reduce((a, b) => a + b.value, 0),
          centerLabel: 'CLUSTERS'
        });
      }
      return;
    }

    const cab = getCabin();
    const cl = state.level === 3 ? getCluster() : null;

    if (state.level === 2) {
      tabs[0].textContent = '簇温度';
      tabs[1].textContent = '簇SOC';
      tabs[0].title = tabs[1].title = '';
      lg.style.display = 'none';
      meta.textContent = '12 簇';
      meta.title = '舱内 12 电池簇';

      if (tab === 'power') {
        mainTitle.textContent = '舱内簇温度分布';
        Charts.barChart(main, {
          labels: cab.clusters.map(c => c.id.replace('C-', '')),
          values: cab.clusters.map(c => c.temp),
          colors: cab.clusters.map(c => tempColor(c.temp)),
          threshold: 32, thresholdLabel: '告警 32℃', unit: '℃', max: 40, dec: 1,
          tipLabel: i => '电池簇 ' + cab.clusters[i].id
        });
      } else {
        mainTitle.textContent = '舱内簇 SOC 分布';
        Charts.barChart(main, {
          labels: cab.clusters.map(c => c.id.replace('C-', '')),
          values: cab.clusters.map(c => c.soc),
          colors: cab.clusters.map(c => c.soc < 30 ? '#d8b24a' : 'rgba(63,182,201,.62)'),
          unit: '%', max: 100, dec: 1, tipLabel: i => '电池簇 ' + cab.clusters[i].id
        });
      }

      if (!folded) {
        tempTitle.textContent = '簇电压极差';
        Charts.barChart(tempBox, {
          labels: cab.clusters.map(c => c.id.replace('C-', '')),
          values: cab.clusters.map(c => c.voltDiff),
          colors: cab.clusters.map(c => c.voltDiff > 40 ? '#df8a2e' : 'rgba(94,143,187,.5)'),
          threshold: 40, unit: 'mV', dec: 0, tipLabel: i => cab.clusters[i].id
        });

        healthTitle.textContent = '电池簇 SOH 分布';
        const bk = sohBuckets(cab.clusters.map(c => c.soh));
        Charts.donutChart(healthBox, {
          items: bk, centerValue: cab.clusters.length, centerLabel: 'CLUSTERS'
        });
      }
      return;
    }

    // level 3（v1.3.3：Tab 文案压到两字——「单体电压/单体温度」四字在 320px 右栏会把「明细」挤出面板）
    tabs[0].textContent = '电压';
    tabs[0].title = '单体电压';
    tabs[1].textContent = '温度';
    tabs[1].title = '单体温度';
    lg.style.display = 'none';
    meta.textContent = '簇 ' + cl.id;
    meta.title = '簇 ' + cl.id + ' · 32 单体';

    const cellsT = cl.cells.map(c => c.t);
    if (tab === 'power') {
      mainTitle.textContent = '单体电压分布';
      Charts.areaChart(main, {
        labels: cl.cells.map(c => c.idx),
        series: [{ data: cl.cells.map(c => c.v), color: '#3fb6c9', label: '单体', fill: true }],
        unit: 'V', dec: 3, xStep: 4, tipLabel: i => '单体 #' + (i + 1)
      });
    } else {
      mainTitle.textContent = '单体温度分布';
      Charts.areaChart(main, {
        labels: cl.cells.map(c => c.idx),
        series: [{ data: cellsT, color: '#dfab52', label: '单体', fill: true }],
        unit: '℃', dec: 1, xStep: 4, tipLabel: i => '单体 #' + (i + 1)
      });
    }

    if (!folded) {
      tempTitle.textContent = '单体温度排序';
      const sorted = cellsT.slice().sort((a, b) => a - b);
      Charts.barChart(tempBox, {
        labels: sorted.map((_, i) => i % 4 === 0 ? (i + 1) : ''),
        values: sorted,
        colors: sorted.map(tempColor),
        threshold: 32, unit: '℃', dec: 1,
        tipLabel: i => '温度序号 ' + (i + 1)
      });

      const avgV = cl.cells.reduce((a, c) => a + c.v, 0) / cl.cells.length;
      const diffs = cl.cells.map(c => Math.abs(c.v - avgV) * 1000);
      healthTitle.textContent = '单体一致性';
      const bk = [
        { label: '优 <8mV', value: diffs.filter(v => v < 8).length, color: '#3ea87b' },
        { label: '良 8–15mV', value: diffs.filter(v => v >= 8 && v < 15).length, color: '#3fb6c9' },
        { label: '关注 15–25mV', value: diffs.filter(v => v >= 15 && v < 25).length, color: '#d8b24a' },
        { label: '预警 >25mV', value: diffs.filter(v => v >= 25).length, color: '#e0523f' }
      ];
      Charts.donutChart(healthBox, { items: bk, centerValue: cl.cells.length, centerLabel: 'CELLS' });
    }
  }

  /* ================= 底部 ================= */
  function renderStrategy() {
    $$('#strategySeg button').forEach(b => b.classList.toggle('on', b.dataset.strategy === state.strategy));
    const s = STRATEGY[state.strategy];
    $('#stratWindow').textContent = s.window;
    const p = DATA.planAt(DATA.nowHours()) * s.factor;
    $('#stratPower').textContent = (p >= 0 ? '+' : '') + fmt(p) + ' MW';
    $('#stratPower').style.color = p >= 0 ? '#e8bb78' : '#8fd9e4';
    $('#stratState').textContent = '执行中';
    $('#stratState').className = 'tag ok';
  }

  function renderComm() {
    const offline = DATA.STATIONS.some(s => s.comm === 'offline');
    const rows = [
      { nm: offline ? '南通如东 ↔ 调度主站' : '调度主站 ↔ 集群 EMS', lat: offline ? 0 : 12, q: offline ? 1 : 5, ok: !offline },
      { nm: '站控 ↔ BMS 网关', lat: 8, q: 5, ok: true },
      { nm: '站控 ↔ PCS 群控', lat: 6, q: 5, ok: true },
      { nm: '消防主机 ↔ 站控', lat: 21, q: 4, ok: true }
    ];
    $('#commList').innerHTML = rows.map(r => `
      <div class="comm-row">
        <span class="dot ${r.ok ? '' : 'warn'}"></span>
        <span class="nm">${r.nm}</span>
        <span class="lat">${r.lat} ms</span>
        <span class="bars">${[0, 1, 2, 3, 4].map(i => `<i class="${i < r.q ? '' : 'dim'}"></i>`).join('')}</span>
      </div>`).join('');
  }

  function renderOnline() {
    const dev = [
      { k: 'PCS', on: 64, total: 64, color: '#3ea87b' },
      { k: 'BMS', on: 446, total: 452, color: '#3fb6c9' },
      { k: 'EMS', on: 8, total: 8, color: '#5e8fbb' },
      { k: '消防', on: 7, total: 8, color: '#d8b24a' }
    ];
    const on = dev.reduce((a, d) => a + d.on, 0);
    const total = dev.reduce((a, d) => a + d.total, 0);
    const pct = on / total * 100;
    $('#onlineRate').innerHTML = fmt(pct, 1) + '<i>%</i>';
    /* v1.1：微型圆环替代「黄蓝绿进度条」，分色扇区一眼可读 */
    const donut = $('#onlineDonut');
    if (donut) {
      /* v1.1.2：扇区间深色缝——抗色弱辅助（红绿靠边界而非色相区分）；扇区顺时针顺序与图例一致 */
      const gap = 0.6;
      const ring = [];
      let acc0 = 0;
      dev.forEach(d => {
        const from = acc0 / total * 100;
        acc0 += d.on;
        const to = acc0 / total * 100;
        const g = Math.min(gap, (to - from) * 0.4);
        ring.push(`${d.color} ${from.toFixed(2)}% ${(to - g).toFixed(2)}%`);
        ring.push(`#0c1623 ${(to - g).toFixed(2)}% ${to.toFixed(2)}%`);
      });
      donut.style.background = `conic-gradient(${ring.join(',')},rgba(126,163,196,.15) 0)`;
      donut.style.setProperty('--p', pct.toFixed(1));
    }
  }

  function renderAIBlock() {
    const top = DATA.ALERTS.find(a => a.status === 0 && a.lv === 'crit') || DATA.ALERTS[0];
    const st = DATA.stationById(top.st);
    const rev = DATA.todayEnergy(null).revenue;
    $('#aiLines').innerHTML = `
      <div class="ai-line"><span class="ai-k">根因</span><p>${st.short} 2#舱 C-07 液冷支路流量不足</p><b>86%</b></div>
      <div class="ai-line"><span class="ai-k">收益</span><p>峰谷套利 + 调频补偿 · 环比昨日</p><b class="rev">¥${fmt(rev, 1)}万</b></div>`;
  }

  function renderBottom() {
    renderStrategy();
    renderComm();
    renderOnline();
    renderAIBlock();
  }

  /* ================= 面包屑 & 浮卡 ================= */
  function renderCrumbs() {
    const st = getStation(), cab = getCabin();
    const items = [];
    items.push(`<span class="lvl">L${state.level}</span>`);
    items.push(`<button class="cr ${state.level === 0 ? 'cur' : ''}" data-nav="region">区域总览</button>`);
    if (st) {
      items.push(`<span class="sep">/</span>`);
      items.push(`<button class="cr ${state.level === 1 ? 'cur' : ''}" data-nav="station">${st.short}</button>`);
    }
    if (cab) {
      items.push(`<span class="sep">/</span>`);
      items.push(`<button class="cr ${state.level === 2 ? 'cur' : ''}" data-nav="cabin">${cab.name}</button>`);
    }
    if (state.level === 3 && state.clusterId) {
      items.push(`<span class="sep">/</span>`);
      items.push(`<button class="cr cur">电池簇 ${state.clusterId}</button>`);
    }
    $('#crumbs').innerHTML = items.join('');
  }

  function renderStageCard() {
    const card = $('#stageCard');
    if (state.level === 0) { card.hidden = true; return; }
    const st = getStation();
    const cab = getCabin();
    card.hidden = false;

    if (state.level === 1) {
      const openA = DATA.ALERTS.filter(a => a.st === st.id && a.status < 2);
      const crit = openA.filter(a => a.lv === 'crit').length;
      const high = openA.filter(a => a.lv === 'high').length;
      card.innerHTML = `
        <div class="sc-hd">
          <b>${st.name}</b>
          <button class="icon-btn" data-back="1">×</button>
        </div>
        <div class="sc-bd">
          <div class="sc-kv"><span>装机 / 功率</span><b>${st.cap} MWh · ${st.mw} MW</b></div>
          <div class="sc-kv"><span>电池舱 / 簇</span><b>${st.cabins} 舱 · ${st.totalClusters} 簇</b></div>
          <div class="sc-kv"><span>站内 SOC</span><b class="hl">${fmt(st.soc)} %</b></div>
          <div class="sc-bar"><u style="width:${clamp(st.soc, 0, 100)}%"></u></div>
          <div class="sc-kv"><span>最高温度 / 效率</span><b>${fmt(st.temp)} ℃ / 88.6%</b></div>
          <div class="sc-tags">
            <span class="tag ${crit ? 'crit' : 'off'}">紧急 ${crit}</span>
            <span class="tag ${high ? 'high' : 'off'}">重要 ${high}</span>
            <span class="tag ${st.comm === 'offline' ? 'off' : 'ok'}">${st.comm === 'offline' ? '通信中断' : '通信正常'}</span>
          </div>
          <div class="sc-actions">
            <button class="btn primary" data-act="first-cabin">进入电池舱</button>
            <button class="btn ghost" data-back="1">返回</button>
          </div>
        </div>`;
      return;
    }

    if (state.level === 2) {
      card.innerHTML = `
        <div class="sc-hd">
          <b>${st.short} · ${cab.name}</b>
          <button class="icon-btn" data-back="1">×</button>
        </div>
        <div class="sc-bd">
          <div class="sc-kv"><span>舱 SOC / SOH</span><b class="hl">${fmt(cab.soc)}% / ${fmt(cab.soh)}%</b></div>
          <div class="sc-kv"><span>舱内温度</span><b>${fmt(cab.temp)} ℃</b></div>
          <div class="sc-kv"><span>电池簇</span><b>12 簇 · 在线 ${12 - cab.clusters.filter(c => c.status === 'warn').length}</b></div>
          <div class="sc-bar"><u style="width:${clamp(cab.soc, 0, 100)}%"></u></div>
          <div class="sc-tags">
            <span class="tag ok">液冷运行</span>
            <span class="tag">BMS 2.4</span>
            <span class="tag">消防正常</span>
          </div>
          <div class="sc-actions">
            <button class="btn primary" data-act="first-cluster">查看电池簇</button>
            <button class="btn ghost" data-back="1">返回站内</button>
          </div>
        </div>`;
      return;
    }

    const cl = getCluster();
    card.innerHTML = `
      <div class="sc-hd">
        <b>${cab.name} · 簇 ${cl.id}</b>
        <button class="icon-btn" data-back="1">×</button>
      </div>
      <div class="sc-bd">
        <div class="sc-kv"><span>SOC / SOH</span><b class="hl">${fmt(cl.soc)}% / ${fmt(cl.soh)}%</b></div>
        <div class="sc-kv"><span>最大压差</span><b>${fmt((cl.vMax - cl.vMin) * 1000, 0)} mV</b></div>
        <div class="sc-kv"><span>最高温度</span><b>${fmt(Math.max(...cl.cells.map(c => c.t)))} ℃</b></div>
        <div class="sc-kv"><span>绝缘 / 循环</span><b>${fmt(cl.insulation)} MΩ · ${cl.cycleCount} 次</b></div>
        <div class="sc-bar"><u style="width:${clamp(cl.soc, 0, 100)}%"></u></div>
        <div class="sc-tags">
          <span class="tag ${(cl.vMax - cl.vMin) * 1000 > 60 ? 'crit' : 'ok'}">压差 ${(cl.vMax - cl.vMin) * 1000 > 60 ? '超限' : '正常'}</span>
          <span class="tag acc">BMS 在线</span>
        </div>
        <div class="sc-actions">
          <button class="btn ghost" data-back="1">返回舱体</button>
          <button class="btn" data-act="ticket">生成工单</button>
        </div>
      </div>`;
  }

  /* ================= 场景 ================= */
  function currentScene() {
    const st = getStation();
    if (state.level === 0) {
      return Scenes.map(DATA.STATIONS, {
        showLabels: state.layers.label,
        showLinks: state.layers.link,
        showAlerts: state.layers.alert,
        hubSub: '220kV · 汇集 ' + DATA.STATIONS.length + ' 站'
      });
    }
    if (state.level === 1) {
      return Scenes.station(st, { showLabels: state.layers.label });
    }
    return Scenes.cabin(st, getCabin(), { showLabels: state.layers.label });
  }

  function applyScene(opts) {
    opts = opts || {};
    const sc = currentScene();
    twin.setScene(sc, {
      keepCam: !!opts.keepCam,
      selectedId: state.level === 3 ? state.clusterId : null
    });
  }

  function fadeSwap(fn) {
    if (state.transitioning) return;
    state.transitioning = true;
    const veil = $('#stageVeil');
    veil.classList.add('on');
    setTimeout(() => {
      fn();
      setTimeout(() => {
        veil.classList.remove('on');
        state.transitioning = false;
      }, 90);
    }, 190);
  }

  /* ================= 导航 ================= */
  function goRegion() {
    if (state.level === 0 || state.transitioning) return;
    state.level = 0; state.stationId = null; state.cabinIndex = null; state.clusterId = null;
    fadeSwap(() => {
      applyScene();
      renderAll();
    });
  }

  function enterStation(id, opts) {
    opts = opts || {};
    const st = DATA.stationById(id);
    if (!st || state.transitioning) return;
    buildCabins(st);
    state.level = 1;
    state.stationId = id;
    state.cabinIndex = null;
    state.clusterId = null;
    fadeSwap(() => {
      applyScene();
      renderAll();
      if (st.comm === 'offline') toast(st.short + ' 通信中断，当前展示离线快照', 'warn');
    });
    if (opts.cabinIndex != null) {
      setTimeout(() => goCabin(opts.cabinIndex), 900);
    }
  }

  function goCabin(index) {
    const st = getStation();
    if (!st || !st.cabinList || state.transitioning) return;
    const cab = st.cabinList[index];
    if (!cab) return;
    state.level = 2;
    state.cabinIndex = index;
    state.clusterId = null;
    fadeSwap(() => {
      applyScene();
      renderAll();
    });
  }

  function selectCluster(id) {
    state.level = 3;
    state.clusterId = id;
    if (twin) twin.selectedId = id;
    renderMetrics();
    renderCharts();
    renderCrumbs();
    renderStageCard();
  }

  function goUp() {
    if (state.level === 3) {
      state.level = 2; state.clusterId = null;
      if (twin) twin.selectedId = null;
      renderMetrics(); renderCharts(); renderCrumbs(); renderStageCard();
      return;
    }
    if (state.level === 2) {
      state.level = 1; state.cabinIndex = null;
      fadeSwap(() => { applyScene(); renderAll(); });
      return;
    }
    if (state.level === 1) goRegion();
  }

  /* ================= 演示导览面板 ================= */
  function applyStrategy(key) {
    if (!STRATEGY[key] || state.strategy === key) return;
    state.strategy = key;
    renderStrategy();
    renderCharts();
    const s = STRATEGY[key];
    /* v1.3：策略下发属调度操作，纳入审计留痕（交接班/复盘可查） */
    auditAdd('策略下发', s.name, '成功');
    toast('调度策略切换为「' + s.name + '」· ' + s.note);
  }

  function demoGo(key) {
    const CABIN = 1, CLUSTER = 'C-03';   // 锡山 2#舱 C-03
    if (key === 'L0') { goRegion(); toast('演示导览：L0 集群总览'); return; }
    if (key === 'L1') {
      if (state.stationId === 'S01' && state.level === 1) return;
      enterStation('S01');
      toast('演示导览：L1 无锡锡山储能站（含 C-07 告警联动）');
      return;
    }
    if (key === 'L2') {
      if (state.stationId !== 'S01' || state.level < 1) { enterStation('S01', { cabinIndex: CABIN }); toast('演示导览：L2 锡山 2#电池舱'); return; }
      if (state.level === 1) { goCabin(CABIN); toast('演示导览：L2 锡山 2#电池舱'); return; }
      if (state.level > 2) {
        state.level = 2; state.cabinIndex = CABIN; state.clusterId = null;
        if (twin) twin.selectedId = null;
        fadeSwap(() => { applyScene(); renderAll(); });
        toast('演示导览：L2 锡山 2#电池舱');
      }
      return;
    }
    if (key === 'L3') {
      if (state.stationId !== 'S01' || state.level < 1) {
        enterStation('S01', { cabinIndex: CABIN });
        setTimeout(() => selectCluster(CLUSTER), 1700);
      } else if (state.level === 1) {
        goCabin(CABIN);
        setTimeout(() => selectCluster(CLUSTER), 950);
      } else {
        selectCluster(CLUSTER);
      }
      toast('演示导览：L3 电池簇 ' + CLUSTER + '（BMS 详情）');
    }
  }

  function demoSync() {
    $$('#demoPanel [data-dp-strategy]').forEach(b =>
      b.classList.toggle('on', b.dataset.dpStrategy === state.strategy));
    const cur = state.level === 0 ? 'L0'
      : state.level === 3 ? 'L3'
      : state.level === 2 ? 'L2' : 'L1';
    $$('#demoPanel [data-dp-go]').forEach(b =>
      b.classList.toggle('on', b.dataset.dpGo === cur));
    $$('#demoPanel [data-dp-sc]').forEach(b => {
      const v = b.dataset.dpSc;
      b.classList.toggle('warn-on', v === state.scenario);
      b.classList.toggle('on', v === state.scenario);
    });
    const ld = $('#demoPanel [data-dp-linkdown]');
    if (ld) ld.classList.toggle('warn-on', !!state.linkDown);
    const lite = $('#demoPanel [data-dp-lite]');
    if (lite) lite.classList.toggle('on', !!(twin && twin.lightweight));
    $$('#demoPanel [data-dp-role]').forEach(b =>
      b.classList.toggle('on', b.dataset.dpRole === state.role));
  }

  /* ================= 全局标注层 ================= */
  const ANNO_BOXES = [
    // 与 mockups.html 第 01 节 L0 稿同一坐标（1920×1080 百分比），像素对齐
    ['static', '顶栏通栏 · KPI', 0, 0, 100, 5.2],
    ['static', '左栏 · 电站列表', 0.5, 8, 15, 40],
    ['static', '左栏 · 告警台账', 0.5, 50, 15, 38],
    ['static', '右栏 · 指标卡', 78, 8, 21.2, 26],
    ['static', '右栏 · 趋势区', 78, 36.5, 21.2, 51],
    ['static', '底部辅助栏', 0.5, 90, 99, 8.6],
    ['fx', '告警脉冲（锡山 / 如东）', 44, 26, 26, 30],
    ['fx', '链路流向流光（随策略变速）', 22, 44, 55, 22],
    ['hot', '信标热区 ×9', 22, 22, 56, 42],
    ['hot', '图层开关 / 2D / 复位', 64, 6.6, 13.5, 4.5],
    ['hot', '电站行热区', 0.5, 8, 15, 40],
    ['hot', '告警卡 / 定位按钮', 0.5, 50, 15, 38],
    ['hot', '策略分段 ×3', 0.6, 90.5, 15, 7],
    ['hot', 'AI 抽屉展开', 72, 90.5, 13, 7]
  ];

  function initAnno() {
    const layer = $('#annoLayer');
    layer.innerHTML = ANNO_BOXES.map(([k, name, l, t, w, h]) =>
      `<div class="mark ${k === 'static' ? 'static-layer' : k === 'fx' ? 'fx-layer' : 'hotspot'}" data-k="${k}"
        style="left:${l}%;top:${t}%;width:${w}%;height:${h}%"><i>${name}</i></div>`).join('');
  }

  function setAnno(kind, on) {
    const layer = $('#annoLayer');
    const keys = kind === 'all' ? ['static', 'fx', 'hot'] : [kind];
    keys.forEach(k => layer.classList.toggle('show-' + k, on));
    const active = k => layer.classList.contains('show-' + k);
    $$('#demoPanel [data-dp-anno]').forEach(b => {
      const a = b.dataset.dpAnno;
      b.classList.toggle('on', a === 'all'
        ? active('static') && active('fx') && active('hot')
        : active(a));
    });
  }

  /* ================= 断连降级 / 角色 / 导出 / 快照 ================= */
  function setLinkDown(on) {
    state.linkDown = on;
    $('#app').classList.toggle('linkdown', on);
    demoSync();
    toast(on
      ? '数据源断开 · 视图已冻结，保持最后有效快照（演示）'
      : '数据链路恢复 · 恢复 2.5s 数据帧刷新', on ? 'crit' : 'ok');
  }

  function applyRole(role) {
    state.role = role;
    const names = { admin: '管理员', dispatcher: '调度员', inspector: '运维巡检' };
    const insp = role === 'inspector';
    $$('#strategySeg button').forEach(b => {
      b.disabled = insp;
      b.title = insp ? '当前角色无策略下发权限' : '';
    });
    $('#btnAiDrawer').disabled = false;
    demoSync();
    auditAdd('角色切换', names[role] || role, '生效');
    toast('角色预览：' + names[role] + (insp ? ' · 策略下发已按权限灰化' : ' · 全功能可用'));
  }

  function exportAlertsCsv() {
    const stMap = {};
    DATA.STATIONS.forEach(s => stMap[s.id] = s.short || s.name);
    const stName = ['未确认', '已确认', '已闭环', '已抑制'];
    const lvName = { crit: '紧急', high: '重要', warn: '一般', info: '提示' };
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = ['告警ID,等级,电站,设备,内容,状态,发生时间'];
    DATA.ALERTS.forEach(a => {
      const t = new Date(Date.now() - (a.age || 0) * 60000);
      const ts = t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate())
        + ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes());
      lines.push([a.id, lvName[a.lv] || a.lv, esc(stMap[a.st] || a.st), esc(a.dev), esc(a.text), stName[a.status] || a.status, ts].join(','));
    });
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '告警台账导出_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('已导出 ' + DATA.ALERTS.length + ' 条告警记录（模拟，上线对接后端接口）');
  }

  const SNAP_KEY = 'twin-snapshots';
  function saveSnapshot() {
    const s = {
      t: Date.now(),
      level: state.level,
      stationId: state.stationId,
      cabinIndex: state.cabinIndex,
      clusterId: state.clusterId,
      strategy: state.strategy
    };
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]'); } catch (e) { arr = []; }
    arr.unshift(s);
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(arr.slice(0, 3))); } catch (e) { /* 隐私模式忽略 */ }
    renderSnaps();
    toast('已保存视图快照（层级 / 告警状态 / 策略模式）');
  }

  function restoreSnapshot(s) {
    if (state.strategy !== s.strategy) {
      state.strategy = s.strategy;
      renderStrategy();
      renderCharts();
    }
    const stName = DATA.stationById(s.stationId);
    if (s.level === 0 || !stName) { goRegion(); toast('快照回放：集群总览'); return; }
    if (s.level === 1) { enterStation(s.stationId); toast('快照回放：' + (stName.short || stName.name)); return; }
    if (s.level === 2) { enterStation(s.stationId, { cabinIndex: s.cabinIndex || 0 }); toast('快照回放：' + (stName.short || stName.name) + ' · 电池舱'); return; }
    enterStation(s.stationId, { cabinIndex: s.cabinIndex || 0 });
    setTimeout(() => selectCluster(s.clusterId || 'C-01'), 1700);
    toast('快照回放：' + (stName.short || stName.name) + ' · 电池簇');
  }

  function renderSnaps() {
    const box = $('#dpSnapList');
    if (!box) return;
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]'); } catch (e) { arr = []; }
    box.innerHTML = arr.length
      ? arr.map((s, i) => {
          const lv = ['L0 集群', 'L1 站级', 'L2 舱内', 'L3 簇级'][s.level] || 'L0';
          const tm = new Date(s.t);
          const label = pad2(tm.getHours()) + ':' + pad2(tm.getMinutes()) + ':' + pad2(tm.getSeconds()) + ' · ' + lv;
          return '<button data-dp-snap="' + i + '">' + label + '</button>';
        }).join('')
      : '<span class="dp-empty">暂无快照</span>';
  }

  function initDemoPanel() {
    initAnno();
    renderSnaps();
    $('#btnAlertCsv').addEventListener('click', exportAlertsCsv);
    $('#demoFab').addEventListener('click', () => {
      $('#demoPanel').hidden = false;
      $('#demoFab').hidden = true;
      demoSync();
    });
    $('#demoClose').addEventListener('click', () => {
      $('#demoPanel').hidden = true;
      $('#demoFab').hidden = false;
    });
    $('#demoPanel').addEventListener('click', e => {
      const go = e.target.closest('[data-dp-go]');
      if (go) { demoGo(go.dataset.dpGo); setTimeout(demoSync, 2000); return; }
      const sc = e.target.closest('[data-dp-sc]');
      if (sc) {
        const v = sc.dataset.dpSc;
        location.href = 'index.html' + (v ? '?anomaly=' + v : '');
        return;
      }
      const stg = e.target.closest('[data-dp-strategy]');
      if (stg) { applyStrategy(stg.dataset.dpStrategy); demoSync(); return; }
      const doc = e.target.closest('[data-dp-doc]');
      if (doc) { window.open(doc.dataset.dpDoc, '_blank'); return; }
      if (e.target.closest('[data-dp-linkdown]')) { setLinkDown(!state.linkDown); return; }
      /* v1.3：从演示导览进入批量处置 / 操作审计（先收面板，再开目标态） */
      if (e.target.closest('[data-dp-batch]')) {
        $('#demoClose').click();
        if (!state.batch) toggleBatch(true);
        return;
      }
      if (e.target.closest('[data-dp-audit]')) {
        $('#demoClose').click();
        openAudit();
        return;
      }
      const lite = e.target.closest('[data-dp-lite]');
      if (lite) {
        twin.lightweight = !twin.lightweight;
        document.body.classList.toggle('lite', twin.lightweight); /* v1.1：CSS 呼吸灯联动轻量化 */
        demoSync();
        toast(twin.lightweight
          ? '性能轻量化已开启 · 脉冲改静态描边、链路流向静止（低配工控机适用）'
          : '性能轻量化已关闭 · 恢复全部动效');
        return;
      }
      const role = e.target.closest('[data-dp-role]');
      if (role) { applyRole(role.dataset.dpRole); return; }
      if (e.target.closest('[data-dp-snap-save]')) { saveSnapshot(); return; }
      const snap = e.target.closest('[data-dp-snap]');
      if (snap) {
        let arr = [];
        try { arr = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]'); } catch (err) { arr = []; }
        const s = arr[+snap.dataset.dpSnap];
        if (s) restoreSnapshot(s);
        return;
      }
      const an = e.target.closest('[data-dp-anno]');
      if (an) {
        const k = an.dataset.dpAnno;
        if (k === 'all') {
          const allOn = ['static', 'fx', 'hot'].every(x => $('#annoLayer').classList.contains('show-' + x));
          setAnno('all', !allOn);
        } else setAnno(k, !$('#annoLayer').classList.contains('show-' + k));
      }
    });
  }

  function focusAlert(a) {
    const st = DATA.stationById(a.st);
    if (!st) return;
    const m = /(\d+)#电池舱/.exec(a.dev);
    const cabinIndex = m ? Math.max(0, Math.min(st.cabins - 1, +m[1] - 1)) : null;
    const cl = /C-(\d+)/.exec(a.dev);
    enterStation(st.id, { cabinIndex });
    if (cabinIndex != null && cl) {
      setTimeout(() => selectCluster('C-' + String(cl[1]).padStart(2, '0')), 1500);
    }
    toast('已定位：' + st.short + ' · ' + a.dev);
  }

  /* ================= 场景交互 ================= */
  function onSceneSelect(o) {
    if (!o) return;
    if (o.kind === 'pin') {
      if (o.id === 'HUB') {
        toast('并网汇集点 220kV · 汇集功率 ' + (regionPower() >= 0 ? '+' : '') + fmt(regionPower()) + ' MW');
        return;
      }
      if (state.level !== 0 || state.focusing) return;
      const st = DATA.stationById(o.id);
      if (!st) return;
      state.focusing = true;
      twin.flyTo({ target: { x: st.x, y: 0, z: st.z }, dist: 520, pitch: 0.74 }, 620);
      setTimeout(() => {
        enterStation(st.id);
        state.focusing = false;
      }, 560);
      return;
    }
    if (o.data) {
      if (o.data.type === 'cabin' && state.level === 1) goCabin(o.data.cabinIndex);
      if (o.data.type === 'cluster' && state.level >= 2) selectCluster(o.data.clusterId);
    }
  }

  function onSceneHover(hit) {
    const tip = $('#twinTip');
    if (!hit) { tip.classList.remove('on'); return; }
    const o = hit.obj;
    let html = '';

    if (o.kind === 'pin') {
      if (o.id === 'HUB') {
        html = `<span class="k">并网汇集点 · 220kV</span><b>区域汇集站</b>
          <div class="row"><span>汇集功率</span><em>${(regionPower() >= 0 ? '+' : '') + fmt(regionPower())} MW</em></div>
          <div class="row"><span>接入</span><em>${DATA.STATIONS.length} 座储能站</em></div>`;
      } else {
        const st = DATA.stationById(o.id);
        html = `<span class="k">储能站 · ${st.type}</span><b>${st.name}</b>
          <div class="row"><span>SOC / SOH</span><em>${fmt(st.soc)}% / ${fmt(st.soh)}%</em></div>
          <div class="row"><span>实时功率</span><em>${(st.power >= 0 ? '+' : '') + fmt(st.power)} MW</em></div>
          <div class="row"><span>未闭环告警</span><em>${st.openAlerts} 条</em></div>
          <div class="row" style="margin-top:3px;color:#5f7b8d">点击进入站内孪生 ›</div>`;
      }
    } else if (o.data && o.data.type === 'cabin') {
      const st = getStation();
      const cab = st.cabinList[o.data.cabinIndex];
      html = `<span class="k">电池舱 · ${st.short}</span><b>${cab.name}</b>
        <div class="row"><span>SOC / SOH</span><em>${fmt(cab.soc)}% / ${fmt(cab.soh)}%</em></div>
        <div class="row"><span>舱内温度</span><em>${fmt(cab.temp)} ℃</em></div>
        <div class="row"><span>电池簇</span><em>12 簇 / 在线 12</em></div>
        <div class="row" style="margin-top:3px;color:#5f7b8d">点击进入舱内簇群 ›</div>`;
    } else if (o.data && o.data.type === 'cluster') {
      const cab = getCabin();
      const cl = cab.clusters.find(c => c.id === o.data.clusterId);
      html = `<span class="k">电池簇 · ${cab.name}</span><b>${cl.id}</b>
        <div class="row"><span>SOC / SOH</span><em>${fmt(cl.soc)}% / ${fmt(cl.soh)}%</em></div>
        <div class="row"><span>温度 / 压差</span><em>${fmt(cl.temp)}℃ / ${cl.voltDiff}mV</em></div>
        <div class="row"><span>状态</span><em>${cl.status === 'warn' ? '温度偏高' : '正常运行'}</em></div>
        <div class="row" style="margin-top:3px;color:#5f7b8d">点击查看 BMS 详情 ›</div>`;
    }

    tip.innerHTML = html;
    tip.classList.add('on');
    const w = tip.offsetWidth;
    let left = hit.x + 14;
    if (left + w > window.innerWidth - 12) left = hit.x - w - 18;
    tip.style.left = left + 'px';
    tip.style.top = hit.y + 'px';
  }

  /* ================= 汇总渲染 ================= */
  function renderAll() {
    renderHeader();
    renderStations();
    renderAlerts();
    renderMetrics();
    renderCharts();
    renderBottom();
    renderCrumbs();
    renderStageCard();
  }

  /* ================= AI 抽屉 ================= */
  function drawerHTML() {
    const st = DATA.stationById('S01');
    const e = DATA.todayEnergy(null);
    const rev = e.revenue;
    return `
      <div class="ai-sec">
        <div class="ai-sec-hd">异常根因推荐<span class="tag crit">置信度 86%</span></div>
        <div class="ai-lead">识别到 <b>${st.short} 2#电池舱 C-07</b> 单体电压极差持续扩大（320mV），伴随局部温升 2.4℃，判定为<b>液冷支路流量不足</b>引发的一致性劣化，非采样异常。</div>
        <div class="cause"><span class="rank">01</span><span class="txt">液冷支路流量不足 / 快插接头半堵</span><span class="pbar"><u style="width:86%"></u></span><span class="pct">86%</span></div>
        <div class="cause"><span class="rank">02</span><span class="txt">单体一致性劣化（C-07 vs 簇均值）</span><span class="pbar"><u style="width:54%"></u></span><span class="pct">54%</span></div>
        <div class="cause"><span class="rank">03</span><span class="txt">采样线束接触电阻偏大</span><span class="pbar"><u style="width:23%"></u></span><span class="pct">23%</span></div>
        <div class="ai-note">建议：将该簇充放电倍率降至 0.3C，30 分钟内现场检查液冷快插接头与流量传感器；期间保持在线监测，压差回落至 120mV 以下自动解除限流。</div>
        <div class="ai-actions">
          <button class="btn primary" data-ai="ticket">生成检修工单</button>
          <button class="btn ghost" data-ai="ignore">暂不处理</button>
        </div>
      </div>

      <div class="ai-sec">
        <div class="ai-sec-hd">储能收益预估<span class="tag acc">模型 v3.2</span></div>
        <div class="rev-grid">
          <div class="rev-card"><label>今日累计收益</label><b>${fmt(rev, 1)}<i>万元</i></b><span>环比昨日 +6.2%</span></div>
          <div class="rev-card"><label>月度预估</label><b>${fmt(rev * 30 / 100, 0)}<i>百万元</i></b><span>按当前策略外推</span></div>
        </div>
        <div class="ai-bars">
          <div class="ai-bar-row"><span>峰谷套利</span><span class="track"><i style="width:68%;background:#3fb6c9"></i><i style="width:32%;background:rgba(63,182,201,.12)"></i></span><em>68%</em></div>
          <div class="ai-bar-row"><span>调频补偿</span><span class="track"><i style="width:19%;background:#5e8fbb"></i><i style="width:81%;background:rgba(94,143,187,.12)"></i></span><em>19%</em></div>
          <div class="ai-bar-row"><span>容量租赁</span><span class="track"><i style="width:13%;background:#3ea87b"></i><i style="width:87%;background:rgba(62,168,123,.12)"></i></span><em>13%</em></div>
        </div>
        <div class="ai-note">若明日 17:30 晚峰前将集群 SOC 提升至 85%，预计可增加放电量 62MWh，收益 +3.2 万元；需同步评估 04:00 谷段充电容量与变压器负载率。</div>
        <div class="ai-actions">
          <button class="btn primary" data-ai="adopt">采纳调度建议</button>
        </div>
        <div class="ai-log">
          14:02:11 · 生成根因推理（C-07）<br>
          13:58:40 · 策略收益重算完成<br>
          13:40:02 · 读取 AGC 调频指令
        </div>
      </div>`;
  }

  function openDrawer() {
    $('#drawerBody').innerHTML = drawerHTML();
    $('#aiDrawer').classList.add('on');
    $('#aiDrawer').setAttribute('aria-hidden', 'false');
    syncDrawerMask();
  }
  function closeDrawer() {
    $('#aiDrawer').classList.remove('on');
    $('#aiDrawer').setAttribute('aria-hidden', 'true');
    syncDrawerMask();
  }

  /* ================= 布局适配 ================= */
  /* v0.9.4：流式布局——去掉整屏 scale（字号不再被视口压缩），
     字号固定 px（正文 ≥15px），网格列宽弹性收缩，拓扑/图表按容器实际尺寸渲染。
     标注层仍按 1920 设计坐标，用 --anno-s 等比换算。 */
  function fitScreen() {
    window.APP_SCALE = 1;
    const app = $('#app');
    app.style.transform = '';
    document.body.style.height = '';
    document.documentElement.style.setProperty('--anno-s', (window.innerWidth / 1920).toFixed(4));
    if (twin) twin.resize();
  }

  /* ================= 事件 ================= */
  function bindEvents() {
    $('#stationFilters').addEventListener('click', e => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      state.stationFilter = btn.dataset.filter;
      renderStations();
    });

    $('#stationList').addEventListener('click', e => {
      const row = e.target.closest('.st-row');
      if (!row) return;
      if (row.dataset.id === state.stationId && state.level > 0) return;
      enterStation(row.dataset.id);
    });

    $('#alertFilters').addEventListener('click', e => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      state.alertFilter = btn.dataset.filter;
      renderAlerts();
    });

    $('#alertList').addEventListener('click', e => {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'limit') {
        state.alertLimit = state.alertLimit === 5 ? 0 : 5;
        renderAlerts();
        return;
      }
      const row = e.target.closest('.al-row');
      if (!row) return;
      const a = DATA.ALERTS.find(x => x.id === row.dataset.id);
      if (!a) return;

      /* v1.3：批量模式下整行即勾选项（行内操作按钮由 CSS 收起，避免「勾选」与「处置」误触） */
      if (state.batch) {
        e.stopPropagation();
        pickAlert(a.id);
        return;
      }

      if (act) {
        const kind = act.dataset.act;
        e.stopPropagation();
        if (kind === 'ack') setAlertStatus(a, 1, '确认告警');
        else if (kind === 'close') setAlertStatus(a, 2, '闭环告警');
        else if (kind === 'locate') focusAlert(a);
        return;
      }
      focusAlert(a);
    });

    /* v1.3：批量处置工具条 */
    $('#btnAlertBatch').addEventListener('click', () => toggleBatch());
    $('#alertBatchBar').addEventListener('click', e => {
      const btn = e.target.closest('[data-batch]');
      if (!btn) return;
      const kind = btn.dataset.batch;
      if (kind === 'ack' || kind === 'close') applyBatch(kind);
      else if (kind === 'undo') undoLast();
      else if (kind === 'cancel') toggleBatch(false);
    });

    /* v1.3：操作审计抽屉 */
    $('#navAudit').addEventListener('click', e => { e.preventDefault(); openAudit(); });
    $('#auditClose').addEventListener('click', closeAudit);
    $('#auditBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-audit-act]');
      if (!btn) return;
      if (btn.dataset.auditAct === 'csv') exportAuditCsv();
      if (btn.dataset.auditAct === 'clear') {
        auditLog = [];
        auditSave();
        renderAudit();
        const n = $('#auditCount');
        if (n) n.textContent = '0';
        toast('审计记录已清空（演示环境本地清理）', 'warn');
      }
    });

    $('#strategySeg').addEventListener('click', e => {
      const btn = e.target.closest('[data-strategy]');
      if (!btn) return;
      applyStrategy(btn.dataset.strategy);
    });

    $('#layerToggles').addEventListener('click', e => {
      const btn = e.target.closest('[data-layer]');
      if (!btn) return;
      const key = btn.dataset.layer;
      state.layers[key] = !state.layers[key];
      btn.classList.toggle('is-on', state.layers[key]);
      applyScene({ keepCam: true });
    });

    $('#btnTopView').addEventListener('click', () => {
      state.topView = !state.topView;
      $('#btnTopView').textContent = state.topView ? '3D' : '2D';
      twin.setTopView(state.topView);
    });

    $('#btnReset').addEventListener('click', () => {
      state.topView = false;
      $('#btnTopView').textContent = '2D';
      twin.resetView();
    });

    $('#btnScopeBack').addEventListener('click', goUp);

    $('#crumbs').addEventListener('click', e => {
      const btn = e.target.closest('[data-nav]');
      if (!btn) return;
      const nav = btn.dataset.nav;
      if (nav === 'region') goRegion();
      if (nav === 'station' && state.level > 1) {
        state.level = 1; state.cabinIndex = null; state.clusterId = null;
        fadeSwap(() => { applyScene(); renderAll(); });
      }
      if (nav === 'cabin' && state.level === 3) goUp();
    });

    $('#stageCard').addEventListener('click', e => {
      if (e.target.closest('[data-back]')) { goUp(); return; }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'first-cabin') goCabin(0);
      if (btn.dataset.act === 'first-cluster') selectCluster(getCabin().clusters[0].id);
      if (btn.dataset.act === 'ticket') toast('已生成检修工单 #DT-' + new Date().getTime().toString().slice(-6));
    });

    $('#chartTabs').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      state.chartTab = btn.dataset.tab;
      $$('#chartTabs button').forEach(b => b.classList.toggle('on', b === btn));
      renderCharts();
    });

    $('#btnChartMore').addEventListener('click', () => {
      const panel = $('#chartsPanel');
      const folded = panel.classList.toggle('folded');
      $('#btnChartMore').textContent = folded ? '明细 ▸' : '明细 ▾';
      if (!folded) {
        /* v1.2.2：双帧 raf——等 flex 权重切换触发的布局稳定后再读 clientWidth 绘图，
           否则 SVG 按过期宽度绘制（mini 图溢出面板右缘的根因） */
        requestAnimationFrame(() => requestAnimationFrame(renderCharts));
      }
    });

    $('#btnNavMore').addEventListener('click', e => {
      e.stopPropagation();
      $('#navMenu').hidden = !$('#navMenu').hidden;
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('#navMore')) $('#navMenu').hidden = true;
    });

    /* 紧凑密度开关（v0.9.9）：折叠底部策略条 → 主视图回升；localStorage 记住选择 */
    const applyCompact = on => {
      document.body.classList.toggle('compact', on);
      $('#btnCompact').classList.toggle('is-on', on); /* v1.1：图标化后用态样式区分 */
      if (twin) twin.resize();
    };
    let compactOn = false;
    try { compactOn = localStorage.getItem('uiCompact') === '1'; } catch (e) {}
    applyCompact(compactOn);
    $('#btnCompact').addEventListener('click', () => {
      compactOn = !compactOn;
      try { localStorage.setItem('uiCompact', compactOn ? '1' : '0'); } catch (e) {}
      applyCompact(compactOn);
    });

    /* 驾驶舱模式（v1.2）：投屏态——隐藏左右面板与底栏，只留主视图与顶栏 KPI；C 键 / 顶栏按钮切换，localStorage 记忆 */
    const applyCockpit = on => {
      document.body.classList.toggle('cockpit', on);
      $('#btnCockpit').classList.toggle('is-on', on);
      if (twin) twin.resize();
    };
    let cockpitOn = false;
    try { cockpitOn = localStorage.getItem('uiCockpit') === '1'; } catch (e) {}
    applyCockpit(cockpitOn);
    $('#btnCockpit').addEventListener('click', () => {
      cockpitOn = !cockpitOn;
      try { localStorage.setItem('uiCockpit', cockpitOn ? '1' : '0'); } catch (e) {}
      applyCockpit(cockpitOn);
      toast(cockpitOn ? '驾驶舱模式 · 按 C 或再次点击退出' : '已退出驾驶舱模式');
    });

    $('#btnAiDrawer').addEventListener('click', openDrawer);
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', () => { closeDrawer(); closeAudit(); });

    $('#drawerBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-ai]');
      if (!btn) return;
      if (btn.dataset.ai === 'adopt') {
        closeDrawer();
        toast('已采纳 AI 调度建议，生成建议单 #DT-20261105-014');
      } else if (btn.dataset.ai === 'ticket') {
        closeDrawer();
        toast('检修工单已下发至锡山站运维班组');
      } else {
        closeDrawer();
        toast('已记录为人工复核项', 'warn');
      }
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if ($('#auditDrawer').classList.contains('on')) closeAudit();
        else if (state.batch) toggleBatch(false);
        else if ($('#aiDrawer').classList.contains('on')) closeDrawer();
        else goUp();
      }
      /* v1.1.1：Space 暂停/恢复实时刷新（值守键盘流；输入框/按钮聚焦时不拦截，避免吞掉按钮的空格激活） */
      if (e.code === 'Space' && !e.repeat && !/INPUT|TEXTAREA|BUTTON|SELECT/.test(e.target.tagName)) {
        e.preventDefault();
        state.paused = !state.paused;
        toast(state.paused ? '实时刷新已暂停 · 按 Space 恢复' : '实时刷新已恢复');
      }
      /* v1.2：C 切换驾驶舱模式（投屏态，Ctrl/Alt 等修饰组合不拦截） */
      if ((e.key === 'c' || e.key === 'C') && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {
        cockpitOn = !cockpitOn;
        try { localStorage.setItem('uiCockpit', cockpitOn ? '1' : '0'); } catch (err) {}
        applyCockpit(cockpitOn);
        toast(cockpitOn ? '驾驶舱模式 · 按 C 退出' : '已退出驾驶舱模式');
      }
      /* v1.3：A 开关操作审计抽屉 */
      if ((e.key === 'a' || e.key === 'A') && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {
        if ($('#auditDrawer').classList.contains('on')) closeAudit();
        else openAudit();
      }
      /* v1.3：Ctrl+Z / Cmd+Z 撤销最近一次告警处置（拦截浏览器默认撤销语义） */
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
        e.preventDefault();
        undoLast();
      }
    });

    window.addEventListener('resize', fitScreen);
    /* v1.3.2：宽度跨断点变化时重绘图表——svg 按生成时的 clientWidth 定坐标，
       不重绘会在 4K↔1280 拖动窗口后出现 Y 轴刻度贴边 / X 轴时刻粘连 */
    let lastChartW = 0;
    let chartRT = null;
    window.addEventListener('resize', () => {
      clearTimeout(chartRT);
      chartRT = setTimeout(() => {
        const w = Math.round(document.getElementById('chartsPanel').getBoundingClientRect().width);
        if (w !== lastChartW) { lastChartW = w; renderCharts(); }
      }, 160);
    });

    ['chartMain', 'chartTemp', 'chartHealth'].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('chart-hover', e => { el.dataset.hover = e.detail ? '1' : '0'; });
    });
  }

  /* ================= 启动 ================= */
  /* v2.0 数据链路接入：消息协议即接口边界（docs/data-contract.md）。
     三种模式：
       ?ws=mock        内置模拟推送（演示；hz=N 调频率、chaos=1 附随机告警流）
       ?ws=live        连 config.js 里的桥接服务
       ?ws=ws://...    临时指向任意网关
       缺省             按 config.js source（'mock'=纯静态演示 / 'ws'=生产实时）
     防御：高频推送下渲染节流 ≤2Hz；告警池上限 40 条；坏帧丢弃计数（dataio.js）。 */
  const LIVE_LV = { crit: '紧急', high: '重要', warn: '一般', info: '提示' };
  let liveDirty = false, liveLast = 0, liveBridge = '';

  function liveFlush() {
    refreshLive();
    renderHeader();
    renderMetrics();
    renderCharts();
    renderBottom();
    const sc = currentScene();
    twin.setScene(sc, { keepCam: true, selectedId: state.level === 3 ? state.clusterId : null });
  }

  function handleLiveMsg(m) {
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    if (m.t === 'scada') {
      const list = Array.isArray(m.stations) ? m.stations : [m];
      list.forEach(s => {
        const st = DATA.stationById(s.id);
        if (!st) return;
        if (typeof s.power === 'number' && isFinite(s.power)) st.power = s.power;
        if (typeof s.soc === 'number' && isFinite(s.soc)) st.soc = s.soc;
        if (typeof s.soh === 'number' && isFinite(s.soh)) st.soh = s.soh;
        if (typeof s.temp === 'number' && isFinite(s.temp)) st.temp = s.temp;
        if (s.status) st.status = s.status;
        if (s.comm) st.comm = s.comm;
        liveDirty = true;
      });
    } else if (m.t === 'alert' && (m.alert || m.id)) {
      const a = m.alert || m;
      if (DATA.ALERTS.length >= 40) DATA.ALERTS.shift();
      DATA.ALERTS.push({ id: a.id, st: a.st, lv: a.lv, lvName: LIVE_LV[a.lv] || a.lv, dev: a.dev || '遥测', text: a.text, time: a.time || DATA.hm(new Date()), age: 0, status: 0 });
      renderAlerts(); renderStations(); syncCritPulse(); applyScene();
      liveDirty = true;
    } else if (m.t === 'alertAck' || m.t === 'alertState') {
      const a = DATA.ALERTS.find(x => x.id === m.id);
      const to = m.t === 'alertAck' ? 1 : m.status;
      if (a && typeof to === 'number' && a.status !== to) {
        a.status = to;
        renderAlerts(); renderStations(); syncCritPulse();
        liveDirty = true;
      }
    } else if (m.t === 'history' || m.t === 'cluster') {
      liveDirty = true;   /* 缓存已由 DataIO 落 Map，此处只需触发重渲 */
    } else if (m.t === 'opAck') {
      /* 反向控制终态：投递失败 → 回滚本地状态并明示用户（状态以桥接为准，不猜） */
      if (m.delivered === false) {
        const ids = String(m.op || '').split(',');
        let rolled = 0;
        ids.forEach(id => {
          const a = DATA.ALERTS.find(x => x.id === id);
          if (a && a.status !== 0) { a.status = 0; rolled++; }
        });
        if (rolled) { renderAlerts(); renderStations(); syncCritPulse(); }
        toast('处置指令投递失败（重试 ' + (m.tries || 0) + ' 次未达 broker），已回退本地状态', 'warn');
        console.warn('[opAck] dead-letter:', m.op, m.action);
      }
    }
    /* hello / ping / pong：链路层，无需处理 */
    const now = performance.now();
    if (liveDirty && now - liveLast >= 500) { liveDirty = false; liveLast = now; liveFlush(); }  // 节流：10Hz 推送 → 2Hz 渲染
  }

  /* 顶栏数据链路角标：演示数据 / 模拟推送 / 实时 / 重连 Ns */
  function renderSrcBadge() {
    const el = document.getElementById('hdrSrc');
    if (!el) return;
    const s = DataIO.status();
    if (s.mode === 'ws') {
      if (s.connected) {
        el.textContent = '实时'; el.className = 'ok';
        el.title = '实时链路已连接（' + s.msgCount + ' 帧' + (liveBridge ? ' · 源 ' + liveBridge : '') + '）';
      }
      else { el.textContent = '重连 ' + s.nextRetrySec + 's'; el.className = 'warn'; el.title = '链路断开，指数退避重连中'; }
    } else if (s.mode === 'mock') {
      el.textContent = '模拟推送'; el.className = 'warn'; el.title = '?ws=mock 演示推送';
    } else {
      el.textContent = '演示数据'; el.className = 'dim'; el.title = '纯静态演示（config.js source 改 ws 接真实数据）';
    }
  }

  function connectLive() {
    const q = new URLSearchParams(location.search);
    const p = q.get('ws');
    if (p === 'mock') {
      DataIO.setModeMock();
      renderSrcBadge();
      const hz = Math.min(20, parseInt(q.get('hz') || '2', 10) || 2);
      const ws = new DATA.MockWS(hz, q.get('chaos') === '1').connect();
      ws.onmessage = e => { try { handleLiveMsg(JSON.parse(e.data)); } catch (err) { /* 坏帧丢弃 */ } };
      return ws;
    }
    const urlOverride = (p && p !== 'live' && /^wss?:\/\//.test(p)) ? p : null;
    const wantLive = p === 'live' || !!urlOverride || window.DATA_CONFIG.source === 'ws';
    if (!wantLive) { DataIO.init({}); renderSrcBadge(); return null; }
    DataIO.init({
      onScada: stations => handleLiveMsg({ t: 'scada', stations }),
      onAlert: alert => handleLiveMsg({ t: 'alert', alert }),
      onAlertState: m => handleLiveMsg(m),
      onOpAck: m => handleLiveMsg(m),
      onHistory: () => { liveDirty = true; },
      onCluster: () => { liveDirty = true; },
      onHello: m => { liveBridge = (m && m.bridge) || ''; renderSrcBadge(); },
      onStatus: renderSrcBadge
    }, urlOverride ? { mode: 'ws', url: urlOverride } : { mode: 'ws' });
    renderSrcBadge();
    return null;
  }

  function start() {
    fitScreen();
    auditLoad();          /* v1.3：先读本地审计记录，再渲染（菜单计数与抽屉一致） */
    applyScenarioFromURL();
    refreshLive();

    tickClock();
    setInterval(tickClock, 1000);
    setInterval(renderSrcBadge, 1000);   /* v2.0：链路角标（重连秒数倒计） */

    twin = new Twin($('#twinCanvas'), {
      onSelect: onSceneSelect,
      onHover: onSceneHover
    });
    twin.lightweight = FX_DEFAULT_LITE;
    /* v1.1.1：系统开启「减弱动态」时自动进入轻量化（脉冲/流光静止），镜头本身无自动旋转 */
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) twin.lightweight = true;

    applyScene();
    bindEvents();
    initDemoPanel();
    demoSync();
    renderAll();
    connectLive(); /* v1.2：?ws=mock 时接通模拟 WS 数据源（默认关闭不破坏确定性演示） */
    if (window.Monitor) window.Monitor.start(10000); /* v2.2：前端遥测上报（FPS/Heap/重连/数据新鲜度 → /metrics） */

    setInterval(() => {
      if (state.linkDown || state.paused) return;   // 断连降级 / 手动暂停：冻结数据帧，视图保持最后快照
      state.tickCount++;
      refreshLive();
      renderHeader();
      renderMetrics();
      renderCharts();
      renderBottom();
      const sc = currentScene();
      twin.setScene(sc, { keepCam: true, selectedId: state.level === 3 ? state.clusterId : null });
      if (state.tickCount % 8 === 0) renderStations();
    }, 2500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
