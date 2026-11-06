/* ============================================================
   轻量图表（纯 SVG，无依赖）
   ============================================================ */
(function (global) {
  'use strict';

  const T = {
    grid: 'rgba(126,163,196,.10)',
    gridSoft: 'rgba(126,163,196,.06)',
    axis: '#5d7387',
    txt: '#7e93a6',
    cross: 'rgba(63,182,201,.45)'
  };

  let tipEl = null;
  function tip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'chart-tip';
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(html, x, y) {
    const el = tip();
    el.innerHTML = html;
    el.classList.add('on');
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.min(window.innerWidth - w - 12, x + 14);
    const top = Math.max(8, Math.min(window.innerHeight - h - 12, y - h - 10));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  function hideTip() { if (tipEl) tipEl.classList.remove('on'); }

  function fmt(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toFixed(d === undefined ? 1 : d);
  }

  function niceTicks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    let step;
    if (norm <= 1) step = 1; else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5; else if (norm <= 5) step = 5; else step = 10;
    step *= mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step * 0.001; v += step) ticks.push(+v.toFixed(6));
    return ticks;
  }

  /* 折线 + 面积（计划 / 实际） */
  function areaChart(host, opts) {
    if (!host) return;
    const w = host.clientWidth || 600;
    const h = host.clientHeight || 240;
    /* v1.3.2：窄容器（右栏 320~380px 时主图仅 ~300px）自适应内边距——
       否则 Y 轴刻度贴边、X 轴 7 个时刻标签互相粘连 */
    const compact = w < 360;
    const pad = { l: compact ? 42 : 56, r: compact ? 8 : 12, t: 10, b: compact ? 22 : 26 };
    const pw = Math.max(10, w - pad.l - pad.r);
    const ph = Math.max(10, h - pad.t - pad.b);
    const n = opts.labels.length;

    let vals = [];
    opts.series.forEach(s => s.data.forEach(v => { if (v !== null && v !== undefined) vals.push(v); }));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (opts.zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (opts.yMin !== undefined) lo = opts.yMin;
    if (opts.yMax !== undefined) hi = opts.yMax;
    const margin = (hi - lo) * 0.12 || 1;
    const ticks = niceTicks(lo - margin, hi + margin, 4);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];

    const X = i => pad.l + (i / (n - 1)) * pw;
    const Y = v => pad.t + (1 - (v - y0) / (y1 - y0)) * ph;

    let defs = '', body = '', hoverParts = '';

    // 网格 + y 轴
    ticks.forEach(t => {
      const y = Y(t);
      body += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="${t === 0 ? 'rgba(126,163,196,.28)' : T.grid}" stroke-width="1" ${t === 0 ? 'stroke-dasharray="2 3"' : ''}/>`;
      body += `<text x="${pad.l - (compact ? 6 : 9)}" y="${(y + 4.5).toFixed(1)}" text-anchor="end" font-size="${compact ? 10.5 : 13}" font-family="Bahnschrift,Consolas,monospace" fill="${T.axis}">${Math.abs(t) >= 100 ? t.toFixed(0) : t.toFixed(Math.abs(t) < 10 ? 1 : 0)}</text>`;
    });

    // x 轴（v1.3.2：窄容器自动降频 6h/8h 刻度，避免 00:00 04:00 … 粘连成黑块）
    const stepH = opts.xStep || (w < 300 ? 8 : (w < 400 ? 6 : 4));
    for (let hh = 0; hh <= 24; hh += stepH) {
      const i = Math.min(n - 1, Math.round(hh * 4));
      const x = X(i);
      body += `<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${h - pad.b}" stroke="${T.gridSoft}" stroke-width="1"/>`;
      body += `<text x="${x.toFixed(1)}" y="${h - 7}" text-anchor="middle" font-size="${compact ? 10.5 : 12.5}" font-family="Bahnschrift,Consolas,monospace" fill="${T.axis}">${String(hh).padStart(2, '0')}:00</text>`;
    }

    // 曲线
    opts.series.forEach((s, si) => {
      const pts = [];
      s.data.forEach((v, i) => { if (v !== null && v !== undefined) pts.push([X(i), Y(v), i, v]); });
      if (!pts.length) return;

      if (s.fill) {
        const gid = 'ag' + si + '-' + Math.random().toString(36).slice(2, 6);
        defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${s.color}" stop-opacity=".22"/>
          <stop offset="72%" stop-color="${s.color}" stop-opacity=".04"/>
          <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/>
        </linearGradient>`;
        let d = `M ${pts[0][0].toFixed(1)} ${h - pad.b}`;
        pts.forEach(p => { d += ` L ${p[0].toFixed(1)} ${p[1].toFixed(1)}`; });
        d += ` L ${pts[pts.length - 1][0].toFixed(1)} ${h - pad.b} Z`;
        body += `<path d="${d}" fill="url(#${gid})"/>`;
      }

      let d = '';
      pts.forEach((p, k) => { d += (k === 0 ? 'M ' : ' L ') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); });
      body += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || (s.dashed ? 1.2 : 1.6)}" stroke-linejoin="round" stroke-linecap="round" ${s.dashed ? 'stroke-dasharray="4 3"' : ''} opacity="${s.opacity || 1}"/>`;

      // 末端点
      if (!s.dashed && s.data[s.data.length - 1] !== null && s.data[s.data.length - 1] !== undefined) {
        const p = pts[pts.length - 1];
        body += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.4" fill="#0a141f" stroke="${s.color}" stroke-width="1.4"/>`;
      }
    });

    // 当前时刻
    if (opts.nowIndex && opts.nowIndex < n - 1) {
      const x = X(opts.nowIndex);
      body += `<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${h - pad.b}" stroke="${T.cross}" stroke-width="1" stroke-dasharray="2 3"/>`;
    }

    hoverParts = `<g class="ch" style="opacity:0"><line y1="${pad.t}" y2="${h - pad.b}" stroke="rgba(63,182,201,.5)" stroke-width="1"/>
      ${opts.series.map((s, i) => `<circle r="3" fill="#0a141f" stroke="${s.color}" stroke-width="1.5" data-si="${i}"/>`).join('')}</g>`;

    host.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs>${body}
      <rect class="hit" x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}" fill="transparent" style="cursor:crosshair"/>
      ${hoverParts}</svg>`;

    // 交互
    const svg = host.querySelector('svg');
    const g = svg.querySelector('g.ch');
    const circles = g ? Array.from(g.querySelectorAll('circle')) : [];
    const hit = svg.querySelector('.hit');
    hit.addEventListener('mousemove', e => {
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / w || 1;
      const px = (e.clientX - rect.left) / scale;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / pw) * (n - 1))));
      g.style.opacity = '1';
      const line = g.querySelector('line');
      line.setAttribute('x1', X(i)); line.setAttribute('x2', X(i));
      let rows = `<div style="color:#9fb6c8;margin-bottom:3px">${opts.tipLabel ? opts.tipLabel(i) : DATA.hm(opts.labels[i])}</div>`;
      opts.series.forEach((s, si) => {
        const v = s.data[i];
        if (v === null || v === undefined) { circles[si].style.opacity = '0'; return; }
        circles[si].style.opacity = '1';
        circles[si].setAttribute('cx', X(i));
        circles[si].setAttribute('cy', Y(v));
        rows += `<div><span class="k" style="background:${s.color}"></span>${s.label} <b>${fmt(v, opts.dec)}</b> <span style="color:#5d7387">${opts.unit || ''}</span></div>`;
      });
      showTip(rows, e.clientX, e.clientY);
      host.dispatchEvent(new CustomEvent('chart-hover', { detail: true }));
    });
    hit.addEventListener('mouseleave', () => {
      g.style.opacity = '0'; hideTip();
      host.dispatchEvent(new CustomEvent('chart-hover', { detail: false }));
    });
  }

  /* 柱状图 */
  function barChart(host, opts) {
    if (!host) return;
    const w = host.clientWidth || 300;
    const h = host.clientHeight || 120;
    const isNarrow = w < 220;
    const pad = { l: 48, r: 8, t: 10, b: 22 };
    if (isNarrow) pad.l = 26;
    const pw = Math.max(10, w - pad.l - pad.r);
    const ph = Math.max(10, h - pad.t - pad.b);
    const vals = opts.values;
    const n = vals.length;
    let hi = Math.max(...vals);
    let lo = Math.min(0, ...vals);
    if (opts.max !== undefined) hi = opts.max;
    /* v1.3.2：矮容器（展开态 mini 图仅 ~60px 高）减刻度，否则 100/80/60/40/20 叠成一团 */
    const ticks = niceTicks(lo, hi * 1.12, ph < 64 ? 2 : 3);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const Y = v => pad.t + (1 - (v - y0) / (y1 - y0)) * ph;
    const bw = (pw / n) * 0.52;
    const step = pw / n;

    let body = '';
    ticks.forEach(t => {
      const y = Y(t);
      body += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="${t === 0 ? 'rgba(126,163,196,.26)' : T.grid}" stroke-width="1"/>`;
      body += `<text x="${pad.l - (isNarrow ? 5 : 7)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="${isNarrow ? 10.5 : 12}" font-family="Bahnschrift,Consolas,monospace" fill="${T.axis}">${t}</text>`;
    });

    if (opts.threshold !== undefined) {
      const y = Y(opts.threshold);
      body += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="rgba(223,138,46,.55)" stroke-width="1" stroke-dasharray="3 3"/>`;
      /* v1.2.2：阈值标签从右上角（与柱顶/折线重叠）移到左端线头上方，贴 pad.l 不压柱 */
      body += `<text x="${pad.l + 3}" y="${(y - 3.5).toFixed(1)}" text-anchor="start" font-size="11" fill="rgba(223,138,46,.85)">${opts.thresholdLabel || '阈值 ' + opts.threshold}</text>`;
    }

    vals.forEach((v, i) => {
      const x = pad.l + step * i + (step - bw) / 2;
      const y = Y(v);
      const bh = Math.max(1, h - pad.b - y);
      const c = opts.colors ? opts.colors[i] : 'rgba(63,182,201,.55)';
      body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${c}" rx="1"/>`;
      body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="1.5" fill="rgba(255,255,255,.22)"/>`;
      /* v1.2.2：窄容器（mini 列 ~160px）X 轴标签截断为后 2 字 + 9.5px——8 站名硬排会叠成黑块；
         hover 气泡仍显示 labels 全称（tipLabel 默认取 labels[i]） */
      const raw = String(opts.labels[i] == null ? '' : opts.labels[i]);
      const lab = isNarrow && raw.length > 3 ? raw.slice(-2) : raw;
      body += `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle" font-size="${isNarrow ? 9.5 : 12}" ${isNarrow ? 'font-weight="600"' : ''} fill="${T.axis}" font-family="Bahnschrift,Consolas,monospace">${lab}</text>`;
      body += `<rect class="bh" data-i="${i}" x="${(pad.l + step * i).toFixed(1)}" y="${pad.t}" width="${step.toFixed(1)}" height="${ph}" fill="transparent"/>`;
    });

    // 高亮区
    const hl = opts.highlightIndex;
    if (hl !== undefined && hl >= 0) {
      const x = pad.l + step * hl;
      body += `<rect x="${x.toFixed(1)}" y="${pad.t}" width="${step.toFixed(1)}" height="${ph}" fill="rgba(63,182,201,.07)" stroke="rgba(63,182,201,.28)" stroke-width="1"/>`;
    }

    host.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
    host.querySelectorAll('.bh').forEach(r => {
      r.addEventListener('mousemove', e => {
        const i = +r.dataset.i;
        showTip(`<div style="color:#9fb6c8;margin-bottom:2px">${opts.tipLabel ? opts.tipLabel(i) : opts.labels[i]}</div>
          <div><span class="k" style="background:${opts.colors ? opts.colors[i] : '#3fb6c9'}"></span>${opts.valueLabel || '数值'} <b>${fmt(vals[i], opts.dec)}</b> <span style="color:#5d7387">${opts.unit || ''}</span></div>`, e.clientX, e.clientY);
        host.dispatchEvent(new CustomEvent('chart-hover', { detail: true }));
      });
      r.addEventListener('mouseleave', () => {
        hideTip();
        host.dispatchEvent(new CustomEvent('chart-hover', { detail: false }));
      });
    });
  }

  /* 环形图 */
  function donutChart(host, opts) {
    if (!host) return;
    const w = host.clientWidth || 300;
    const h = host.clientHeight || 130;
    const total = opts.items.reduce((a, b) => a + b.value, 0) || 1;
    /* v1.2.2：窄容器（右栏 mini 列 ~160px）适配——图例从 donut 右侧移到下方两列，
       否则 lx = cx+size/2+14 只剩 ~60px 塞 label+value，叠字溢出面板右缘 */
    const narrow = w < 190;
    const size = narrow
      ? Math.min(w - 20, (h - 34) * 0.8, 84)
      : Math.min(h - 12, w * 0.48, 108);
    const cx = narrow ? w / 2 : 8 + size / 2;
    const cy = narrow ? 8 + size / 2 : h / 2;
    const r = size / 2 - 6;
    const stroke = Math.max(7, size * 0.13);
    const circ = 2 * Math.PI * r;

    let body = '';
    let acc = 0;
    opts.items.forEach((it, i) => {
      const frac = it.value / total;
      const len = frac * circ;
      body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${stroke}"
        stroke-dasharray="${Math.max(0, len - 1.6).toFixed(2)} ${(circ - len + 1.6).toFixed(2)}"
        stroke-dashoffset="${(-acc * circ + circ * 0.25).toFixed(2)}" opacity=".82"
        transform="rotate(0 ${cx} ${cy})"/>`;
      acc += frac;
    });
    body += `<circle cx="${cx}" cy="${cy}" r="${r - stroke / 2 - 2}" fill="none" stroke="rgba(126,163,196,.08)" stroke-width="1"/>`;
    /* v1.2.2：窄容器圆心空间 ~60px——centerValue 20→15px、label 12→9.5px、字距收紧，防「94.4% CLUSTERS」糊团 */
    body += `<text x="${cx}" y="${cy - (narrow ? 1 : 2)}" text-anchor="middle" font-size="${narrow ? 15 : 26}" font-family="Bahnschrift,Consolas,monospace" fill="#dcebf6">${opts.centerValue}</text>`;
    body += `<text x="${cx}" y="${cy + (narrow ? 10 : 16)}" text-anchor="middle" font-size="${narrow ? 9.5 : 12}" fill="${T.axis}" letter-spacing="${narrow ? .5 : 1}">${opts.centerLabel || 'CLUSTERS'}</text>`;

    if (narrow) {
      /* 两列图例（label + value 同行），donut 下方；v1.3.2：按剩余高度钳制行距与行数，防溢出画布 */
      const rows = Math.ceil(opts.items.length / 2);
      const avail = h - (cy + size / 2) - 8;
      const fs = w < 150 ? 10 : 11.5;
      const rowH2 = Math.max(10, Math.min(15, avail / rows));
      const ly0 = cy + size / 2 + 12;
      const maxRow = Math.floor((h - 2 - ly0) / rowH2);
      opts.items.forEach((it, i) => {
        const col = i % 2, row = Math.floor(i / 2);
        if (row > maxRow) return;
        const x = 8 + col * (w / 2);
        const y = ly0 + row * rowH2;
        body += `<rect x="${x}" y="${y - 4.5}" width="5" height="5" fill="${it.color}" rx="1" opacity=".9"/>`;
        body += `<text x="${x + 8}" y="${y}" font-size="${fs}" fill="#8ea3b7" font-family="HarmonyOS Sans SC,Microsoft YaHei,sans-serif">${it.label} <tspan fill="#c2d5e3" font-family="Bahnschrift,Consolas,monospace">${it.value}</tspan></text>`;
      });
    } else {
      const lx = cx + size / 2 + 14;
      const rowH = Math.min(18, (h - 8) / opts.items.length);
      let ly = cy - (opts.items.length * rowH) / 2 + rowH / 2 + 1;
      opts.items.forEach(it => {
        body += `<rect x="${lx}" y="${ly - 4.5}" width="5" height="5" fill="${it.color}" rx="1" opacity=".9"/>`;
        body += `<text x="${lx + 10}" y="${ly}" font-size="12.5" fill="#8ea3b7" font-family="HarmonyOS Sans SC,Microsoft YaHei,sans-serif">${it.label}</text>`;
        body += `<text x="${w - 4}" y="${ly}" text-anchor="end" font-size="12.5" fill="#c2d5e3" font-family="Bahnschrift,Consolas,monospace">${it.value}</text>`;
        ly += rowH;
      });
    }

    host.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  }

  function sparkline(values, color, w, h) {
    w = w || 56; h = h || 18;
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    let d = '';
    values.forEach((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - 2 - ((v - min) / span) * (h - 4);
      d += (i === 0 ? 'M ' : ' L ') + x.toFixed(1) + ' ' + y.toFixed(1);
    });
    return `<svg class="m-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round" opacity=".85"/></svg>`;
  }

  global.Charts = { areaChart, barChart, donutChart, sparkline, hideTip };
})(window);
