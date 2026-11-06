/* ============================================================
   轻量三维孪生引擎（Canvas 2D 手工投影 / 无外部依赖）
   - 透视相机：yaw / pitch / dist / target
   - 图元：地面网格、区域面、链路、箱体、站点信标、标注
   - 交互：拖拽旋转、滚轮缩放、右键平移、点击拾取
   ============================================================ */
(function (global) {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const NEAR = 12;

  function hexToRgb(hex) {
    if (!hex || hex[0] !== '#') return null;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function shade(hex, factor) {
    const c = hexToRgb(hex);
    if (!c) return hex;
    const f = v => Math.round(clamp(v * factor, 0, 255));
    return `rgb(${f(c.r)},${f(c.g)},${f(c.b)})`;
  }

  class Twin {
    constructor(canvas, opts) {
      opts = opts || {};
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.onSelect = opts.onSelect || function () {};
      this.onHover = opts.onHover || function () {};
      this.cam = { yaw: -0.55, pitch: 0.62, dist: 1380, target: { x: 0, y: 0, z: 20 } };
      this.fovY = 0.7;
      this.scene = null;
      this.hits = [];
      this._shiftMap = new Map(); /* v1.2 标签避让位移（跨帧滞后状态） */
      this._placed = [];
      this.hoverId = null;
      this.selectedId = null;
      this.drag = null;
      this.tween = null;
      this.t = 0;
      this.w = 0; this.h = 0; this.focal = 1000;

      this.resize();
      this._bind();
      this.last = performance.now();
      this._frame = this._frame.bind(this);
      requestAnimationFrame(this._frame);
    }

    /* ---------- 尺寸 ---------- */
    resize() {
      const w = this.cv.clientWidth || 900;
      const h = this.cv.clientHeight || 600;
      const dpr = Math.min(2.4, (window.devicePixelRatio || 1) * (window.APP_SCALE || 1));
      this.cv.width = Math.round(w * dpr);
      this.cv.height = Math.round(h * dpr);
      this.w = w; this.h = h; this.dpr = dpr;
      this.focal = (h * 0.5) / Math.tan(this.fovY / 2);
    }

    /* ---------- 相机 ---------- */
    _basis() {
      const c = this.cam;
      const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
      const dir = { x: Math.sin(c.yaw) * cp, y: sp, z: Math.cos(c.yaw) * cp };
      const eye = {
        x: c.target.x + dir.x * c.dist,
        y: c.target.y + dir.y * c.dist,
        z: c.target.z + dir.z * c.dist
      };
      const f = { x: -dir.x, y: -dir.y, z: -dir.z };
      const up = { x: 0, y: 1, z: 0 };
      let s = {
        x: f.y * up.z - f.z * up.y,
        y: f.z * up.x - f.x * up.z,
        z: f.x * up.y - f.y * up.x
      };
      const sl = Math.hypot(s.x, s.y, s.z) || 1;
      s = { x: s.x / sl, y: s.y / sl, z: s.z / sl };
      const u = {
        x: s.y * f.z - s.z * f.y,
        y: s.z * f.x - s.x * f.z,
        z: s.x * f.y - s.y * f.x
      };
      this._b = { eye, f, s, u };
    }

    _view(p) {
      const b = this._b;
      const dx = p.x - b.eye.x, dy = p.y - b.eye.y, dz = p.z - b.eye.z;
      return {
        x: dx * b.s.x + dy * b.s.y + dz * b.s.z,
        y: dx * b.u.x + dy * b.u.y + dz * b.u.z,
        z: dx * b.f.x + dy * b.f.y + dz * b.f.z
      };
    }
    _screen(v) {
      const k = this.focal / v.z;
      return { x: this.w / 2 + v.x * k, y: this.h / 2 - v.y * k, d: v.z, k };
    }
    project(p) {
      const v = this._view(p);
      if (v.z < NEAR) return null;
      return this._screen(v);
    }
    projectSeg(a, b) {
      let A = this._view(a), B = this._view(b);
      if (A.z < NEAR && B.z < NEAR) return null;
      if (A.z < NEAR) {
        const t = (NEAR - A.z) / (B.z - A.z);
        A = { x: lerp(A.x, B.x, t), y: lerp(A.y, B.y, t), z: NEAR };
      } else if (B.z < NEAR) {
        const t = (NEAR - B.z) / (A.z - B.z);
        B = { x: lerp(B.x, A.x, t), y: lerp(B.y, A.y, t), z: NEAR };
      }
      return [this._screen(A), this._screen(B)];
    }

    flyTo(to, dur) {
      const c = this.cam;
      let dy = (to.yaw !== undefined ? to.yaw : c.yaw) - c.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.tween = {
        t0: performance.now(),
        dur: dur || 820,
        from: { yaw: c.yaw, pitch: c.pitch, dist: c.dist, target: { ...c.target } },
        to: {
          yaw: c.yaw + dy,
          pitch: to.pitch !== undefined ? to.pitch : c.pitch,
          dist: to.dist !== undefined ? to.dist : c.dist,
          target: to.target ? { ...c.target, ...to.target } : { ...c.target }
        }
      };
    }

    setScene(scene, opts) {
      opts = opts || {};
      this.scene = scene;
      this._shiftMap.clear(); /* 场景切换：避让状态清零 */
      this.selectedId = opts.selectedId || null;
      if (opts.keepCam) {
        this.hits = [];
        return;
      }
      this.hoverId = null;
      if (scene.cam) {
        this.cam.yaw = scene.cam.yaw;
        this.cam.pitch = scene.cam.pitch;
        this.cam.dist = scene.cam.dist;
        this.cam.target = { ...scene.cam.target };
      }
      this.tween = null;
    }

    setTopView(on) {
      this.flyTo({ pitch: on ? 1.45 : 0.62, yaw: on ? 0 : -0.55, dist: on ? 1500 : 1380 }, 700);
    }

    resetView() {
      if (!this.scene || !this.scene.cam) return;
      this.flyTo(this.scene.cam, 600);
    }

    /* ---------- 交互 ---------- */
    _local(e) {
      const r = this.cv.getBoundingClientRect();
      const s = window.APP_SCALE || 1;
      return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
    }

    _bind() {
      const cv = this.cv;
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId);
        const pan = e.button === 2 || e.button === 1 || e.shiftKey;
        this.drag = {
          x: e.clientX, y: e.clientY, moved: 0, pan,
          yaw: this.cam.yaw, pitch: this.cam.pitch,
          target: { ...this.cam.target }
        };
        this.tween = null;
        cv.classList.add('dragging');
      });

      cv.addEventListener('pointermove', e => {
        const p = this._local(e);
        if (this.drag) {
          const dx = e.clientX - this.drag.x;
          const dy = e.clientY - this.drag.y;
          this.drag.moved = Math.max(this.drag.moved, Math.abs(dx) + Math.abs(dy));
          if (this.drag.pan) {
            const k = this.cam.dist / this.focal;
            const s = this._b.s, f = this._b.f;
            this.cam.target.x = this.drag.target.x - (s.x * dx - f.x * dy) * k * 1.15;
            this.cam.target.z = this.drag.target.z - (s.z * dx - f.z * dy) * k * 1.15;
          } else {
            this.cam.yaw = this.drag.yaw - dx * 0.005;
            this.cam.pitch = clamp(this.drag.pitch + dy * 0.004, 0.14, 1.45);
          }
          this.onHover(null);
          this.hoverId = null;
          cv.style.cursor = '';
          return;
        }
        const hit = this._hit(p.x, p.y);
        if ((hit && hit.id) !== this.hoverId) {
          this.hoverId = hit ? hit.id : null;
          cv.style.cursor = hit ? 'pointer' : '';
          if (hit && hit.obj) {
            this.onHover({ obj: hit.obj, x: e.clientX, y: e.clientY });
          } else {
            this.onHover(null);
          }
        } else if (hit && hit.obj) {
          this.onHover({ obj: hit.obj, x: e.clientX, y: e.clientY });
        }
      });

      const end = e => {
        if (this.drag && this.drag.moved < 6 && !this.drag.pan) {
          const p = this._local(e);
          const hit = this._hit(p.x, p.y);
          if (hit && hit.obj) this.onSelect(hit.obj);
        }
        this.drag = null;
        cv.classList.remove('dragging');
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', () => { this.drag = null; cv.classList.remove('dragging'); });
      cv.addEventListener('contextmenu', e => e.preventDefault());

      cv.addEventListener('wheel', e => {
        e.preventDefault();
        this.tween = null;
        this.cam.dist = clamp(this.cam.dist * Math.exp(e.deltaY * 0.0012), 260, 3000);
      }, { passive: false });

      cv.addEventListener('pointerleave', () => {
        this.hoverId = null;
        this.onHover(null);
        this.cv.style.cursor = '';
      });
    }

    _hit(x, y) {
      for (let i = this.hits.length - 1; i >= 0; i--) {
        const h = this.hits[i];
        if (h.rect) {
          const r = h.rect;
          if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return h;
        } else if (h.pts && this._inPoly(x, y, h.pts)) {
          return h;
        }
      }
      return null;
    }
    _inPoly(x, y, pts) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    }

    /* ---------- 渲染 ---------- */
    _frame(now) {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;

      if (this.tween) {
        const tw = this.tween;
        const p = clamp((now - tw.t0) / tw.dur, 0, 1);
        const e = easeInOut(p);
        this.cam.yaw = lerp(tw.from.yaw, tw.to.yaw, e);
        this.cam.pitch = lerp(tw.from.pitch, tw.to.pitch, e);
        this.cam.dist = lerp(tw.from.dist, tw.to.dist, e);
        this.cam.target.x = lerp(tw.from.target.x, tw.to.target.x, e);
        this.cam.target.y = lerp(tw.from.target.y, tw.to.target.y, e);
        this.cam.target.z = lerp(tw.from.target.z, tw.to.target.z, e);
        if (p >= 1) this.tween = null;
      }

      this.render();
      requestAnimationFrame(this._frame);
    }

    render() {
      const ctx = this.ctx;
      if (!this.w || !this.h) return;
      this._basis();
      this.hits = [];

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);

      const bg = ctx.createRadialGradient(this.w * 0.5, this.h * 0.38, 0, this.w * 0.5, this.h * 0.45, Math.max(this.w, this.h) * 0.8);
      bg.addColorStop(0, '#0a1625');
      bg.addColorStop(0.55, '#070e18');
      bg.addColorStop(1, '#04080d');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, this.w, this.h);

      const sc = this.scene;
      if (!sc) return;

      this._ground(sc);
      this._region(sc);
      if (sc.links) this._links(sc.links);

      const objs = (sc.objects || []).map(o => {
        const c = o.center || { x: o.pos.x, y: o.pos.y + (o.size ? o.size.h * 0.5 : 20), z: o.pos.z };
        const v = this._view(c);
        return { o, d: v.z };
      }).sort((a, b) => b.d - a.d);

      objs.forEach(it => {
        const o = it.o;
        if (it.d < NEAR) return;
        if (o.kind === 'box') this._box(o);
        else if (o.kind === 'pad') this._pad(o);
        else if (o.kind === 'pin') this._pin(o);
      });

      // 标注层：统一后绘，保证可读性
      const labels = [];
      objs.forEach(it => {
        const o = it.o;
        if (!o.label || it.d < NEAR) return;
        if (o.kind === 'pin') {
          /* v1.1.2：labelDx/Dz 站点级标签偏移（世界坐标），v1.2 碰撞避让的配置入口 */
          const head = this.project({ x: o.pos.x + (o.labelDx || 0), y: o.pos.y + (o.headY || 62), z: o.pos.z + (o.labelDz || 0) });
          if (head) labels.push({ o, anchor: head, d: it.d, pin: true });
        } else if (o.kind === 'box' && o.showLabel !== false) {
          const top = this.project({ x: o.pos.x, y: o.pos.y + o.size.h, z: o.pos.z });
          if (top) labels.push({ o, anchor: top, d: it.d, pin: false });
        }
      });
      /* v1.2 碰撞避让：优先级排序（选中 > 告警 > 正常）→ 高优先级先画占据原位，低的避让 */
      labels.sort((a, b) => this._pri(a.o) - this._pri(b.o) || b.d - a.d);
      this._placed = [];
      labels.forEach(l => this._label(l));
    }

    _pri(o) {
      if (o.id === this.selectedId) return 0;
      if (o.badge > 0 || o.pulse) return 1;
      return 2;
    }

    _ground(sc) {
      const ctx = this.ctx;
      const g = sc.ground || { x: 620, z: 400 };
      const corners = [
        { x: -g.x, y: 0, z: -g.z }, { x: g.x, y: 0, z: -g.z },
        { x: g.x, y: 0, z: g.z }, { x: -g.x, y: 0, z: g.z }
      ].map(p => this.project(p));
      if (corners.every(Boolean)) {
        ctx.beginPath();
        corners.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.closePath();
        const grd = ctx.createLinearGradient(0, this.h * 0.2, 0, this.h);
        grd.addColorStop(0, 'rgba(14,28,42,.85)');
        grd.addColorStop(1, 'rgba(6,12,20,.9)');
        ctx.fillStyle = grd;
        ctx.fill();
        ctx.strokeStyle = 'rgba(126,163,196,.12)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      const step = sc.gridStep || 100;
      const xMax = Math.ceil(g.x / step) * step;
      const zMax = Math.ceil(g.z / step) * step;
      ctx.lineWidth = 1;
      for (let x = -xMax; x <= xMax; x += step) {
        const seg = this.projectSeg({ x, y: 0, z: -zMax }, { x, y: 0, z: zMax });
        if (!seg) continue;
        const major = Math.abs(x) % (step * 2) < 0.01;
        ctx.strokeStyle = major ? 'rgba(126,163,196,.10)' : 'rgba(126,163,196,.055)';
        ctx.beginPath(); ctx.moveTo(seg[0].x, seg[0].y); ctx.lineTo(seg[1].x, seg[1].y); ctx.stroke();
      }
      for (let z = -zMax; z <= zMax; z += step) {
        const seg = this.projectSeg({ x: -xMax, y: 0, z }, { x: xMax, y: 0, z });
        if (!seg) continue;
        const major = Math.abs(z) % (step * 2) < 0.01;
        ctx.strokeStyle = major ? 'rgba(126,163,196,.10)' : 'rgba(126,163,196,.055)';
        ctx.beginPath(); ctx.moveTo(seg[0].x, seg[0].y); ctx.lineTo(seg[1].x, seg[1].y); ctx.stroke();
      }
    }

    _region(sc) {
      if (!sc.region) return;
      const ctx = this.ctx;
      const pts = sc.region.points.map(p => this.project({ x: p.x, y: 0.5, z: p.z }));
      if (!pts.every(Boolean)) return;
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = sc.region.fill || 'rgba(63,182,201,.035)';
      ctx.fill();
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = sc.region.stroke || 'rgba(63,182,201,.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      if (sc.region.label) {
        const anchor = this.project({ x: sc.region.labelX, y: 0.5, z: sc.region.labelZ });
        if (anchor) {
          ctx.font = '500 10px "HarmonyOS Sans SC","Microsoft YaHei",sans-serif';
          ctx.fillStyle = 'rgba(126,163,196,.5)';
          ctx.textAlign = 'left';
          ctx.fillText(sc.region.label, anchor.x, anchor.y);
        }
      }
    }

    _links(links) {
      const ctx = this.ctx;
      links.forEach((ln, i) => {
        const seg = this.projectSeg(
          { x: ln.from.x, y: ln.y || 0.6, z: ln.from.z },
          { x: ln.to.x, y: ln.y || 0.6, z: ln.to.z }
        );
        if (!seg) return;
        ctx.save();
        if (ln.solid) {
          ctx.setLineDash([]);
        } else {
          const dir = ln.flow === -1 ? 1 : -1;
          ctx.setLineDash([5, 9]);
          ctx.lineDashOffset = this.lightweight ? 0 : dir * (this.t * 26 + i * 7);
        }
        ctx.strokeStyle = ln.color || 'rgba(94,143,187,.28)';
        ctx.lineWidth = ln.width || 1;
        ctx.beginPath(); ctx.moveTo(seg[0].x, seg[0].y); ctx.lineTo(seg[1].x, seg[1].y); ctx.stroke();
        ctx.restore();

        // 流动光点
        if (ln.flow) {
          const sp = seg[0], ep = seg[1];
          const k = (this.t * 0.14 + i * 0.13) % 1;
          const t = ln.flow > 0 ? k : 1 - k;
          const x = lerp(sp.x, ep.x, t), y = lerp(sp.y, ep.y, t);
          ctx.fillStyle = ln.dot || 'rgba(140,220,235,.55)';
          ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
        }
      });
    }

    _pad(o) {
      const ctx = this.ctx;
      const w = o.size.w / 2, d = o.size.d / 2;
      const pts = [
        { x: o.pos.x - w, y: 0, z: o.pos.z - d },
        { x: o.pos.x + w, y: 0, z: o.pos.z - d },
        { x: o.pos.x + w, y: 0, z: o.pos.z + d },
        { x: o.pos.x - w, y: 0, z: o.pos.z + d }
      ].map(p => this.project(p));
      if (!pts.every(Boolean)) return;
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = o.color || 'rgba(18,34,50,.55)';
      ctx.fill();
      ctx.strokeStyle = o.stroke || 'rgba(126,163,196,.14)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (o.lane) {
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = 'rgba(126,163,196,.10)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    _box(o) {
      const ctx = this.ctx;
      const W = o.size.w / 2, D = o.size.d / 2;
      const y0 = o.pos.y, y1 = o.pos.y + o.size.h;
      const base = [
        [o.pos.x - W, o.pos.z - D], [o.pos.x + W, o.pos.z - D],
        [o.pos.x + W, o.pos.z + D], [o.pos.x - W, o.pos.z + D]
      ];
      const top = base.map(([x, z]) => this.project({ x, y: y1, z }));
      const bot = base.map(([x, z]) => this.project({ x, y: y0, z }));
      if (!top.every(Boolean) || !bot.every(Boolean)) return;

      const sel = o.id && o.id === this.selectedId;
      const hov = o.id && o.id === this.hoverId;
      const light = { x: 0.36, y: 0.86, z: 0.36 };
      const eye = this._b.eye;

      const faces = [];
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        const ax = base[i][0], az = base[i][1];
        const bx = base[j][0], bz = base[j][1];
        const nx = -(bz - az), nz = (bx - ax);
        const nl = Math.hypot(nx, nz) || 1;
        const normal = { x: nx / nl, y: 0, z: nz / nl };
        const cx = (ax + bx) / 2, cz = (az + bz) / 2;
        const facing = (eye.x - cx) * normal.x + (eye.z - cz) * normal.z;
        if (facing <= 0) continue;
        const lit = Math.max(0, normal.x * light.x + normal.z * light.z);
        faces.push({
          pts: [bot[i], bot[j], top[j], top[i]],
          shade: 0.5 + lit * 0.55,
          depth: (this._view({ x: cx, y: (y0 + y1) / 2, z: cz }).z)
        });
      }
      faces.sort((a, b) => b.depth - a.depth);

      const baseColor = o.color || '#20384d';
      faces.forEach(f => {
        ctx.beginPath();
        f.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.closePath();
        let col = shade(baseColor, f.shade * (hov ? 1.16 : 1));
        if (sel) col = shade(baseColor, f.shade * 1.35);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = sel ? 'rgba(124,229,245,.75)' : (o.edge || 'rgba(8,16,24,.55)');
        ctx.lineWidth = sel ? 1.4 : 0.9;
        ctx.stroke();
      });

      // 顶面
      ctx.beginPath();
      top.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.closePath();
      let topCol = shade(baseColor, (hov ? 1.35 : 1.22));
      if (sel) topCol = shade(baseColor, 1.55);
      ctx.fillStyle = topCol;
      ctx.fill();
      ctx.strokeStyle = sel ? 'rgba(124,229,245,.85)' : (o.edge || 'rgba(140,180,210,.16)');
      ctx.lineWidth = sel ? 1.5 : 1;
      ctx.stroke();

      // 顶面细节线（机柜槽位）
      if (o.detail) {
        ctx.strokeStyle = 'rgba(8,16,24,.4)';
        ctx.lineWidth = 1;
        const n = o.detail;
        for (let i = 1; i < n; i++) {
          const t = i / n;
          const a = this.project({ x: lerp(o.pos.x - W * 0.8, o.pos.x + W * 0.8, t), y: y1 + 0.5, z: o.pos.z - D * 0.8 });
          const b = this.project({ x: lerp(o.pos.x - W * 0.8, o.pos.x + W * 0.8, t), y: y1 + 0.5, z: o.pos.z + D * 0.8 });
          if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        }
      }

      // 命中区（顶面 + 可见侧面）
      const poly = top.map(p => [p.x, p.y]);
      this.hits.push({ id: o.id, obj: o, pts: poly });
      faces.forEach(f => this.hits.push({ id: o.id, obj: o, pts: f.pts.map(p => [p.x, p.y]) }));

      if (sel) {
        const g = this.project({ x: o.pos.x, y: 0.5, z: o.pos.z });
        if (g) {
          ctx.save();
          ctx.strokeStyle = 'rgba(124,229,245,.4)';
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.ellipse(g.x, g.y, 26 * g.k * 0.5, 26 * g.k * 0.5 * 0.42, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    _pin(o) {
      const ctx = this.ctx;
      const base = this.project({ x: o.pos.x, y: 0, z: o.pos.z });
      if (!base) return;
      const headY = o.headY || 62;
      const head = this.project({ x: o.pos.x, y: headY, z: o.pos.z });
      if (!head) return;
      const color = o.color || '#3fb6c9';
      const sel = o.id === this.selectedId;
      const hov = o.id === this.hoverId;

      // 地面圈
      const rWorld = o.radius || 26;
      const ringPts = [];
      let ok = true;
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * Math.PI * 2;
        const p = this.project({ x: o.pos.x + Math.cos(a) * rWorld, y: 0.4, z: o.pos.z + Math.sin(a) * rWorld });
        if (!p) { ok = false; break; }
        ringPts.push(p);
      }
      if (ok) {
        ctx.beginPath();
        ringPts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.closePath();
        ctx.fillStyle = o.ringFill || 'rgba(63,182,201,.07)';
        ctx.fill();
        ctx.strokeStyle = o.offline ? 'rgba(91,107,122,.35)' : (sel ? 'rgba(124,229,245,.65)' : 'rgba(126,163,196,.20)');
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 告警脉冲（v0.9.5：默认轻量化静态描边；仅「紧急未闭环」节点自动提权为动态扩散）
      if (o.pulse && !o.offline) {
        const crit = this.critIds && this.critIds.has(o.id);
        if (this.lightweight && !crit) {
          const p0 = this.project({ x: o.pos.x + rWorld * 1.35, y: 0.5, z: o.pos.z });
          const p1 = this.project({ x: o.pos.x - rWorld * 1.35, y: 0.5, z: o.pos.z });
          if (p0 && p1) {
            ctx.beginPath();
            ctx.ellipse((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, Math.abs(p0.x - p1.x) / 2, Math.abs(p1.y - p0.y) / 2 || Math.abs(p0.x - p1.x) / 5, 0, 0, Math.PI * 2);
            ctx.strokeStyle = o.color || '#3fb6c9';
            ctx.globalAlpha = 0.5;
            ctx.lineWidth = 1.2;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        } else {
        const ph = (this.t * 0.5 + (o.phase || 0)) % 1;
        const rr = rWorld * (1 + ph * 0.9);
        const p0 = this.project({ x: o.pos.x + rr, y: 0.5, z: o.pos.z });
        const p1 = this.project({ x: o.pos.x - rr, y: 0.5, z: o.pos.z });
        if (p0 && p1) {
          ctx.beginPath();
          ctx.ellipse((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, Math.abs(p0.x - p1.x) / 2, Math.abs(p1.y - p0.y) / 2 || Math.abs(p0.x - p1.x) / 5, 0, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(224,82,63,${0.34 * (1 - ph)})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
        }
      }

      // 立柱
      const grad = ctx.createLinearGradient(base.x, base.y, head.x, head.y);
      grad.addColorStop(0, o.offline ? 'rgba(91,107,122,.35)' : 'rgba(126,163,196,.10)');
      grad.addColorStop(0.55, o.offline ? 'rgba(91,107,122,.7)' : 'rgba(126,163,196,.55)');
      grad.addColorStop(1, o.offline ? '#7b8b99' : color);
      ctx.strokeStyle = grad;
      ctx.lineWidth = sel ? 2 : 1.4;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(head.x, head.y); ctx.stroke();

      // 柱底
      ctx.fillStyle = o.offline ? 'rgba(91,107,122,.5)' : 'rgba(126,163,196,.45)';
      ctx.beginPath(); ctx.arc(base.x, base.y, 1.8, 0, Math.PI * 2); ctx.fill();

      // 信标头
      const s = sel ? 8 : 6.5;
      ctx.beginPath();
      ctx.moveTo(head.x, head.y - s);
      ctx.lineTo(head.x + s, head.y);
      ctx.lineTo(head.x, head.y + s);
      ctx.lineTo(head.x - s, head.y);
      ctx.closePath();
      ctx.fillStyle = o.offline ? 'rgba(12,20,28,.9)' : 'rgba(9,18,26,.92)';
      ctx.fill();
      ctx.strokeStyle = o.offline ? '#6c7d8c' : color;
      ctx.lineWidth = sel || hov ? 2 : 1.4;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(head.x, head.y, sel || hov ? 2.6 : 2, 0, Math.PI * 2);
      ctx.fillStyle = o.offline ? '#6c7d8c' : color;
      ctx.fill();

      // 告警角标
      if (o.badge) {
        const bx = head.x + 9, by = head.y - 9;
        ctx.beginPath();
        ctx.arc(bx, by, 5.2, 0, Math.PI * 2);
        ctx.fillStyle = '#c8452f';
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '600 8px Bahnschrift,Consolas,monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(o.badge), bx, by + 0.5);
      }

      // 命中区
      this.hits.push({ id: o.id, obj: o, pts: [[head.x - 14, head.y - 14], [head.x + 14, head.y - 14], [head.x + 14, head.y + 14], [head.x - 14, head.y + 14]] });
      this.hits.push({ id: o.id, obj: o, rect: { x: base.x - rWorld * base.k * 0.8, y: base.y - rWorld * base.k * 0.4, w: rWorld * base.k * 1.6, h: rWorld * base.k * 0.8 } });
    }

    _label(l) {
      const ctx = this.ctx;
      const o = l.o;
      const text = o.label;
      const sub = o.labelSub;
      const sel = o.id === this.selectedId;
      const hov = o.id === this.hoverId;

      ctx.font = '600 11.5px "HarmonyOS Sans SC","Microsoft YaHei",sans-serif';
      const tw = ctx.measureText(text).width;
      let sw = 0;
      if (sub) {
        ctx.font = '400 9px Bahnschrift,"HarmonyOS Sans SC",monospace';
        sw = ctx.measureText(sub).width;
      }
      const w = Math.max(tw, sw) + 14;
      const h = sub ? 30 : 18;
      const ax = l.anchor.x;
      const ay = l.anchor.y - (l.pin ? 16 : 8);

      const x = clamp(ax - w / 2, 4, this.w - w - 4);
      const y0 = clamp(ay - h, 4, this.h - h - 4);

      /* v1.2 屏幕空间贪心避让（带 Hysteresis 滞后：重叠 >20% 触发、回到 <10% 才复位，
         平滑过渡防跳动感；shiftMap 跨帧持久，场景切换时清空） */
      const key = o.id || 'lb' + this._placed.length;
      let shift = this._shiftMap.get(key) || 0;
      const ovAt = yy => {
        let m = 0;
        for (const r of this._placed) {
          const ox = Math.min(x + w, r.x + r.w) - Math.max(x, r.x);
          if (ox <= 0) continue;
          const oy = Math.min(yy + h, r.y + r.h) - Math.max(yy, r.y);
          if (oy > 0) m = Math.max(m, ox * oy / Math.min(w * h, r.w * r.h));
        }
        return m;
      };
      if (!ovAt(y0)) shift = 0;                       // 原位无重叠：直接复位（无需滞后）
      else if (!shift && ovAt(y0) > 0.2) {            // 原位重叠超 20%：向下贪心找空位
        let yy = y0;
        for (let i = 1; i <= 6; i++) {
          yy = Math.min(this.h - h - 4, y0 + i * (h + 6));
          if (ovAt(yy) < 0.12) break;
        }
        this._shiftMap.set(key, yy - y0);
      }
      const tgt = this._shiftMap.get(key) || 0;
      shift = this.lightweight ? tgt : shift + (tgt - shift) * 0.35;
      const y = clamp(y0 + shift, 4, this.h - h - 4);

      if (shift > 4) {  /* 引线：被移开的标签连回原锚点（1px 青 50%） */
        ctx.strokeStyle = 'rgba(124,229,245,.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y + h);
        ctx.lineTo(ax, ay + (l.pin ? 0 : 2));
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ax, ay + (l.pin ? 0 : 2), 1.6, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = sel ? 'rgba(12,32,44,.94)' : 'rgba(8,15,23,.86)';
      ctx.strokeStyle = sel ? 'rgba(124,229,245,.55)' : (hov ? 'rgba(126,163,196,.42)' : 'rgba(126,163,196,.20)');
      ctx.lineWidth = 1;
      ctx.beginPath();
      const r = 2;
      ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // 小尖角
      ctx.beginPath();
      ctx.moveTo(ax - 3, y + h);
      ctx.lineTo(ax, y + h + 4);
      ctx.lineTo(ax + 3, y + h);
      ctx.closePath();
      ctx.fillStyle = 'rgba(8,15,23,.86)';
      ctx.fill();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 11.5px "HarmonyOS Sans SC","Microsoft YaHei",sans-serif';
      ctx.fillStyle = o.labelColor || '#d3e3f0';
      ctx.fillText(text, x + w / 2, y + (sub ? 10 : 9.5));

      if (sub) {
        ctx.font = '400 9px Bahnschrift,"HarmonyOS Sans SC",monospace';
        ctx.fillStyle = o.subColor || '#8ea3b7';
        ctx.fillText(sub, x + w / 2, y + 22);
      }

      this._placed.push({ x, y, w, h });
      this.hits.push({ id: o.id, obj: o, rect: { x, y, w, h } });
    }

    showHit(x, y) {
      const h = this._hit(x, y);
      return h ? h.obj : null;
    }
  }

  global.Twin = Twin;
})(window);
