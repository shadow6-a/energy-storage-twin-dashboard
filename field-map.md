# 字段映射表（Field Mapping）

> 用途：集成商后端开发**对照本表直接写推送/下发逻辑**，无需翻阅可行性长文。
> 约定：前端数据帧节拍 2.5s；下表「兜底值」指字段缺失 / 非法时前端表现（原型已内置，无需后端补齐）。

## 一、上行 · 站级遥测（EMS → 前端，2.5s 帧）

| 设备侧字段（示例） | 前端内部字段 | 类型 | 单位 | 刷新 | 异常兜底值 |
|---|---|---|---|---|---|
| `ems.station.soc` | `station.soc` | number | % | 2.5s | 保持上次值 + 数据过期标记 |
| `ems.station.soh` | `station.soh` | number | % | 5min | 保持上次值 |
| `ems.station.temp` | `station.temp` | number | ℃ | 2.5s | `--`（不渲染数值） |
| `ems.station.power` | `station.power` | number | MW（+放电/−充电） | 2.5s | `0.0` |
| `ems.station.cap` | `station.cap` | number | MWh | 配置态 | 站点配置默认值 |
| `ems.station.comm` | `station.comm`（`online`/`offline`） | enum | — | 心跳 5s | `offline`（灰阶 + 快照提示） |
| `ems.station.hasCrit/openAlerts` | `station.hasCrit / openAlerts` | bool/int | — | 2.5s | `false / 0`（信标不脉冲） |

## 二、上行 · 告警事件（EMS/BMS → 前端，事件推送，轮询兜底 5s）

| 设备侧字段（示例） | 前端内部字段 | 类型 | 单位 | 刷新 | 异常兜底值 |
|---|---|---|---|---|---|
| `alarm.id` | `alert.id` | string | — | 事件 | 自动生成 `Axxx` |
| `alarm.level`（`crit/high/warn/info`） | `alert.lv` + `lvName` | enum | — | 事件 | `info`（最低优先级，避免误报升级） |
| `alarm.text` | `alert.text` | string | — | 事件 | `（无描述）` |
| `alarm.device`（如 `2#电池舱 C-07`） | `alert.dev` | string | — | 事件 | `--`（定位按钮隐藏） |
| `alarm.stationId` | `alert.st` | string | — | 事件 | 不入台账，记入日志 |
| `alarm.status`（0未确认/1确认/2闭环/3抑制） | `alert.status` | int | — | 事件 | `0`（未确认） |
| `alarm.ts` | `alert.age`（分钟，前端换算时间列） | int | min | 事件 | `--` |

## 三、上行 · 计划 / 实际曲线（EMS → 前端）

| 设备侧字段（示例） | 前端内部字段 | 类型 | 单位 | 刷新 | 异常兜底值 |
|---|---|---|---|---|---|
| `ems.plan.curve[96]`（96 点 15min） | `planAt(h)`（插值取点） | number[] | MW | 计划 60s | 计划线止于最后有效点 |
| `pcs.activePower` | `buildSeries().actual` | number | MW | 2.5s | 实际线止于当前时刻 |
| `ems.plan.strategy`（`peak/freq/reserve`） | `state.strategy` | enum | — | 事件 | 保持当前策略不变 |

## 四、上行 · 舱 / 簇级明细（BMS → 前端，进入 L2/L3 视图时拉取，5s）

| 设备侧字段（示例） | 前端内部字段 | 类型 | 单位 | 刷新 | 异常兜底值 |
|---|---|---|---|---|---|
| `bms.cluster.soc` | `cluster.soc` | number | % | 5s | 保持上次值 |
| `bms.cluster.soh` | `cluster.soh` | number | % | 5min | `--` |
| `bms.cluster.maxTemp` | `cluster.temp` | number | ℃ | 5s | `--` |
| `bms.cluster.voltDiff` | `cluster.voltDiff` | int | mV | 5s | `--`（一致性条置灰） |
| `bms.cluster.current` | `cluster.current` | number | A | 5s | `0.0` |
| `bms.cluster.fault` | `cluster.status`（`ok/warn`） | enum | — | 5s | `ok` |

## 五、下行 · 前端 → EMS（需权限与审计，原型仅 UI 演示）

| 前端动作 | 下发字段（示例） | 类型 | 单位 | 频率 | 兜底策略 |
|---|---|---|---|---|---|
| 策略切换 | `ems.cmd.setStrategy = peak/freq/reserve` | enum | — | 按需 | 二次确认失败则不下发；超时 3s 提示重试 |
| 策略参数确认 | `ems.cmd.confirmPlan` | bool | — | 按需 | 同上 |
| AI 建议采纳 | `ems.cmd.adoptAdvice {adviceId}` | string | — | 按需 | AI 永不直接改策略，必须人工确认 |
| 告警确认 / 闭环 | `alarm.ack / alarm.close {alarmId}` | string | — | 按需 | 失败回滚本地状态并提示 |

## 六、链路级约定

- **帧节拍**：前端按 2.5s 消费一帧；推送端可合并发送，字段缺失即触发兜底
- **乱序**：带 `ts` 的字段按时间戳取最新（见 `risk-mitigation.md`）
- **重复告警**：同 `alarm.device + alarm.text` 5min 窗口内重复上送只更新 `age`，不新增条目（与 flow.html 合并分支一致）
- **断连**：WebSocket 关闭 / 3 帧未到 → 触发前端断连降级（冻结视图 + 断连水印），恢复后自动续帧
