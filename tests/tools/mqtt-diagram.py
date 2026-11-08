#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Two zero-extra-dependency diagrams for article-02 (Pillow only).
   docs/img/mqtt-sequence.png : MQTT 3.1.1 QoS0 packet sequence
   docs/img/mqtt-layers.png   : protocol-contract layers from EMS to browser
   Usage: python tests/tools/mqtt-diagram.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
OUT = os.path.join(ROOT, 'docs', 'img')
FONT = 'C:/Windows/Fonts/msyh.ttc'
W, H = 1600, 820


def f(sz):
    try:
        return ImageFont.truetype(FONT, sz)
    except OSError:
        return ImageFont.load_default()


def header(d, title, sub):
    d.rectangle([0, 0, W, 70], fill='#0f172a')
    d.text((28, 12), title, font=f(26), fill='#ffffff')
    d.text((28, 46), sub, font=f(13), fill='#94a3b8')


def harrow(d, x1, x2, y, color, label, right=True):
    d.line([(x1, y), (x2, y)], fill=color, width=2)
    tip = x2 if right else x1
    sign = -1 if right else 1
    d.polygon([(tip, y), (tip + sign * 11, y - 6), (tip + sign * 11, y + 6)], fill=color)
    d.text(((x1 + x2) / 2 - len(label) * 3.6, y - 24), label, font=f(13), fill=color)


os.makedirs(OUT, exist_ok=True)

# ---------------- diagram 1: packet sequence ----------------
img = Image.new('RGB', (W, H), '#ffffff')
d = ImageDraw.Draw(img)
header(d, 'MQTT 3.1.1 · QoS0 遥测链路时序（零依赖手写客户端）',
       '固定头字节 / 主题 / 频率全部可解释 · server/mqtt.js + server/bridge.js')
lx, rx = 430, 1170
d.rounded_rectangle([lx - 150, 92, lx + 150, 136], radius=8, fill='#dbeafe', outline='#93c5fd', width=2)
d.rounded_rectangle([rx - 150, 92, rx + 150, 136], radius=8, fill='#dcfce7', outline='#86efac', width=2)
d.text((lx - 88, 102), 'Bridge / 桥接客户端', font=f(16), fill='#1e3a8a')
d.text((rx - 78, 102), 'MQTT Broker', font=f(16), fill='#166534')
for x in (lx, rx):
    d.line([(x, 140), (x, H - 130)], fill='#cbd5e1', width=2)

steps = [
    (True,  '#64748b', 'TCP connect · net.connect（内网直连，无 TLS）'),
    (True,  '#2563eb', 'CONNECT 0x10 · clientId / clean session / keepalive 60s'),
    (False, '#16a34a', 'CONNACK 0x20 · rc=0 → connected = true'),
    (True,  '#2563eb', "SUBSCRIBE 0x82 · 'ess/#'（--topic 可改）"),
    (False, '#16a34a', 'SUBACK 0x90 · 订阅确认'),
    (False, '#16a34a', 'PUBLISH 0x30 · ess/scada · 1Hz 8 站批量遥测'),
    (True,  '#ea580c', 'PUBLISH 0x30 · ess/ops · 处置回写（Outbox 重试 2s×5）'),
    (True,  '#7c3aed', 'PINGREQ 0xC0 ↔ PINGRESP 0xD0 · 每 30s 保活'),
]
for i, (right, color, label) in enumerate(steps):
    y = 190 + i * 68
    harrow(d, lx, rx, y, color, label, right)
    if i == 7:
        harrow(d, rx, lx, y + 26, '#7c3aed', 'PINGRESP 0xD0', False)

d.rounded_rectangle([40, H - 118, W - 40, H - 62], radius=8, fill='#f8fafc', outline='#e2e8f0', width=2)
d.text((60, H - 108), '断链：close → 指数退避 min(30s, 1s·2^n) → 重连沿用实际 URL（不退回 cfg 默认值）',
       font=f(15), fill='#334155')
d.text((60, H - 84), '边界：仅 QoS0 · 无 TLS / 遗嘱 / 持久会话 · 需要指令必达时换成熟 SDK',
       font=f(13), fill='#94a3b8')
p1 = os.path.join(OUT, 'mqtt-sequence.png')
img.save(p1, optimize=True)
print('written', p1)

# ---------------- diagram 2: contract layers ----------------
img2 = Image.new('RGB', (W, 760), '#ffffff')
d2 = ImageDraw.Draw(img2)
d2.rectangle([0, 0, W, 70], fill='#0f172a')
d2.text((28, 12), '协议契约驱动 · 前端不认识 MQTT', font=f(26), fill='#ffffff')
d2.text((28, 46), '换数据源只改第 3 层，前端与 /metrics 一行不动', font=f(13), fill='#94a3b8')

layers = [
    ('① EMS / BMS', ['私有协议 / 现场采集网关', 'MQTTX 可手发 JSON 联调'], '#e0f2fe', '#0369a1'),
    ('② MQTT 字节层', ['ess/scada · ess/alert · ess/ops', 'QoS0 PUBLISH 0x30'], '#dcfce7', '#15803d'),
    ('③ 桥接 Ingress', ['宽松识别 4 类规则', '合理性闸门 / 乱序守卫', '12s 站级老化'], '#fef3c7', '#b45309'),
    ('④ WS 帧契约', ['t:scada / alert / opAck', 't:telemetry（前端遥测）'], '#ede9fe', '#6d28d9'),
    ('⑤ 浏览器 & 指标', ['大屏 UI / 状态回滚', '/metrics · /health'], '#fce7f3', '#be185d'),
]
x0, bw, gap, y0, bh = 40, 288, 18, 130, 280
for i, (title, lines, bg, fg) in enumerate(layers):
    x = x0 + i * (bw + gap)
    d2.rounded_rectangle([x, y0, x + bw, y0 + bh], radius=10, fill=bg, outline=fg, width=2)
    d2.text((x + 16, y0 + 18), title, font=f(18), fill=fg)
    d2.line([(x + 16, y0 + 58), (x + bw - 16, y0 + 58)], fill=fg, width=1)
    for j, line in enumerate(lines):
        d2.text((x + 16, y0 + 78 + j * 34), line, font=f(14), fill='#334155')
    if i < len(layers) - 1:
        d2.line([(x + bw + 2, y0 + bh / 2), (x + bw + gap - 4, y0 + bh / 2)], fill='#64748b', width=2)
        d2.polygon([(x + bw + gap - 2, y0 + bh / 2),
                    (x + bw + gap - 12, y0 + bh / 2 - 7),
                    (x + bw + gap - 12, y0 + bh / 2 + 7)], fill='#64748b')

notes = [
    ("--topic 'plant/#'  →  plant/ops", '回写主题自动推导；公共 broker 用随机前缀隔离噪声'),
    ('?ws=live  →  同域 /ws  →  nginx proxy_pass 127.0.0.1:9001', '断线重连沿用同一 URL，恢复后平滑回到真实数据'),
    ('10 断言 MQTT E2E · 12 断言混沌 · 10 断言拔网线', '协议契约的每个假设都有失败即退出的脚本背书'),
]
for i, (a, b) in enumerate(notes):
    y = 460 + i * 82
    d2.rounded_rectangle([40, y, W - 40, y + 68], radius=8, fill='#f8fafc', outline='#e2e8f0', width=2)
    d2.text((60, y + 10), a, font=f(16), fill='#0f172a')
    d2.text((60, y + 38), b, font=f(13), fill='#64748b')
p2 = os.path.join(OUT, 'mqtt-layers.png')
img2.save(p2, optimize=True)
print('written', p2)
