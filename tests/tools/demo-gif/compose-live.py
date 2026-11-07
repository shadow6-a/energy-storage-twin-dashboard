"""Compose assets/img/demo.gif from frames captured by record-live.ps1.

Live variant: 500ms per frame (dynamism over static v1 flow), 880px wide,
128-color palette (dark UI compresses cleanly).
"""
import glob
import os

from PIL import Image

W = 880
FRAME_MS = 500

files = sorted(glob.glob('_gif/f*.png'))
assert len(files) >= 20, f'frames too few: {len(files)}'
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
