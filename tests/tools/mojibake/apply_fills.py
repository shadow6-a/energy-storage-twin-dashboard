"""按 _fix_<page>.json 判定表回填 v1.2.2 事故页面的缺口，并做后置修正。

仅在复现恢复过程时使用；正常迭代请直接编辑页面文件。
用法：python tests/tools/mojibake/apply_fills.py
"""
import io, os, json, re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
FILES = ['components.html', 'flow.html', 'mockups.html', 'story.html']

# 字节级无法还原、需人工补的 3 处（见 README「结论」）
POST_FIX = [
    ('feasibility.md 附 A', 'feasibility.md 附录 A'),
    ('主流程++ 抑制旁路', '主流程 + 抑制旁路'),
]
POST_FIX_RE = [(r'(?<![<\w])/p>', '</p>')]


def decode_pieces(fname):
    """字节流 -> 文本片段；缺口为 {'hole': True, 'pend': 待补全的 UTF-8 前缀}"""
    data = open(os.path.join(HERE, f'_rec_{fname}.bin'), 'rb').read()
    pieces, i, n, pending = [], 0, len(data), b''
    while i < n:
        b = data[i]
        if b == 0x00:
            pieces.append({'hole': True, 'pend': pending}); pending = b''; i += 2; continue
        if pending:
            full = pending + bytes([b])
            try:
                pieces.append({'t': full.decode('utf-8')}); pending = b''
            except Exception:
                pending = full
            i += 1; continue
        if b < 0x80:
            pieces.append({'t': chr(b)}); i += 1
        elif b >= 0xC0:
            ln = 2 if b < 0xE0 else (3 if b < 0xF0 else 4)
            seq = data[i:i+ln]
            done = False
            if 0x00 not in seq:
                try:
                    pieces.append({'t': seq.decode('utf-8')}); i += ln; done = True
                except Exception:
                    pass
            if not done:
                pending = bytes([b]); i += 1
        else:
            pieces.append({'t': '\ufffd'}); i += 1
    return pieces


def main():
    for f in FILES:
        table = json.load(io.open(os.path.join(HERE, f'_fix_{f.replace(".html", "")}.json'), encoding='utf-8'))
        table = {int(k[1:]): v for k, v in table.items()}
        out, hid, missing = [], 0, []
        for p in decode_pieces(f):
            if p.get('hole'):
                if hid in table:
                    out.append(table[hid][0]); out.append(table[hid][1])
                else:
                    missing.append(hid); out.append('〓')
                hid += 1
            else:
                out.append(p['t'])
        text = ''.join(out)
        for a, b in POST_FIX:
            text = text.replace(a, b)
        for pat, rep in POST_FIX_RE:
            text = re.sub(pat, rep, text)
        io.open(os.path.join(ROOT, f), 'w', encoding='utf-8', newline='').write(text)
        print(f, 'holes=', hid, 'missing=', missing,
              'fffd=', text.count('\ufffd'), 'bytes=', len(text.encode('utf-8')))


if __name__ == '__main__':
    main()
