#!/usr/bin/env node
/* ============================================================
   零依赖 Markdown → 阅读版 HTML（GitHub Pages 文章发布用）
   ------------------------------------------------------------
   支持：标题 / 段落 / 引用 / 代码块（含无语言流程图）/ 表格 /
        图片 / 链接 / 加粗 / 行内代码。不引入任何 npm 包。
   用法：node tests/tools/md2html.js docs/article-01.md
   输出：同名 .html（默认 docs/article-01.html）
   ============================================================ */
'use strict';
const fs = require('fs'), path = require('path');

/* 无参数时构建 docs/article-*.md 全部文章；带参数时只构建指定文件 */
const args = process.argv.slice(2);
const targets = args.length
  ? [{ src: args[0], out: args[1] || args[0].replace(/\.md$/i, '.html') }]
  : fs.readdirSync('docs').filter(x => /^article-\d+\.md$/i.test(x))
      .map(x => ({ src: 'docs/' + x, out: 'docs/' + x.replace(/\.md$/i, '.html') }));

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}

function build(src, out) {
const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/);
const body = [];
let i = 0, para = [];
function flushPara() {
  if (!para.length) return;
  const isImg = para.length === 1 && /^<img /.test(inline(para[0]));
  body.push(isImg ? '<figure>' + inline(para[0]) + '</figure>' : '<p>' + para.map(inline).join('<br>') + '</p>');
  para = [];
}
while (i < lines.length) {
  const L = lines[i];
  if (/^```/.test(L)) {
    flushPara();
    const lang = L.slice(3).trim();
    const buf = [];
    i++;
    while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
    i++;
    body.push('<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' + esc(buf.join('\n')) + '</code></pre>');
    continue;
  }
  if (/^#{1,3}\s/.test(L)) {
    flushPara();
    const n = (L.match(/^#+/) || ['#'])[0].length;
    body.push('<h' + n + '>' + inline(L.replace(/^#+\s/, '')) + '</h' + n + '>');
    i++; continue;
  }
  if (/^>\s?/.test(L)) {
    flushPara();
    const q = [];
    while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
    body.push('<blockquote>' + q.map(inline).join('<br>') + '</blockquote>');
    continue;
  }
  if (/^\|/.test(L)) {
    flushPara();
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
    const cells = r => r.split('|').slice(1, -1).map(c => c.trim());
    const head = cells(rows[0]);
    const data = rows.slice(2).map(cells);   // rows[1] 是 |---| 分隔行
    body.push('<table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') +
      '</tr></thead><tbody>' + data.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table>');
    continue;
  }
  if (/^[-*]\s/.test(L)) {
    flushPara();
    const items = [];
    while (i < lines.length && /^[-*]\s/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s/, '')); i++; }
    body.push('<ul>' + items.map(x => '<li>' + inline(x) + '</li>').join('') + '</ul>');
    continue;
  }
  if (/^---+$/.test(L.trim())) { flushPara(); body.push('<hr>'); i++; continue; }
  if (!L.trim()) { flushPara(); i++; continue; }
  para.push(L); i++;
}
flushPara();

const title = (lines.find(x => /^#\s/.test(x)) || '技术文章').replace(/^#\s/, '');
const mdLink = esc(path.basename(src));   /* 按输入文件推导源码链接，第二篇不会错指第一篇 */
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 储能孪生</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f6f8fa; color: #24292f; font: 16px/1.85 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .top { background: #0f172a; color: #cbd5e1; padding: 12px 20px; font-size: 13px; }
  .top a { color: #7dd3fc; text-decoration: none; margin-right: 16px; }
  main { max-width: 860px; margin: 32px auto 60px; background: #fff; padding: 40px 52px 56px; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 2px 14px rgba(15,23,42,.05); }
  h1 { font-size: 30px; line-height: 1.4; margin: 0 0 22px; }
  h2 { font-size: 22px; margin: 40px 0 14px; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb; }
  p { margin: 0 0 16px; }
  blockquote { margin: 0 0 22px; padding: 10px 18px; background: #f1f5f9; border-left: 4px solid #38bdf8; color: #475569; font-size: 14px; }
  pre { background: #0f172a; color: #e2e8f0; padding: 16px 18px; border-radius: 8px; overflow-x: auto; font: 13px/1.65 Consolas, "Courier New", monospace; margin: 0 0 20px; }
  code { background: #f1f5f9; padding: 2px 5px; border-radius: 4px; font: 13px Consolas, monospace; }
  pre code { background: none; padding: 0; color: inherit; }
  figure { margin: 0 0 20px; }
  img { max-width: 100%; height: auto; border: 1px solid #e5e7eb; border-radius: 6px; display: block; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 22px; font-size: 14px; }
  th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
  th { background: #f8fafc; }
  a { color: #0366d6; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 30px 0; }
  footer { max-width: 860px; margin: 0 auto 40px; color: #94a3b8; font-size: 12px; text-align: center; }
  @media (max-width: 700px) { main { margin: 0; padding: 24px 18px; border-radius: 0; } h1 { font-size: 24px; } }
</style>
</head>
<body>
<div class="top">
  <a href="https://github.com/shadow6-a/energy-storage-twin-dashboard">GitHub 仓库</a>
  <a href="https://shadow6-a.github.io/energy-storage-twin-dashboard/">在线 Demo</a>
  <a href="${mdLink}">Markdown 源码</a>
  <span>储能孪生 · 技术复盘</span>
</div>
<main>
${body.join('\n')}
</main>
<footer>零依赖构建 · node tests/tools/md2html.js · 托管于 GitHub Pages</footer>
</body>
</html>
`;
fs.writeFileSync(out, html, 'utf8');
console.log('built', out, html.length, 'bytes,', body.length, 'blocks');
}

for (const t of targets) build(t.src, t.out);
