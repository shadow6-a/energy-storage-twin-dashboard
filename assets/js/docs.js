/* 组件规范页交互 */
(function () {
  'use strict';

  /* ---------- 色板 ---------- */
  const COLORS = [
    ['背景 / 最深', '#05080E', '页面底色'],
    ['背景 / 面板', '#0C1623', '面板渐变起点'],
    ['背景 / 浮层', '#0F1B28', 'HUD / 抽屉'],
    ['描边 / 弱', 'rgba(126,163,196,.13)', '面板边框'],
    ['描边 / 强', 'rgba(126,163,196,.34)', '悬浮 / 选中边框'],
    ['文本 / 主', '#E2EBF5', '标题与关键数值'],
    ['文本 / 次', '#A2B6C9', '正文'],
    ['文本 / 弱', '#728799', '辅助说明'],
    ['主色 / 青蓝', '#3FB6C9', '充电 · 选中 · 图表主色'],
    ['辅色 / 钢蓝', '#5E8FBB', '计划线 · 汇集点'],
    ['状态 / 正常', '#3EA87B', '在线 · 健康「优」'],
    ['状态 / 提示', '#D8B24A', '一般告警 · 关注'],
    ['状态 / 重要', '#DF8A2E', '重要告警 · 超温'],
    ['状态 / 紧急', '#E0523F', '紧急告警 · 预警'],
    ['状态 / 离线', '#5B6B7A', '通信中断'],
    ['放电 / 琥珀', '#DFAB52', '并网上网 · 流出']
  ];
  const sw = document.getElementById('swatches');
  if (sw) {
    sw.innerHTML = COLORS.map(([name, val, use]) => `
      <div class="swatch" data-val="${val}" title="点击复制">
        <div class="chip-c" style="background:${val}"></div>
        <div class="inf"><b>${name}</b><span>${val}</span></div>
      </div>`).join('');
    sw.addEventListener('click', e => {
      const item = e.target.closest('.swatch');
      if (!item) return;
      const val = item.dataset.val;
      const done = () => {
        item.classList.add('copied');
        setTimeout(() => item.classList.remove('copied'), 1200);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(val).then(done, done);
      else done();
    });
  }

  /* ---------- 告警样本 ---------- */
  const alertSamples = [
    { cls: 'crit', lv: '紧急', time: '2 分钟前', st: '未确认', text: '单体电压极差 320mV，超阈值 200mV，持续 6 分钟', act: '确认' },
    { cls: 'high', lv: '重要', time: '25 分钟前', st: '已确认', text: '冷却液出水温度 32.8℃，超告警阈值 30℃', act: '闭环' },
    { cls: 'warn', lv: '一般', time: '1 小时前', st: '已抑制', text: '回风温度 31.4℃ 偏高，制冷量不足预警', act: '' },
    { cls: 'info', lv: '提示', time: '3 小时前', st: '已闭环', text: '站用电已切换至备用回路，供电正常', act: '' }
  ];
  const as = document.getElementById('alertSamples');
  if (as) {
    as.innerHTML = alertSamples.map(a => `
      <div class="al-row ${a.cls} ${a.st === '已闭环' || a.st === '已抑制' ? 'done' : ''}" style="cursor:default">
        <div class="al-top">
          <span class="lv-tag ${a.cls}">${a.lv}</span>
          <span class="al-time">${a.time}</span>
          <span class="al-status ${a.st === '未确认' ? 's0' : a.st === '已确认' ? 's1' : a.st === '已闭环' ? 's2' : 's3'}">${a.st}</span>
        </div>
        <div class="al-txt">${a.text}</div>
        <div class="al-foot">
          <span>无锡锡山储能站 · 2#电池舱</span>
          <span class="sp">${a.act ? `<button class="al-act">${a.act}</button>` : ''}<button class="al-act">定位 ›</button></span>
        </div>
      </div>`).join('');
  }

  /* ---------- 指标卡样本 ---------- */
  const ms = document.getElementById('metricShowcase');
  if (ms) {
    ms.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;width:100%">
        <div class="m-card">
          <div class="m-lab"><span>总 SOC</span><span class="d">WEIGHTED</span></div>
          <div class="m-val">62.4<i>%</i></div>
          <div class="m-sub">较昨日同时段 <em>+1.8%</em></div>
        </div>
        <div class="m-card okc">
          <div class="m-lab"><span>总 SOH</span><span class="d">HEALTH</span></div>
          <div class="m-val">94.3<i>%</i></div>
          <div class="m-sub">最低 89.7% · 南通如东</div>
        </div>
        <div class="m-card">
          <div class="m-lab"><span>充放电状态</span><span class="d">MODE</span></div>
          <div class="m-val txt">放电中</div>
          <div class="m-sub">实时 <em>+186.4 MW</em></div>
        </div>
        <div class="m-card warnc">
          <div class="m-lab"><span>电网交互功率</span><span class="d">GRID</span></div>
          <div class="m-val">+186.4<i>MW</i></div>
          <div class="m-sub">上网 · 功率因数 0.96</div>
        </div>
        <div class="m-card wide">
          <div class="m-wide-l">
            <div class="m-lab"><span>今日充放电量</span><span class="d">截至 17:14</span></div>
            <div class="m-sub">峰谷套利收益 <em>¥642.6 万</em></div>
          </div>
          <div class="m-wide-r">
            <div>充电<b class="ch">986<i>MWh</i></b></div>
            <div>放电<b class="dis">1042<i>MWh</i></b></div>
          </div>
        </div>
      </div>`;
  }

  /* ---------- chip 样本 ---------- */
  const cw = document.getElementById('chipWall');
  if (cw) {
    cw.innerHTML = `
      <button class="chip is-on">全部 <i>8</i></button>
      <button class="chip">告警 <i>3</i></button>
      <button class="chip lv-crit is-on">紧急 <i>2</i></button>
      <button class="chip lv-high">重要 <i>4</i></button>
      <button class="chip lv-warn is-on">一般 <i>3</i></button>
      <button class="chip lv-info">提示 <i>1</i></button>`;
    cw.addEventListener('click', e => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      btn.parentElement.querySelectorAll('.chip').forEach(c => c.classList.remove('is-on'));
      btn.classList.add('is-on');
    });
  }

  /* ---------- 3D 信标样本 ---------- */
  function pinSVG(color, opts) {
    opts = opts || {};
    const pulse = opts.pulse ? `
      <ellipse cx="46" cy="76" rx="30" ry="10" fill="none" stroke="#E0523F" stroke-opacity=".4" stroke-width="1.2"/>` : '';
    const badge = opts.badge ? `
      <circle cx="54" cy="30" r="6" fill="#C8452F"/>
      <text x="54" y="33" text-anchor="middle" font-size="8" fill="#fff" font-family="Bahnschrift,Consolas">${opts.badge}</text>` : '';
    const selected = opts.selected ? `
      <ellipse cx="46" cy="82" rx="34" ry="11.5" fill="none" stroke="#3FB6C9" stroke-width="1.2" stroke-dasharray="5 3"/>
      <path d="M6 62 v-8 h8 M86 62 v-8 h-8 M6 94 v8 h8 M86 94 v8 h-8" fill="none" stroke="#3FB6C9" stroke-width="1.4" stroke-opacity=".85"/>` : '';
    return `
      <svg width="92" height="112" viewBox="0 0 92 112">
        <ellipse cx="46" cy="82" rx="26" ry="8.5" fill="rgba(63,182,201,.07)" stroke="rgba(126,163,196,.25)" stroke-width="1"/>
        ${pulse}
        ${selected}
        <line x1="46" y1="82" x2="46" y2="38" stroke="rgba(126,163,196,.5)" stroke-width="1.4"/>
        <path d="M46 30 L54 38 L46 46 L38 38 Z" fill="rgba(9,18,26,.92)" stroke="${color}" stroke-width="1.6"/>
        <circle cx="46" cy="38" r="2.2" fill="${color}"/>
        ${badge}
        <rect x="16" y="4" width="60" height="20" rx="2" fill="rgba(8,15,23,.9)" stroke="rgba(126,163,196,.25)"/>
        <text x="46" y="12" text-anchor="middle" font-size="8.5" fill="#d3e3f0" font-family="HarmonyOS Sans SC,Microsoft YaHei">${opts.name || '站点'}</text>
        <text x="46" y="21" text-anchor="middle" font-size="7" fill="#8ea3b7" font-family="Bahnschrift,Consolas">${opts.sub || '62.4% · 0.0 MW'}</text>
      </svg>`;
  }
  const pd = document.getElementById('pinDemo');
  if (pd) {
    pd.innerHTML = `
      <div class="p">${pinSVG('#3EA87B', { name: '待机', sub: '66.8% · +0.2MW' })}<span>正常 / 待机</span></div>
      <div class="p">${pinSVG('#DFAB52', { name: '放电', sub: '58.7% · +68MW' })}<span>放电中</span></div>
      <div class="p">${pinSVG('#E0523F', { name: '告警', sub: '62.0% · 2 条', pulse: true, badge: 2 })}<span>紧急告警（脉冲）</span></div>
      <div class="p">${pinSVG('#5B6B7A', { name: '离线', sub: '快照数据' })}<span>通信中断</span></div>
      <div class="p">${pinSVG('#3FB6C9', { name: '选中', sub: '锡山 · 聚焦中', selected: true })}<span>聚焦选中态</span></div>`;
  }

  /* ---------- 4×4 告警矩阵 ---------- */
  const mx = document.getElementById('alertMatrix');
  if (mx) {
    const states = [
      { k: 0, name: '未确认', cls: 's0' },
      { k: 1, name: '已确认', cls: 's1' },
      { k: 2, name: '已闭环', cls: 's2' },
      { k: 3, name: '已抑制', cls: 's3' }
    ];
    const levels = [
      { k: 'crit', name: '紧急', note: ['红色脉冲环 + 置顶 + 声音提示', '红色静态，解锁「闭环」', '透明度 45%，移出置顶区', '灰阶 + 「已抑制」，不计数'] },
      { k: 'high', name: '重要', note: ['橙色静态 + 置顶', '橙色静态，解锁「闭环」', '透明度 45%，移出置顶区', '灰阶 + 「已抑制」，不计数'] },
      { k: 'warn', name: '一般', note: ['琥珀静态，等级区内排序', '琥珀静态', '透明度 45%', '灰阶，窗口结束恢复'] },
      { k: 'info', name: '提示', note: ['蓝灰静态，默认折叠尾部', '蓝灰静态', '透明度 40%', '灰阶'] }
    ];
    mx.innerHTML = `<table class="spec-table">
      <tr><th>等级 \\ 状态</th>${states.map(s => `<th style="text-align:center">${s.name}</th>`).join('')}</tr>
      ${levels.map(l => `<tr>
        <td><span class="lv-tag ${l.k}">${l.name}</span></td>
        ${states.map((s, i) => `<td style="text-align:center">
          <div style="display:flex;align-items:center;justify-content:center;gap:5px;margin-bottom:4px">
            <span class="lv-tag ${l.k}" style="${s.k === 3 ? 'filter:grayscale(.7);opacity:.55' : s.k === 2 ? 'opacity:.6' : ''}">${l.name}</span>
            <span class="al-status ${s.cls}">${s.name}</span>
          </div>
          <div style="font-size:9.5px;color:var(--txt-4);line-height:1.5">${l.note[i]}</div>
        </td>`).join('')}
      </tr>`).join('')}
    </table>`;
  }

  /* ---------- 开关与下拉样本 ---------- */
  const cw2 = document.getElementById('ctrlWall');
  if (cw2) {
    cw2.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:8px;font-size:11px;color:var(--txt-2)"><span class="switch on" data-sw></span>链路流向</span>
      <span style="display:inline-flex;align-items:center;gap:8px;font-size:11px;color:var(--txt-2)"><span class="switch" data-sw></span>告警脉冲</span>
      <span class="select" data-sel><b style="font-weight:400">筛选：全部等级</b>
        <span class="opt"><span>全部等级</span><span>紧急</span><span>重要</span><span>一般</span><span>提示</span></span>
      </span>`;
    cw2.addEventListener('click', e => {
      const sw = e.target.closest('[data-sw]');
      if (sw) { sw.classList.toggle('on'); return; }
      const sel = e.target.closest('[data-sel]');
      if (sel) {
        if (e.target.parentElement.classList.contains('opt')) {
          sel.querySelector('b').textContent = '筛选：' + e.target.textContent;
          sel.classList.remove('open');
        } else sel.classList.toggle('open');
      }
    });
  }

  /* ---------- 图表样本 ---------- */
  const area = document.getElementById('specArea');
  if (area && window.Charts) {
    const labels = [], plan = [], act = [];
    for (let i = 0; i < 96; i++) {
      const h = i * 0.25;
      labels.push(h);
      let p = 0;
      if (h < 6) p = -90; else if (h < 8) p = -90 + (h - 6) * 60;
      else if (h < 11) p = 120; else if (h < 17) p = 40 - Math.sin((h - 11) / 6 * Math.PI) * 60;
      else if (h < 21) p = 150; else p = 150 - (h - 21) * 40;
      plan.push(p);
      act.push(i < 68 ? p * 0.96 + Math.sin(i / 5) * 8 : null);
    }
    Charts.areaChart(area, {
      labels,
      series: [
        { data: plan, color: '#7d93a8', dashed: true, label: '计划' },
        { data: act, color: '#3fb6c9', label: '实际', fill: true }
      ],
      unit: 'MW', zeroLine: true, nowIndex: 68, xStep: 6
    });
  }

  const bar = document.getElementById('specBar');
  if (bar && window.Charts) {
    const vals = [27.6, 29.4, 33.8, 31.2, 35.2, 30.1, 28.8, 29.9];
    Charts.barChart(bar, {
      labels: ['江北', '锡山', '金坛', '吴江', '如东', '扬中', '仪征', '靖江'],
      values: vals,
      colors: vals.map(v => v >= 34 ? '#e0523f' : v >= 32 ? '#df8a2e' : v >= 30 ? '#d8b24a' : 'rgba(63,182,201,.62)'),
      threshold: 32, thresholdLabel: '告警 32℃', unit: '℃', max: 40
    });
  }

  const donut = document.getElementById('specDonut');
  if (donut && window.Charts) {
    Charts.donutChart(donut, {
      items: [
        { label: '优 ≥95%', value: 34, color: '#3ea87b' },
        { label: '良 92–95%', value: 22, color: '#3fb6c9' },
        { label: '关注 88–92%', value: 11, color: '#d8b24a' },
        { label: '预警 <88%', value: 5, color: '#e0523f' }
      ],
      centerValue: 72, centerLabel: 'CLUSTERS'
    });
  }

  /* ---------- 导航高亮 ---------- */
  const links = document.querySelectorAll('#navLinks a');
  const secs = document.querySelectorAll('.sec');
  const main = document.querySelector('.docs-main');
  if (main && secs.length) {
    main.addEventListener('scroll', () => {
      let cur = 0;
      secs.forEach((s, i) => { if (s.offsetTop - 40 <= main.scrollTop) cur = i; });
      links.forEach((a, i) => a.classList.toggle('on', i === cur));
    });
  }
})();
