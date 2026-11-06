# 储能电站集群 · 数字孪生调度大屏

![tests](https://img.shields.io/badge/tests-47%2F47%20passing-brightgreen) ![mutation](https://img.shields.io/badge/mutation--tested-8%20checklist-blue) ![version](https://img.shields.io/badge/version-v1.2--prototype-orange)

工业值守大屏原型：8 座储能电站集群的「站点列表 → 3D 拓扑 → 指标/告警/趋势」黄金三角布局，纯原生 Canvas 3D 渲染（零三方库），Playwright + PowerShell 回归门禁全程护栏。

## 演示动图（待录制）

建议 10–20 秒 GIF 展示完整键盘流：**站点下钻 → 告警确认 → Space 暂停 → C 驾驶舱切换 → 标签碰撞避让**（本地用 OBS / Chrome 录屏工具录制后放 `assets/img/demo.gif`，此处引用）——一张动图胜过长篇大论。

## 免责边界

- 当前版本**仅提供深色主题**（工业值守标准）；浅色报表主题已在设计系统 tokens 中预留扩展位（色彩令牌集中管理），可依据后续需求立项开发
- 完整边界声明见 `story.html` §05（版本定位 / 权限 / 审计 / 合规等 7 项）

## 核心差异化：可以被测试的大屏

大多数大屏项目只有截图，没有证据。本项目用底层测试驱动 UI 交付，门禁体系五要素：

| 要素 | 实现 |
|---|---|
| 期望表 | `tests/regression.ps1` 五档视口（1024/1280/1920/2560/3840）实测校准值，容差 ±2~3px |
| 变异背书 | `tests/mutation-checklist.md` 8 项「故意破坏 → 期望红」，证明断言真的能抓错 |
| 失败留痕 | 断言失败自动截图 `tests/artifacts/fail-{w}x{h}.png` + 三段定位（期望/实际/嫌疑规则） |
| 运行证据 | `tests/last-run.txt` 版本 + 时间戳 + 计数归档 |
| 退出码 | 非零失败退出，可挂 CI / pre-commit |

一条命令跑全量：

```powershell
powershell -ExecutionPolicy Bypass -File tests/regression.ps1
```

覆盖：溢出/滚动、字号档位、断点归属、ARIA 角色、密度开关、驾驶舱模式、console error 清零。

## 运行

```powershell
python -m http.server 8796   # 根目录起静态服务
# 打开 http://127.0.0.1:8796/index.html
```

## 快捷键

| 键 | 行为 |
|---|---|
| `Esc` | 上钻一级 / 关闭 AI 抽屉 |
| `Space` | 暂停 / 恢复实时刷新 |
| `C` | 驾驶舱模式（投屏态：仅主视图 + 顶栏 KPI，localStorage 记忆） |

## 版本里程碑

- **v1.2** · 标签屏幕空间碰撞避让（滞后阈值 + 引线 + 优先级）、驾驶舱模式、CSS 缓存治理（link 版本参数）
- **v1.1.x** · 视觉走查三轮：顶栏重构 / 黄金三角信息架构 / 顶栏 KPI 分隔线 / 告警行紧凑制 / SOC 分色进度条 / <13px 清扫 / 快捷键
- **v1.0** · 门禁体系闭环（期望表 + 变异 + 留痕 + 证据 + 退出码）
- **v0.9.x** · 断点体系 / ARIA / 4K 档 / 密度开关 / 特异性治理

完整沿革见 `CHANGELOG.md`；风险登记见 `risk-mitigation.md`；设计规范见 `components.html`。
