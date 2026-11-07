# ============================================================
# MQTT end-to-end test (v2.1): broker -> bridge -> dashboard -> writeback
# Usage: powershell -ExecutionPolicy Bypass -File tests/mqtt_e2e.ps1
# Needs: public broker reachable (default broker.emqx.io:1883)
# ASCII only: PowerShell 5.1 encoding pitfalls.
# ============================================================
param(
  [string]$MqttUrl = 'mqtt://broker.emqx.io:1883',
  [string]$Prefix  = '',   # empty = random per-run prefix, isolates public broker noise
  [int]$BridgePort = 9011,
  [int]$StaticPort = 8933
)
if (-not $Prefix) { $Prefix = 'esstest' + (Get-Random -Minimum 1000 -Maximum 9999) }
$Topic = "$Prefix/#"
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path -Parent $PSScriptRoot)   # 锚定仓库根，相对路径才稳
$fail = 0
function Get-Json([string]$out) {
  $idx = $out.IndexOf('### Result ')
  if ($idx -lt 0) { throw "eval no return: $out" }
  $seg = $out.Substring($idx + 10)
  $cut = $seg.IndexOf('### Ran Playwright')
  if ($cut -ge 0) { $seg = $seg.Substring(0, $cut) }
  $v = $seg.Trim()
  if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) -replace '\\"', '"' }
  try { $o = $v | ConvertFrom-Json } catch { $o = $v }
  return $o
}
function Assert($cond, $msg) {
  if ($cond) { Write-Host ("  PASS  " + $msg) }
  else { $script:fail++; Write-Host ("  FAIL  " + $msg); exit 1 }
}

# --- static server (self-contained) ---
$staticProc = $null
if (-not (Get-NetTCPConnection -LocalPort $StaticPort -State Listen -ErrorAction SilentlyContinue)) {
  $staticProc = Start-Process python -ArgumentList "-m","http.server","$StaticPort","--bind","127.0.0.1" -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
}
$base = "http://127.0.0.1:$StaticPort"

# --- bridge in MQTT mode (always fresh: stale instance would silently serve old data) ---
Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
$bArg = "node server/bridge.js $BridgePort --mqtt $MqttUrl --topic $Topic > server/_mqtt_e2e_bridge.log 2>&1"
Start-Process cmd -ArgumentList "/c","$bArg" -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 4
$h = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$BridgePort/health").Content | ConvertFrom-Json
Assert ($h.ok -eq $true -and $h.source -eq 'mqtt') "bridge health ok, source=mqtt"

# --- MQTT simulator (EMS stand-in) ---
$simArg = "node server/mqtt-sim.js --mqtt $MqttUrl --prefix $Prefix > server/_mqtt_e2e_sim.log 2>&1"
$simProc = Start-Process cmd -ArgumentList "/c","$simArg" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 5

$h2 = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$BridgePort/health").Content | ConvertFrom-Json
Assert ($h2.mqtt -eq 'connected') "bridge subscribed to broker (mqtt=connected)"
Assert ($h2.mqttMsgs -ge 2) "broker messages ingested ($($h2.mqttMsgs) msgs)"

# --- dashboard connect (explicit bridge port; ?ws=live would hit config.js default :9001) ---
$wsParam = [uri]::EscapeDataString("ws://127.0.0.1:$BridgePort/ws")
playwright-cli open "$base/index.html?ws=$wsParam" | Out-Null
$r = $null
foreach ($i in 1..15) {
  Start-Sleep -Seconds 1
  $r = Get-Json (playwright-cli eval "JSON.stringify({badge:document.getElementById('hdrSrc').textContent, mode:DataIO.status().mode, connected:DataIO.status().connected})")
  if ($r.mode -eq 'ws' -and $r.connected -eq $true) { break }
}
Assert ($r.mode -eq 'ws' -and $r.connected -eq $true) "dashboard ws connected within ${i}s"
Assert ($r.badge -eq "$([char]0x5B9E)$([char]0x65F6)") "topbar badge = live"

# --- live values driven by MQTT (not local simulation) ---
$s1 = Get-Json (playwright-cli eval "JSON.stringify(DATA.STATIONS.map(s=>s.power))")
Start-Sleep -Seconds 3
$s2 = Get-Json (playwright-cli eval "JSON.stringify(DATA.STATIONS.map(s=>s.power))")
$changed = 0
for ($i = 0; $i -lt $s1.Count; $i++) { if ($s1[$i] -ne $s2[$i]) { $changed++ } }
Assert ($changed -ge 2) "MQTT-driven values changing ($changed/8 in 3s)"
$r6 = Get-Json (playwright-cli eval "DATA.stationById('S06').status")
Assert ($r6 -eq 'offline') "station S06 marked offline by bridge (comm gate)"

# --- alert via MQTT reaches the ledger ---
Start-Process cmd -ArgumentList "/c","node tests/tools/mqtt/publish-alert.js $MqttUrl $Prefix/alert > server/_pub.out 2>&1" -WindowStyle Hidden | Out-Null
$has = $false
foreach ($i in 1..10) {
  Start-Sleep -Milliseconds 800
  $has = Get-Json (playwright-cli eval "(document.getElementById('alertList').textContent.indexOf('340mV') >= 0)")
  if ($has -eq $true) { break }
}
Assert ($has -eq $true) "MQTT alert visible in alert ledger within ${i}x0.8s"

# --- writeback: ack -> ops.jsonl + <prefix>/ops ---
Remove-Item server/_probe.log -ErrorAction SilentlyContinue
Start-Process cmd -ArgumentList "/c","node tests/tools/mqtt/watch-ops.js $MqttUrl $Prefix/ops 12 > server/_probe.out 2>&1" -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 2
playwright-cli eval "(() => { const b=document.querySelector('#alertList .al-act[data-act=ack]'); if (b) b.click(); return !!b; })()" | Out-Null
Start-Sleep -Seconds 3
$ops = Get-Content server/data/ops.jsonl -Encoding UTF8 -ErrorAction SilentlyContinue
Assert ($ops -match '"action":"ack"') "writeback landed in ops.jsonl"
$mq = Get-Content server/_probe.log -Encoding UTF8 -ErrorAction SilentlyContinue
Assert ($mq -match '/ops' -and $mq -match '"action":"ack"') "writeback published to MQTT $Prefix/ops"

playwright-cli close 2>$null | Out-Null
Stop-Process -Id $simProc.Id -Force -ErrorAction SilentlyContinue
if ($staticProc) { Stop-Process -Id $staticProc.Id -Force -ErrorAction SilentlyContinue }
Write-Host ""
Write-Host "[mqtt-e2e] done, failed = $fail"
exit $fail
