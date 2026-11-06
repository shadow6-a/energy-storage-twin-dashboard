import glob
import os
from PIL import Image

files = sorted(glob.glob('_gif/f*.png'))
assert len(files) >= 20, f'frames too few: {len(files)}'
frames = []
for f in files:
    im = Image.open(f).convert('RGB')
    im = im.resize((960, 600), Image.LANCZOS)
    frames.append(im)
os.makedirs('assets/img', exist_ok=True)
out = 'assets/img/demo.gif'
frames[0].save(out, save_all=True, append_images=frames[1:],
               duration=[700] * len(frames), loop=0, optimize=True)
print('gif bytes:', os.path.getsize(out), 'frames:', len(frames))
