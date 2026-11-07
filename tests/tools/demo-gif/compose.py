"""把 record.ps1 抓到的帧合成 assets/img/demo.gif。

体积权衡（实测）：1280 宽 + 256 色原本 5.3MB；880 宽 + 128 色调色板 1.8MB，
深色 UI 压到 128 色无可视色带，README 首屏加载更友好。
"""
import glob
import os

from PIL import Image

W = 880          # 输出宽度（README 渲染足够）
FRAME_MS = 700   # 每帧驻留

files = sorted(glob.glob('_gif/f*.png'))
assert len(files) >= 15, f'frames too few: {len(files)}'
frames = []
for f in files:
    im = Image.open(f).convert('RGB')
    h = round(im.height * W / im.width)
    im = im.resize((W, h), Image.LANCZOS)
    frames.append(im.convert('P', palette=Image.ADAPTIVE, colors=128))

os.makedirs('assets/img', exist_ok=True)
out = 'assets/img/demo.gif'
frames[0].save(out, save_all=True, append_images=frames[1:],
               duration=[FRAME_MS] * len(frames), loop=0, optimize=True)
print('gif:', out, round(os.path.getsize(out) / 1024 / 1024, 2), 'MB', len(frames), 'frames')
