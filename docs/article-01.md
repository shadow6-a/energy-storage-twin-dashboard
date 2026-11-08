# 从前端大屏到可观测节点：如何为高频数据可视化构建容错与监控体系

> 项目：零 npm 依赖、纯原生 JS/Node.js 的储能电站数字孪生调度大屏
> [开源仓库](https://github.com/shadow6-a/energy-storage-twin-dashboard) · [在线 Demo](https://shadow6-a.github.io/energy-storage-twin-dashboard/)

## 引言：别再「裸奔」做大屏了

在很多人的认知里，工业大屏 / 数字孪生就是一个前端 UI 活——「把数据接过来，用 ECharts 或 Three.js 画得酷炫一点，加点流光特效就行了」。直到你遇到真实的工业现场：BMS 传来一堆 NaN、网络每隔几分钟抖动断流、操作员拼命点「确认」但指令全丢在半路。没有容错和监控的大屏，就是一个昂贵的、随时会引爆的定时炸弹。

本文从架构层面拆解：如何用纯原生 JS / Node.js，把一个「只能看」的大屏重构成「能抗事、可监控」的边缘节点。

![零 Docker 运行健康仪表盘：四联曲线 + 指标卡 + /health 告警条](https://shadow6-a.github.io/energy-storage-twin-dashboard/docs/img/nodocker-dashboard.png)

![实时大屏 × 可观测曲线：一套系统的两面](https://shadow6-a.github.io/energy-storage-twin-dashboard/docs/img/hero-compare.png)

上图是运行健康面板（消息速率 / 队列深度 / JS Heap / 事件循环延迟），下图是实时大屏与长跑采样曲线的并排对照。以下三个「深水区」，是用 Vue + ECharts 写大屏的人通常不会去碰的部分。

## 深水区一：入口闸门——工业数据宁缺毋假

消费互联网里，数据偶尔延迟或平滑一下没关系；储能 / 电网场景里，展示错误数据可能导致严重误判。我们把防线推到 Node.js 桥接层（Ingress）——**脏数据根本不该有机会到达前端**。

设计哲学：面对跳变、NaN、越界数据，绝不使用平滑算法（Smoothing）。平滑意味着篡改，工业数据必须「宁缺毋假」。

```js
// server/bridge.js —— 物理合理性闸门
function plausible(id, s, roster) {
  const mw = (roster.get(id) || {}).mw || 200;
  if (s.power != null && (!isFinite(s.power) || Math.abs(s.power) > mw * 3)) return false;
  if (s.soc  != null && (!isFinite(s.soc)  || s.soc  < 0 || s.soc  > 100)) return false;
  if (s.temp != null && (!isFinite(s.temp) || s.temp < -40 || s.temp > 90)) return false;
  return true;
}
if (!plausible(s.id, s, rosterMap)) { M.inc('ess_mqtt_msgs_dropped_total'); return; }  // 丢弃并计数
```

还有一道更隐蔽的防线：真实 BMS 经网关转发后，10 秒前的报文姗姗来迟是常态，照单全收会把新值打回去。

```js
const skew = prev.srcTs ? prev.srcTs - srcTs : 0;
if (skew > 2000 && skew < 60000) { M.inc('ess_mqtt_msgs_stale_total'); return; }  // 迟到旧数据，拒收
// skew >= 60s 视为发布端时钟回拨（NTP 校时），重置基线照常接受
```

站级超过 12 秒无消息，下发 `comm:'offline'` + `power: 0`，**不是留着最后一个值假装在线**。

实战验证：`tests/fault_inject.ps1` 直接 kill 数据源，12 秒后 8/8 站点全部判掉线，重启 2 秒内恢复；`tests/chaos_e2e.ps1` 每 6 秒补发一帧 10 秒前的旧快照，实测 4 帧全部被拒收，S01 功率 5 次连测从未被污染。

## 深水区二：Outbox 控制链路——打破「UI 变绿即成功」的幻觉

绝大多数大屏的致命伤：前端点一下确认，页面变绿了，指令根本没发到设备端。弱网下乐观更新（Optimistic UI）是一个巨大的谎言。

```
[大屏] ──WS {t:'op'}──▶ [桥接]
                          ├─① appendFileSync ─▶ ops.jsonl   （审计先行，不可丢）
                          └─② publish ───────▶ MQTT broker ─▶ EMS / 工单系统
                                    └─ 失败 ─▶ outbox[] ── 2s × 5 ─▶ opAck{delivered:true}
                                                              └─ 耗尽 ─▶ opAck{delivered:false}
                                                                          └▶ 前端回滚 + toast
```

```js
fs.appendFileSync(opsLog, JSON.stringify(rec) + '\n');   // 先落盘，进程重启也不丢
if (publishOps(rec)) M.inc('ess_ops_published_total');
else { opsQueue.push({ rec, tries: 0 }); M.set('ess_ops_queue_depth', opsQueue.length); }
```

前端只认终态，失败就回滚——状态以桥接为准，不猜：

```js
if (m.t === 'opAck' && m.delivered === false) {
  ids.forEach(id => { const a = DATA.ALERTS.find(x => x.id === id); if (a) a.status = 0; });
  renderAlerts(); renderStations();
  toast('处置指令投递失败（重试 ' + m.tries + ' 次未达 broker），已回退本地状态', 'warn');
}
```

`queue_depth`、`dead_total`、`retry_total`、`ops_writeback_ms` 全部接入 Prometheus 指标。网络拥堵时，运维在 Grafana 看到的是**队列深度曲线在抬升**，而不是抱怨「确认按钮又坏了」，更不会疯狂点击导致指令重发。

混沌实测（`tests/chaos_e2e.ps1` 每 25 秒强拆一次 MQTT TCP）：断链窗口注入指令 → 队列深度 = 1（有界，无风暴）→ 退避上限内重连 → 队列收敛到 0（最终一致）→ 死信 0 → UI 数据年龄全程 < 12s。12 条断言全绿。

## 深水区三：把遥测从测试框架里剥离

UI 的可观测性靠 Playwright 截图算 FPS 吗？不，**测试工具不应承担生产监控的职责**。我们把遥测做成产品代码：大屏每 10 秒把运行态指标打包成一条 WS 帧推给桥接，桥接聚合进内存注册表，Prometheus 抓 `/metrics` 时一并吐出——前端指标和 Node.js 进程指标落在同一个端点。

```js
// assets/js/monitor.js —— 生产代码，不是测试脚本
function report() {
  sampleHeap();                                   // performance.memory
  const s = DataIO.status();
  DataIO.send({ t: 'telemetry', fps: T.fps, heapMB: T.heapMB,
    reconnects: s.reconnects,
    lastDataAge: Math.round((Date.now() - s.lastDataTs) / 1000), ts: Date.now() });
}
Monitor.start(10000);
```

于是 72h 长跑采样器不再需要任何测试框架：`tests/soak.ps1` 只用系统浏览器打开大屏（工控机开机 → 挂上大屏 → 几个月不关），定时轮询 `/metrics` 写 CSV，堆增长超阈值自动失败退出。3 分钟快测的真实数据：

| 指标 | 起点 | 终点 | 结论 |
|---|---|---|---|
| 前端 JS Heap | 3.2 MB | 2.2 MB | 增长 -1MB，零泄漏迹象 |
| FPS | 60 | 60 | 恒定满帧 |
| 数据年龄 | 1s | 0~1s | 数据源持续新鲜 |
| 事件循环延迟 | 3 ms | 1~15 ms | 无卡顿长尾 |

有 Docker 的环境可 `cd deploy && docker compose up -d` 一键拉起 Prometheus + Grafana（预置「运行健康」仪表盘）；这套是给多租户、长期存储用的生产级方案。

为了方便在完全无外网的工控机或没有 Docker 的环境中演示，我在 deploy/nodocker/ 下用纯 Node.js 内置模块手写了一套等价的可视化与采集层。它同样能抓取 18 个指标、绘制四联曲线并触发 /health 告警。这套方案不依赖任何第三方工具，证明了可观测性完全可以在零依赖的前提下落地。

## 结语：前端工程师的护城河

当大模型能在一秒钟内写出满屏的 Vue / ECharts 组件时，单纯「写 UI」的护城河正在消失。但「如何保证系统在极端环境下依然平稳运行」、「如何设计健壮的接口契约」、「如何用混沌工程验证假设」，这些经验来自故障而不是语法。

这个项目零框架、纯原生，每条防线都有可复现的测试脚本背书（86 回归 + 9 live E2E + 10 MQTT E2E + 9 故障注入 + 12 混沌 + 10 拔网线断言）。如果你也对「可测试、可运维」的工业大屏感兴趣，欢迎交流。
