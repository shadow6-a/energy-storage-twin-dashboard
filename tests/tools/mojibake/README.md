# 乱码恢复工具链（v1.2.2 事故善后）

> 一次性工具，留档以复现/审计 v1.3.1 的四个文档页恢复过程。**不要**在正常迭代中重跑它。

## 背景

v1.2.2 事故中 `components/flow/mockups/story.html` 的 UTF-8 字节被当作 CP936 解码后重存，
中文变成 mojibake（如「三个核心价值」→「涓変釜鏍稿績浠峰€」）。

## 原理

1. **字节级逆向**（`recover_bytes.ps1`）：把每个 mojibake 字符按 CP936 编码回原始字节，
   PUA 字符（U+E000–U+F8FF）用穷举表还原为字节对，`€` 还原为 `0x80`。
2. **缺口标记**：损坏文本里「紧跟在中日韩字符后的 `?`」= 解码器吃掉的 2 字节
   （1 个 UTF-8 尾字节 + 1 个 ASCII 字符，通常是 `<`、`/`、`'`、空格），
   在字节流中写成 `00 00` 占位。
3. **上下文判读**（`_fix_<page>.json`）：778 个缺口逐个按语义判定「缺的汉字 + 缺的 ASCII 字符」，
   依据是缺口前后文、同页重复文案、以及 `index.html`/`data.js`/`README` 等未损坏文件的语料。
4. **应用**（`apply_fills.py`）：按判定表回填，再做三处后置修正（见 `POST_FIX`）。

## 用法

```powershell
cd e:/UI
powershell -ExecutionPolicy Bypass -File tests/tools/mojibake/recover_bytes.ps1   # 生成 _rec_*.bin
python tests/tools/mojibake/apply_fills.py                                        # 回填四个页面
```

## 结论

- 恢复率：字数级 ~99.8%（仅 3 处不可逆字节丢失需人工补，已在 `POST_FIX` 固化）
- 校验：四页内联脚本 `node --check` 全通过、浏览器 console 0 error、`tests/artifacts/restore-*.png` 截图留档
