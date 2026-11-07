# Fault-injection test (v2.2): source kill -> stale offline -> recovery -> metrics visible.
# Usage: powershell -ExecutionPolicy Bypass -File tests/fault_inject.ps1
param(
  [string]$MqttUrl = 'mqtt://broker.emqx.io:1883',
  [int]$BridgePort = 9012,
  [int]$StaticPort = 8934
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path -Parent $PSScriptRoot)
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

# --- services ---
$Prefix = 'faulttest' + (Get-Random -Minimum 1000 -Maximum 9999)
$staticProc = $null
if (-not (Get-NetTCPConnection -LocalPort $StaticPort -State Listen -ErrorAction SilentlyContinue)) {
  $staticProc = Start-Process python -ArgumentList "-m","http.server","$StaticPort","--bind","127.0.0.1" -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
}
$simProc = Start-Process cmd -ArgumentList "/c","node server/mqtt-sim.js --mqtt $MqttUrl --prefix $Prefix > server/_fi_sim.log 2>&1" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
Start-Process cmd -ArgumentList "/c","node server/bridge.js $BridgePort --mqtt $MqttUrl --topic $Prefix/# > server/_fi_bridge.log 2>&1" -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 5

# --- metrics baseline (wait for MQTT handshake, public broker RTT varies) ---
$mx = $null
foreach ($i in 1..20) {
  Start-Sleep -Seconds 1
  try { $mx = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$BridgePort/metrics").Content } catch { continue }
  if ($mx -match 'ess_mqtt_connected 1') { break }
}
Assert ($mx -match 'ess_mqtt_msgs_total') "/metrics exposes ess_mqtt_msgs_total"
Assert ($mx -match 'ess_mqtt_connected 1') "ess_mqtt_connected = 1 (within ${i}s)"
$rate0 = ($mx | Select-String 'ess_mqtt_msgs_rate ([\d.]+)').Matches[0].Groups[1].Value
Assert ([double]$rate0 -gt 0) "message rate > 0 ($rate0/s)"

# --- dashboard live ---
$wsParam = [uri]::EscapeDataString("ws://127.0.0.1:$BridgePort/ws")
playwright-cli close 2>$null | Out-Null
playwright-cli open "http://127.0.0.1:$StaticPort/index.html?ws=$wsParam" | Out-Null
$r = $null
foreach ($i in 1..15) {
  Start-Sleep -Seconds 1
  $r = Get-Json (playwright-cli eval "JSON.stringify({connected:DataIO.status().connected})")
  if ($r.connected -eq $true) { break }
}
Assert ($r.connected -eq $true) "dashboard connected within ${i}s"

# --- fault: kill the data source (sim) ---
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "mqtt-sim.*$Prefix" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "  INJECT kill sim ($Prefix)"
Start-Sleep -Seconds 14
$off = Get-Json (playwright-cli eval "DATA.STATIONS.filter(s=>s.comm==='online').length")
Assert ($off -eq 0) "stale gate: all stations offline 12s after source kill"
# /health source-dead threshold is 30s (per-station gate is 12s); wait it out
Start-Sleep -Seconds 20
try { $h = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$BridgePort/health").Content | ConvertFrom-Json }
catch {
  # degraded health returns 503 on purpose - read the body from the exception
  $resp = $_.Exception.Response
  $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
  $h = $body | ConvertFrom-Json
}
Assert ($h.reasons.Count -ge 1) "health degrades with reasons ($($h.reasons -join ','))"
$mx2 = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$BridgePort/metrics").Content
$onl = ($mx2 | Select-String 'ess_stations_online (\d+)').Matches[0].Groups[1].Value
Assert ([int]$onl -eq 0) "/metrics ess_stations_online = 0 during outage"

# --- recovery: restart sim, stations must come back ---
Start-Process cmd -ArgumentList "/c","node server/mqtt-sim.js --mqtt $MqttUrl --prefix $Prefix >> server/_fi_sim.log 2>&1" -WindowStyle Hidden | Out-Null
$rec = 0
foreach ($i in 1..20) {
  Start-Sleep -Seconds 1
  $rec = Get-Json (playwright-cli eval "DATA.STATIONS.filter(s=>s.comm==='online').length")
  if ([int]$rec -ge 7) { break }
}
Assert ([int]$rec -ge 7) "recovery: >=7 stations back online within ${i}s (S06 stays offline by design)"

# --- frontend telemetry visible in /metrics ---
$mx3 = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$BridgePort/metrics").Content
Assert ($mx3 -match 'ess_ui_fps (\d+)') "/metrics exposes ess_ui_fps"
$fps = ($mx3 | Select-String 'ess_ui_fps (\d+)').Matches[0].Groups[1].Value
Assert ([int]$fps -ge 30) "frontend FPS reported and >= 30 ($fps)"

playwright-cli close 2>$null | Out-Null
Stop-Process -Id $simProc.Id -Force -ErrorAction SilentlyContinue
if ($staticProc) { Stop-Process -Id $staticProc.Id -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Write-Host ""
Write-Host "[fault-inject] done, failed = $fail"
exit $fail
