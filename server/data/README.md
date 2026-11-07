# 桥接服务数据源（CSV 演示）

真实部署时把 `bridge.js` 里 `simulateStations()` 换成采集适配器（MQTT / Modbus / 数据库），
CSV 目录仅用于无后端联调。字段变更后保存即热加载（≤1s）。

## stations.csv

| 列 | 说明 | 示例 |
|---|---|---|
| id | 站点 ID（须与前端 data.js STATIONS 一致） | S01 |
| name | 站点名称 | 无锡锡山储能站 |
| mw | 额定功率 MW | 100 |
| cap | 容量 MWh | 200 |
| soc | 初始 SOC % | 62.4 |
| soh | 健康度 % | 95.8 |
| temp | 基准温度 ℃ | 29.4 |
| status | 初始状态 charging/discharging/standby | discharging |
| comm | online/offline | online |
| bias | 出力系数（默认 1） | 0.92 |

## alerts.csv

| 列 | 说明 |
|---|---|
| id | 告警 ID（A001…） |
| lv | crit / high / warn / info |
| st | 关联站点 ID |
| dev | 设备位（如 `2#电池舱 / 电池簇 C-07`） |
| text | 告警文案（推送时原样进台账） |

## ops.jsonl（处置回写落盘）

前端每次确认/闭环/撤销都会追加一行（真实部署改为转发 EMS 工单接口）：

```json
{"ts":"2026-11-07T10:20:30.000Z","by":"web","action":"close","ids":["A001"],"result":"ok"}
```
