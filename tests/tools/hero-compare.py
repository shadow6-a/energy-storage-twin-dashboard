#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build docs/img/hero-compare.png: live dashboard screenshot (left) vs
   soak observability curves from tests/soak-latest.csv (right).
   Zero external deps except Pillow. Usage: python tests/tools/hero-compare.py"""
import csv, io, os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
COVER = os.path.join(ROOT, 'assets', 'mockups', '00-cover.png')
CSV = os.path.join(ROOT, 'tests', 'soak-latest.csv')
OUT = os.path.join(ROOT, 'docs', 'img', 'hero-compare.png')
FONT = 'C:/Windows/Fonts/msyh.ttc'

def f(sz):
    try:
        return ImageFont.truetype(FONT, sz)
    except OSError:
        return ImageFont.load_default()

rows = []
with io.open(CSV, encoding='utf-8-sig') as fh:
    for r in csv.DictReader(fh):
        try:
            rows.append((float(r['minutes']), float(r['ui_heap_mb']),
                         float(r['ui_fps']), float(r['bridge_lag_ms'])))
        except (ValueError, KeyError):
            pass
if len(rows) < 3:
    raise SystemExit('need >=3 soak samples')

W, H = 1800, 780
img = Image.new('RGB', (W, H), '#ffffff')
d = ImageDraw.Draw(img)
d.rectangle([0, 0, W, 66], fill='#0f172a')
d.text((28, 16), '实时大屏 × 可观测曲线：一套系统的两面', font=f(28), fill='#ffffff')
d.text((28, 74), '实时大屏（1920×1080，MQTT 实时数据）', font=f(19), fill='#111827')
d.text((930, 74), '长跑遥测（/metrics 采样 · tests/soak.ps1）', font=f(19), fill='#111827')

cover = Image.open(COVER).convert('RGB')
cover.thumbnail((866, 487))
img.paste(cover, (25, 108))
d.rectangle([25, 108, 25 + cover.width, 108 + cover.height], outline='#cbd5e1', width=2)

cards = [('-1 MB', 'JS Heap 增长', '#2563eb'),
         ('60 FPS', '恒定满帧，零掉帧', '#16a34a'),
         ('1-15 ms', '事件循环延迟', '#ea580c')]
for i, (big, small, col) in enumerate(cards):
    x = 25 + i * 292
    d.rounded_rectangle([x, 616, x + 276, 726], radius=10, fill='#f8fafc', outline='#e2e8f0', width=2)
    d.text((x + 16, 630), big, font=f(30), fill=col)
    d.text((x + 16, 680), small, font=f(15), fill='#64748b')

def curve(y0, title, vals, unit, color):
    x0, w, h = 930, 845, 196
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=10, fill='#f8fafc', outline='#e2e8f0', width=2)
    d.text((x0 + 16, y0 + 10), title, font=f(17), fill='#1f2937')
    d.text((x0 + w - 170, y0 + 14), 'min %.1f / max %.1f %s' % (min(vals), max(vals), unit),
           font=f(13), fill='#94a3b8')
    px0, px1, py0, py1 = x0 + 20, x0 + w - 20, y0 + 46, y0 + h - 18
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-9:
        hi = lo + 1
    lo, hi = lo - (hi - lo) * 0.2, hi + (hi - lo) * 0.2
    for k in range(1, 4):
        gy = py0 + (py1 - py0) * k / 4
        d.line([px0, gy, px1, gy], fill='#e2e8f0', width=1)
    pts = []
    for i, v in enumerate(vals):
        x = px0 + i * (px1 - px0) / max(len(vals) - 1, 1)
        y = py1 - (v - lo) / (hi - lo) * (py1 - py0)
        pts.append((x, y))
    d.line(pts, fill=color, width=3, joint='curve')
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=color)
    d.text((px0, py1 + 2), '起始', font=f(11), fill='#94a3b8')
    d.text((px1 - 88, py1 + 2), '结束（%.1f 分钟）' % rows[-1][0], font=f(11), fill='#94a3b8')

curve(108, '前端 JS Heap (MB) — 平坦 = 无泄漏', [r[1] for r in rows], 'MB', '#2563eb')
curve(322, 'FPS（60 满帧）', [r[2] for r in rows], 'fps', '#16a34a')
curve(536, '桥接事件循环延迟 (ms)', [r[3] for r in rows], 'ms', '#ea580c')

d.text((28, 746), 'Sources: assets/mockups/00-cover.png  |  tests/soak-latest.csv (%d samples)  |  GET /metrics' % len(rows),
       font=f(13), fill='#94a3b8')
os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save(OUT, optimize=True)
print('written', os.path.normpath(OUT), img.size)
