# 零依赖手写 MQTT 3.1.1 客户端与协议契约驱动的设计

> 系列第二篇 · 网络编程 / 协议层
> [开源仓库](https://github.com/shadow6-a/energy-storage-twin-dashboard) · [在线 Demo](https://shadow6-a.github.io/energy-storage-twin-dashboard/) · [第一篇：从前端大屏到可观测节点](https://shadow6-a.github.io/energy-storage-twin-dashboard/docs/article-01.html)

## 引子：为什么在一个「前端项目」里手写协议栈

故事始于一个朴素的需求：储能电站现场 EMS 只出 MQTT，而大屏是纯原生 JS。最常规的解法是 `npm i mqtt`——但现场约束让这条路变窄：工控机离线部署、不允许运行时拉依赖、断连时运维要能逐层解释「现在卡在哪一步」，而且我们只需要协议的一个很小子集。

MQTT 3.1.1 规范并不神秘。对 QoS0 遥测场景，真正要处理的只有 8 类报文（下表按 5 组列出）：

| 报文 | 固定头 | 作用 |
|---|---|---|
| CONNECT / CONNACK | `0x10` / `0x20` | 握手、鉴权、keepalive |
| SUBSCRIBE / SUBACK | `0x82` / `0x90` | 订阅通配主题 |
| PUBLISH | `0x30` | QoS0 遥测收发（双向） |
| PINGREQ / PINGRESP | `0xC0` / `0xD0` | 链路保活 |
| DISCONNECT | `0xE0` | 优雅下线 |

于是我们写了约 170 行 Node `net` 直连代码，零依赖。这篇文章不劝你造轮子，而是拆开看：**协议客户端真正难的部分，从来不是拼字节，而是边界与契约**。

![MQTT 3.1.1 QoS0 报文时序：从 CONNECT 到 PUBLISH 到保活](https://shadow6-a.github.io/energy-storage-twin-dashboard/docs/img/mqtt-sequence.png)

## 一、变长整数与粘包：TCP 是字节流，不是消息

MQTT 的 Remaining Length 是 1~4 字节的变长整数，每个字节只用低 7 位，最高位表示「还有后续字节」：

```js
function encodeLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}
```

解码必须处理**半包**：`decodeLen` 在字节不足时返回 `null`，而不是抛异常。`sock.on('data')` 把数据累积到 `buf`，只要「头不完整 / 长度字段不完整 / 包体不完整」就 `break`，等下一批数据：

```js
buf = Buffer.concat([buf, chunk]);
for (;;) {
  if (buf.length < 2) break;
  const l = decodeLen(buf, 1);
  if (!l) break;                       // 半包：等下一批 TCP 数据
  const total = 1 + l.bytes + l.value;
  if (buf.length < total) break;
  onPacket(buf[0] >> 4, buf[0] & 0x0f, buf.slice(1 + l.bytes, total));
  buf = buf.slice(total);              // 一次 data 事件里的粘包，继续循环切
}
```

这两段是整个客户端最容易写错的地方。用库时你不会看见它们；自己写时，**它决定了弱网 / 网关分片下会不会莫名其妙丢一整帧遥测**。握手同样是纯字节拼装：协议名 `MQTT`、版本 `4`、`clean session`、可选用户名密码、keepalive 60s。

## 二、韧性：退避要封顶，心跳要能被「强拆」

连接状态机收敛在 `close` 事件里：指数退避 `1s → 2s → 4s …`，**30 秒封顶**；混沌演练的 `drop(ms)` 还能在窗口内抑制重连：

```js
const backoff = Math.min(30000, 1000 * Math.pow(2, retry++));
const suppressed = Math.max(0, suppressUntil - Date.now());
timer = setTimeout(connect, backoff + suppressed);
```

`api.drop(ms)` 只 `sock.destroy()` 而不置 `dead` 标志——链路会走正常的 close → 退避 → 重连路径。这不是新功能，而是**把「断网」变成可编程的测试输入**：`--chaos-flap 25` 每 25 秒强拆一次 TCP，用来验证 Outbox 队列恢复后不会雪崩。

一个诚实的边界：`retry` 在 TCP 建连成功时清零，而不是 CONNACK 之后。若 broker 持续返回非零 rc，客户端会以 1 秒间隔反复重连而不是逐步退避。内网固定 broker 够用；面向公网多租户 broker 时，应把清零点推迟到 CONNACK 成功。**写清楚这种边界，比写一句「支持断线重连」有价值得多。**

![协议契约驱动：从 EMS 字节到浏览器 UI 的五层转换](https://shadow6-a.github.io/energy-storage-twin-dashboard/docs/img/mqtt-layers.png)

## 三、协议契约驱动：前端根本不认识 MQTT

架构收益最大的一处设计：前端只认一组 WebSocket 帧，MQTT 侧的多样性全部被桥接层吸收。

| 主题 | 载荷 | 说明 |
|---|---|---|
| `ess/scada` | `{stations:[{id,power,soc,soh,temp,status}]}` 或单站 | 1Hz 遥测，批量推荐 |
| `ess/alert` | `{id,lv,st,dev,text}` | 新告警即时进台账 |
| `ess/ops` | 桥接**发布**给 EMS | 处置回写（确认/闭环/撤销） |

桥接按优先级宽松识别 4 类规则（协议帧 / 批量 / 单站 / 告警），现场用 MQTTX 手发一段 JSON 就能见效，不必先对齐 schema：

```js
if (m.t === 'scada' && Array.isArray(m.stations)) { /* 批量帧 */ }
if (m.t === 'scada' && m.id)                     { /* 单站帧 */ }
if (m.t === 'alert')                             { /* 告警帧 */ }
if (Array.isArray(m.stations))                   { /* 裸 JSON 批量 */ }
if (m.id && ('power' in m || 'soc' in m))         { /* 裸 JSON 单站 */ }
if (m.id && (m.lv || m.text))                     { /* 裸 JSON 告警 */ }
```

换数据源（CSV 演示 / MQTT / 数据库 / OPC-UA 网关）时，**只改摄取函数，前端一行不动**。反向指令主题也从 `--topic` 自动推导，不写死：

```js
const OPS_TOPIC = MQTT_TOPIC.replace(/[#*]+$/, '').replace(/\/+$/, '') + '/ops';
// --topic 'plant/#' → plant/ops
```

这个「跟随前缀」的细节是被真实故障教训出来的：早期回写写死 `ess/ops`，在公共 broker 上撞进别人的告警洪流，测试告警被挤出前端台账窗口，E2E 断言随机失败。改成前缀推导 + 每次测试随机前缀隔离后才稳定全绿。

契约的另一端是浏览器：`?ws=live` 在服务器部署时自动推导同域 `/ws`（https 自动 wss），nginx 反代到 `127.0.0.1:9001`；断线重连必须沿用**实际连接地址** `state.url`，而不是退回 `config.js` 的默认值——这个 bug 曾让「恢复网线」永远连不回网关。这类边角，恰恰是协议契约最容易塌方的地方。

## 四、验证：让契约变成可执行的断言

`tests/mqtt_e2e.ps1` 在公共 broker 上跑通 10 条断言，覆盖从字节到 UI 的整条链：

```
health source=mqtt → subscribed → msgs ingested → WS connected → 角标「实时」
→ 3s 内 8 站数值跳动 → S06 判离线 → MQTT 告警进台账 → 回写落 ops.jsonl → 回写发布到 <prefix>/ops
```

再叠上 12 条混沌断言（乱序拒收、有界排队、退避上限、最终一致收敛）与 10 条拔网线断言（降级推演 → 4 秒重连 → 平滑回实时）。联调只需三条命令：

```bash
node server/bridge.js 9001 --mqtt mqtt://broker.emqx.io:1883 --topic 'ess/#'
node server/mqtt-sim.js --prefix ess     # 无 EMS 时的替身，1Hz 遥测 + 随机告警
# 浏览器 index.html?ws=live ；MQTTX 订阅 ess/# 围观原始报文
```

## 五、不做什么，比做了什么更重要

明确列出边界，方便判断「什么时候该换回成熟库」：

- 只实现 **QoS0**（内网网关 99% 的遥测场景）；QoS1/2 的重传与去重未做
- 不支持 TLS（`net.connect`，需要时换 `tls.connect`）、遗嘱消息、持久会话
- 未实现 SUBSCRIBE 失败重试与 QoS1 的 PUBACK
- 单 broker、单连接；没有集群 / 共享订阅

一旦现场要求「指令必达 + 断网补发 + TLS 双向认证」，正确决策是换 `mqtt.js` 或 EMQX SDK，而不是把这 170 行继续膨胀。**手写协议的价值在于：你知道每一行在做什么、边界在哪、什么时候该放手。**

## 结语

协议层不是黑魔法。把 TCP 字节流、状态机、退避曲线、摄取契约摊开之后，「MQTT 接入」就从一个依赖包变成了一组可被测试、被观测、被解释的行为。对工业现场来说，这种可解释性本身就是交付物。

- 仓库：[github.com/shadow6-a/energy-storage-twin-dashboard](https://github.com/shadow6-a/energy-storage-twin-dashboard)
- 协议契约全文：[docs/data-contract.md](https://github.com/shadow6-a/energy-storage-twin-dashboard/blob/main/docs/data-contract.md)
- 在线 Demo：[shadow6-a.github.io/energy-storage-twin-dashboard](https://shadow6-a.github.io/energy-storage-twin-dashboard/)
