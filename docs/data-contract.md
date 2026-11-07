# 数据接口契约 v2（前端 ⇄ 实时数据网关）

> 前端已按本契约实现消费端（`assets/js/dataio.js`），网关可以是本项目自带的
> `server/bridge.js`（CSV 演示源），也可以是贵方 EMS/BMS 的 WebSocket 网关——
> **只要按本契约发帧，前端零改动接入**。纯前端演示（GitHub Pages）不启用本协议。

## 1. 传输与寻址

- 传输：WebSocket（RFC6455），文本帧，UTF-8 JSON，一帧一 JSON 对象
- 地址：`ws://<网关>:<端口>/ws`，配置于 `assets/js/config.js`（`DATA_CONFIG.url`）
- 生命周期：连接建立后网关**先推 `hello`**（全量对齐），随后按节拍推送增量
- 断线：前端指数退避重连（1s 起，封顶 30s），每 25s 发 `{t:'ping'}` 心跳；
  网关对应用层 ping 回 `{t:'pong'}`，或直接用协议层 ping/pong
- 容错：前端丢弃一切解析失败/未知 `t` 的帧（计数不中断），网关不必保证帧序

## 2. 服务端 → 前端

### hello（连接后首帧，全量对齐）

```json
{ "t": "hello", "v": 2, "bridge": "csv-demo",
  "stations": ["S01", "S02"],
  "alerts": [ { "id": "A001", "lv": "crit", "st": "S01",
                "dev": "2#电池舱 / 电池簇 C-07", "text": "单体电压极差…", "status": 0 } ],
  "ts": 1730980000000 }
```

### scada（站点实时指标，1s 级；批量一帧多站）

```json
{ "t": "scada", "ts": 1730980000000,
  "stations": [
    { "id": "S01", "power": 96.2, "soc": 62.31, "soh": 95.8,
      "temp": 29.6, "status": "discharging", "comm": "online" }
  ] }
```

- `power` MW（正放电/负充电）；`status`: `charging|discharging|standby|offline`
- `comm:"offline"` 时前端强制 power=0、拓扑灰显，其余字段忽略
- 兼容 v1 单站帧 `{ "t":"scada", "id":"S01", "power":96.2, "soc":62.3 }`

### alert（新告警实时进台账）

```json
{ "t": "alert", "alert": { "id": "A011", "lv": "high", "st": "S03",
  "dev": "2#电池舱 / 电池簇 C-02", "text": "簇电压异常下降", "time": "14:20" } }
```

- `lv`: `crit|high|warn|info`；`id` 全局唯一；前端台账池上限 40 条

### alertState（告警状态变更广播：确认/闭环/撤销后的多端同步）

```json
{ "t": "alertState", "id": "A001", "status": 2, "by": "web", "ts": 1730980001000 }
```

- `status`: `0 未确认 / 1 已确认 / 2 已闭环 / 3 已抑制`（与前端状态机一致）

### history（24h 曲线，可选；96 点 × 15min）

```json
{ "t": "history", "st": "S01", "ts": 1730980002000,
  "labels": [0.125, 0.375],
  "plan":   [-13.75, -13.75],
  "actual": [-13.55, null],
  "soc":    [62.4, 62.1],
  "socPlan":[60.0, 59.7],
  "nowIdx": 38 }
```

- `actual` 在 `nowIdx` 之后为 `null`（未来时刻）；未推送的站走前端本地推演
- 形状与前端 `DATA.buildSeries()` 完全一致，网关从历史库取数填充即可

### cluster（簇级单体数据，可选；进入 L3 视图时按需/定时推送）

```json
{ "t": "cluster", "st": "S01", "cabin": 1, "cluster": "C-07", "ts": 1730980003000,
  "data": { "soc": 58.2, "soh": 93.1, "temp": 36.9,
            "cells": [ { "idx": 1, "v": 3.321, "t": 33.8 }, "…32 个单体" ] } }
```

## 3. 前端 → 服务端（处置回写）

### op（确认 / 闭环 / 撤销，前端自动发送）

```json
{ "t": "op", "action": "close", "ids": ["A001", "A004"], "by": "web", "ts": 1730980010000 }
```

- `action`: `ack | close | undo`
- 断线时前端静默丢弃（本地审计不受影响）；网关应：落审计 → 变更状态机 →
  向**所有**客户端广播对应 `alertState`（多屏同步）
- 演示网关落盘：`server/data/ops.jsonl`

### ping / pong

```json
{ "t": "ping", "ts": 1730980020000 }   →   { "t": "pong", "ts": 1730980020000 }
```

## 4. MQTT 数据源（已实现，推荐路径）

现场 EMS/BMS 通常只出 MQTT，桥接服务已内置 MQTT 3.1.1 客户端（零依赖），
**采集侧只需按下面约定发报文，大屏即生效**——前端与桥接都不用改代码。

```bash
node server/bridge.js 9001 --mqtt mqtt://broker.emqx.io:1883 --topic 'ess/#'
# 私有 broker / 带鉴权：
node server/bridge.js 9001 --mqtt mqtt://10.0.0.5:1883 --topic 'plant/#' --user ems --pass '***'
```

### 4.1 主题约定（默认，可用 `--topic` 改通配）

| 主题 | 载荷 | 说明 |
|---|---|---|
| `ess/scada` | `{"stations":[{id,power,soc,soh,temp,status}]}` 或单站 `{id,power,soc}` | 1Hz 遥测，批量推荐 |
| `ess/alert` | `{id,lv,st,dev,text}` | 新告警即时进台账 |
| `ess/ops` | 桥接**发布**给 EMS：`{ts,by,action,ids,result}` | 处置回写（确认/闭环/撤销） |

### 4.2 载荷识别规则（宽松，MQTTX 手发 JSON 也能即刻见效）

桥接对 `--topic` 匹配到的每条消息依次尝试：

1. 含 `t` 字段且为协议帧类型（`scada`/`alert`/`alertState`/`history`/`cluster`）→ 直通或按帧处理
2. 含 `stations` 数组 → 批量指标
3. 含 `id` + 任一数值字段（`power`/`soc`/`soh`/`temp`）→ 单站指标（缺字段保留旧值）
4. 含 `id` + `lv`/`text` → 新告警

### 4.3 链路老化

某站 **>12s 无任何消息** → 桥接判定掉线（`comm:"offline"`、`power:0` 下发前端），不猜数。
恢复发包即自动回到在线，无需重启。

### 4.4 本地联调（无 EMS 时）

```bash
node server/bridge.js 9001 --mqtt mqtt://broker.emqx.io:1883 --topic 'ess/#'   # 终端 1
node server/mqtt-sim.js --prefix ess                                           # 终端 2：EMS 替身
# 浏览器 index.html?ws=live ； MQTTX 里可同时订阅 ess/# 围观原始流量
```

## 5. 接入清单（贵方后端视角）

1. 实现 WebSocket 端点，按 §2 节拍发帧（scada 1s、history 30s、alert 事件驱动）
2. 消费 §3 `op` 帧，落到工单/审计系统，并广播 `alertState`
3. 字段名、枚举值严格按上表（前端按白名单消费，多字段忽略、缺字段保留旧值）
4. 联调：`index.html?ws=ws://<网关>:<端口>/ws`，顶栏角标变绿色「实时」即链路通；
   或改 `assets/js/config.js` → `{ source:'ws', url:'…' }` 永久生效
