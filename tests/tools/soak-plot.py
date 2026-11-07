#!/usr/bin/env python3
# soak-latest.csv -> docs/img/soak-curve.svg (zero-dependency hand-written SVG).
# Three panels: UI heap / FPS / bridge event-loop lag. Embed in README.
# Usage: python tests/tools/soak-plot.py  (run tests/soak.ps1 first to make the CSV)
import csv, io, os, sys

SRC = os.path.join(os.path.dirname(__file__), '..', 'soak-latest.csv')
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'docs', 'img', 'soak-curve.svg')

rows = []
with io.open(SRC, encoding='utf-8-sig') as f:
    for r in csv.DictReader(f):
        try:
            rows.append({'t': float(r['minutes']),
                         'heap': float(r['ui_heap_mb']),
                         'fps': float(r['ui_fps']),
                         'lag': float(r['bridge_lag_ms'])})
        except (ValueError, KeyError):
            continue
if len(rows) < 3:
    sys.exit('need >= 3 samples in soak-latest.csv (run tests/soak.ps1 first)')

W, H, PAD = 880, 260, 46
PANEL_W = (W - PAD * 2 - 40) // 3
TOP, BOT = 56, H - 40

def polyline(vals, lo, hi, x0):
    n = len(vals)
    span = max(hi - lo, 1e-9)
    pts = []
    for i, v in enumerate(vals):
        x = x0 + i * (PANEL_W - 10) / max(n - 1, 1) + 5
        y = BOT - (v - lo) / span * (BOT - TOP)
        pts.append('%.1f,%.1f' % (x, y))
    return ' '.join(pts)

def panel(x0, title, vals, unit, color):
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-9:
        hi = lo + 1
    lo, hi = lo - (hi - lo) * 0.15, hi + (hi - lo) * 0.15
    s = ['<g>']
    s.append('<text x="%d" y="34" font-family="Segoe UI,sans-serif" font-size="15" fill="#1f2937" font-weight="600">%s</text>' % (x0, title))
    s.append('<text x="%d" y="52" font-family="Segoe UI,sans-serif" font-size="12" fill="#6b7280">min %.1f / max %.1f %s</text>' % (x0, min(vals), max(vals), unit))
    s.append('<rect x="%d" y="%d" width="%d" height="%d" fill="#f9fafb" stroke="#e5e7eb"/>' % (x0, TOP - 6, PANEL_W, BOT - TOP + 12))
    pl = polyline(vals, lo, hi, x0)
    s.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="2.5" stroke-linejoin="round"/>' % (pl, color))
    s.append('<polyline points="%d,%.1f %s %d,%.1f" fill="%s22" stroke="none"/>' % (
        x0 + 5, BOT, pl, x0 + PANEL_W - 5, BOT, color))
    s.append('<text x="%d" y="%d" font-family="Segoe UI,sans-serif" font-size="11" fill="#9ca3af">%s</text>' % (x0, H - 12, unit))
    s.append('</g>')
    return '\n'.join(s)

heap = [r['heap'] for r in rows]
fps = [r['fps'] for r in rows]
lag = [r['lag'] for r in rows]
x1, x2, x3 = PAD, PAD + PANEL_W + 20, PAD + PANEL_W * 2 + 40

svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">' % (W, H, W, H)]
svg.append('<rect width="%d" height="%d" fill="#ffffff"/>' % (W, H))
svg.append('<text x="%d" y="22" font-family="Segoe UI,sans-serif" font-size="16" fill="#111827" font-weight="700">Soak sampling curve - tests/soak.ps1 (%d samples, %.1f min window)</text>' % (PAD, len(rows), rows[-1]['t']))
svg.append(panel(x1, 'UI JS Heap (MB)', heap, 'MB', '#2563eb'))
svg.append(panel(x2, 'FPS (60 = full rate)', fps, 'fps', '#16a34a'))
svg.append(panel(x3, 'Bridge event-loop lag (ms)', lag, 'ms', '#ea580c'))
svg.append('</svg>')

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with io.open(OUT, 'w', encoding='utf-8') as f:
    f.write('\n'.join(svg))
print('written', os.path.normpath(OUT), len(rows), 'samples')
