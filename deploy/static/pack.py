#!/usr/bin/env python3
"""Pack the whole static site into dist/ess-twin-static.tar.gz (zero deps).
Only browser-served files: root *.html, assets/**, docs/** (incl. article images).
Excludes .git, server/, tests/, deploy/, temp artifacts.
Usage: python deploy/static/pack.py
"""
import io, os, sys, tarfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DIST = os.path.join(ROOT, 'dist')
OUT = os.path.join(DIST, 'ess-twin-static.tar.gz')

SKIP_DIRS = {'.git', '.github', '.playwright-cli', 'server', 'tests', 'deploy',
             'node_modules', '_gif', '_corrupted_backup', 'dist', '__pycache__'}
SKIP_EXT = {'.log', '.pyc', '.out'}


def wanted(rel):
    parts = rel.split(os.sep)
    if parts[0] in SKIP_DIRS:
        return False
    if os.path.splitext(rel)[1].lower() in SKIP_EXT:
        return False
    if len(parts) == 1:
        return rel.lower().endswith('.html')
    return parts[0] in ('assets', 'docs')

files = []
for base, dirs, names in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for n in names:
        full = os.path.join(base, n)
        rel = os.path.relpath(full, ROOT)
        if wanted(rel):
            files.append((full, rel.replace(os.sep, '/')))
files.sort(key=lambda x: x[1])
if not any(r == 'index.html' for _, r in files):
    sys.exit('index.html missing - abort')

os.makedirs(DIST, exist_ok=True)
with tarfile.open(OUT, 'w:gz', compresslevel=6) as tf:
    for full, rel in files:
        tf.add(full, arcname=rel, recursive=False)
size = os.path.getsize(OUT)
print('packed', len(files), 'files ->', OUT, '%.1f MB' % (size / 1048576.0))
print('root pages:', ', '.join(r for _, r in files if '/' not in r))
