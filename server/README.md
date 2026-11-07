# 实时数据桥接服务（server/）

零依赖 Node 脚本：把 CSV 演示数据源转成大屏 WebSocket 协议（`docs/data-contract.md`），
让前端在**没有 EMS 后端**时也能跑通「实时指标 → 告警推送 → 处置回写 → 多端同步」全链路。

## 运行

```bash
node server/bridge.js          # 默认 ws://127.0.0.1:9001/ws，端口可传参：node bridge.js 9100
```

页面接线（三选一）：

```text
index.html?ws=live              → 连 config.js 里的 url（默认 127.0.0.1:9001/ws）
index.html?ws=ws://10.0.0.5:9001/ws   → 临时指向任意网关
assets/js/config.js { source:'ws', url:'…' }   → 永久生效
```

顶栏「数据链路」角标：`演示数据`(灰) / `模拟推送`(琥珀) / `实时`(绿) / `重连 Ns`(琥珀)。

## MQTT 模式（真实采集）

桥接内置零依赖 MQTT 3.1.1 客户端（`server/mqtt.js`），直连现场 broker：

```bash
node server/bridge.js 9001 --mqtt mqtt://broker.emqx.io:1883 --topic 'ess/#'
node server/bridge.js 9001 --mqtt mqtt://10.0.0.5:1883 --topic 'plant/#' --user ems --pass '***'
```

- 订阅 `--topic`（默认 `ess/#`），消息按 `docs/data-contract.md` §4 宽松识别：
  `{stations:[…]}` / 单站 `{id,power,soc}` / 告警 `{id,lv,st,text}` / 协议帧直通
- 某站 >12s 无消息自动判掉线（`comm:"offline"`），复通自动恢复
- 处置回写双通道：`data/ops.jsonl` 落盘 + 发布 `ess/ops`（EMS/工单系统订阅即可接单）
- `GET /health` 回报 `source:"mqtt"`、`mqtt:"connected"`、`mqttMsgs` 计数

### 没有 EMS 时：用模拟器自证链路

```bash
node server/mqtt-sim.js --prefix ess          # 终端 2：1Hz 遥测 + 20~30s 一条随机告警
node server/mqtt-sim.js --prefix testtopic    # 特殊：让你 MQTTX 里订阅 testtopic/# 直接围观
```

前端打开 `index.html?ws=live`，角标变绿即数据在流；MQTTX 里手动 Publish 一条
`{"id":"S01","power":88.5,"soc":61}` 到任意被订阅主题，大屏 1 秒内跟随。

## 它做什么

| 帧节拍 | 内容 |
|---|---|
| 连接时 | `hello`（站点清单 + 告警全量）+ 每站 `history` 24h 曲线 |
| 每 1s | `scada` 批量指标帧（CSV 基线 + 计划曲线 + 随机游走模拟真实波动） |
| 每 30s | `history` 24h 曲线帧 |
| 事件 | 前端 `op` 处置回写 → 落盘 `data/ops.jsonl` + 广播 `alertState`（多屏同步） |

`GET /health`：JSON 探活（客户端数 / 站点数 / 告警数）。

## 换成真实数据源

`bridge.js` 只是协议转换器。接真实采集时：

1. `simulateStations()` 替换为真实适配器——MQTT（`sources/mqtt.js` 待实现，
   `npm i mqtt` 后订阅主题映射到 scada 帧）、Modbus TCP、关系库轮询皆可；
2. `buildHistory()` 改为从历史库（InfluxDB / TDengine / 时序库）取 96 点；
3. `op` 回写改为转发贵方 EMS 工单接口（现在是 JSONL 落盘）；
4. `stations.csv / alerts.csv` 随之退役。

前端零改动——协议即接口边界。
