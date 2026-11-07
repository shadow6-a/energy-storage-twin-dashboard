# Chaos E2E (v2.3): out-of-order stale frames + MQTT link flapping under load.
# Verifies: stale-frame guard, no value corruption, outbox queueing during flap,
# reconnect backoff cap, queue drain after recovery, no dead-letter storm.
# Usage: powershell -ExecutionPolicy Bypass -File tests/chaos_e2e.ps1
param(
  [string]$MqttUrl = 'mqtt://broker.emqx.io:1883',
  [int]$BridgePort = 9012,
  [int]$StaticPort = 8934
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path -Parent $PSScriptRoot)
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
function Get-M([string]$name, [string]$mx) {
  $m = $mx | Select-String ([regex]::Escape($name) + ' ([\-\d.]+)')
  if ($m) { return [double]$m.Matches[0].Groups[1].Value }
  return -1
}
function Metrics { (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$BridgePort/metrics").Content }

# --- services: sim with reorder chaos + bridge with link flapping (first drop at t=25s) ---
$Prefix = 'chaostest' + (Get-Random -Minimum 1000 -Maximum 9999)
$staticProc = $null
if (-not (Get-NetTCPConnection -LocalPort $StaticPort -State Listen -ErrorAction SilentlyContinue)) {
  $staticProc = Start-Process python -ArgumentList "-m","http.server","$StaticPort","--bind","127.0.0.1" -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
}
Start-Process cmd -ArgumentList "/c","node server/mqtt-sim.js --mqtt $MqttUrl --prefix $Prefix --chaos reorder > server/_chaos_sim.log 2>&1" -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 2
Start-Process cmd -ArgumentList "/c","node server/bridge.js $BridgePort --mqtt $MqttUrl --topic $Prefix/# --chaos-flap 25 > server/_chaos_bridge.log 2>&1 & echo BRIDGE-EXIT %ERRORLEVEL% >> server/_chaos_bridge.log" -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 5

# --- dashboard live ---
$wsParam = [uri]::EscapeDataString("ws://127.0.0.1:$BridgePort/ws")
playwright-cli close 2>$null | Out-Null
playwright-cli open "http://127.0.0.1:$StaticPort/index.html?ws=$wsParam" | Out-Null
$r = $null
foreach ($i in 1..15) {
  Start-Sleep -Seconds 1
  $r = Get-Json (playwright-cli eval "JSON.stringify({c:DataIO.status().connected})")
  if ($r.c -eq $true) { break }
}
Assert ($r.c -eq $true) "dashboard connected within ${i}s"

# --- wait through first chaos window: reorder injections (t>=12s) + flap drop (t=25s, 5s gap) ---
Write-Host "  running chaos timeline (~35s)..."
Start-Sleep -Seconds 31
$mx = Metrics
$stale = Get-M 'ess_mqtt_msgs_stale_total' $mx
Assert ($stale -ge 1) "out-of-order guard: $stale stale frames rejected (ess_mqtt_msgs_stale_total)"
$flaps = Get-M 'ess_chaos_flaps_total' $mx
Assert ($flaps -ge 1) "link flap fired ($flaps drops, ess_chaos_flaps_total)"
$depth = Get-M 'ess_ops_queue_depth' $mx
Assert ($depth -ge 0) "outbox alive during flap (queue_depth=$depth)"

# --- inject ops DURING the reconnect-suppression window: poll for the drop, then fire ---
$dropped = $false
foreach ($i in 1..40) {
  Start-Sleep -Seconds 1
  try { if ((Get-M 'ess_mqtt_connected' (Metrics)) -eq 0) { $dropped = $true; break } } catch { }
}
Assert ($dropped -eq $true) "observed link drop within ${i}s (--chaos-flap)"
$inj = Get-Json (playwright-cli eval "JSON.stringify({ok:(DataIO.send({t:'op',action:'ack',ids:['E001','E002'],by:'chaos-test'})!==false),rcpt:DataIO.status().mode})")
Assert ($inj.ok -eq $true) "op injected over WS during chaos window"
Start-Sleep -Seconds 2
$mx2 = Metrics
$depth2 = Get-M 'ess_ops_queue_depth' $mx2
Assert ($depth2 -ge 1 -and $depth2 -le 4) "outbox queueing observed: depth=$depth2 (bounded, no storm)"
Write-Host "  waiting for reconnect + queue drain..."
Start-Sleep -Seconds 12
$mx3 = Metrics
Assert ((Get-M 'ess_mqtt_connected' $mx3) -eq 1) "mqtt reconnected within backoff cap (30s)"
Assert ((Get-M 'ess_ops_queue_depth' $mx3) -eq 0) "outbox drained to 0 after recovery (final consistency)"
$age = Get-M 'ess_ui_last_data_age_seconds' $mx3
Assert ($age -ge 0 -and $age -lt 12) "UI data age $age s < 12s (stale gate never tripped by chaos)"
$dead = Get-M 'ess_ops_dead_total' $mx3
Assert ($dead -eq 0) "no dead letters after single flap (dead_total=$dead)"

# --- value sanity: S01 power always plausible despite stale-frame injection ---
$ok = $true
for ($k = 0; $k -lt 5; $k++) {
  $v = Get-Json (playwright-cli eval "JSON.stringify(DATA.STATIONS.filter(s=>s.id==='S01').map(s=>({p:s.power,ok:isFinite(s.power)&&Math.abs(s.power)<=300})))")
  if ($v[0].ok -ne $true) { $ok = $false }
  Start-Sleep -Milliseconds 700
}
Assert ($ok -eq $true) "S01 power stayed plausible across 5 samples (no stale overwrite)"

# --- ops.jsonl received the chaos-test op (at-least-once, audit first) ---
$ops = Get-Content server/data/ops.jsonl -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 6
$hit = ($ops | Select-String '"by":"chaos-test"').Count
Assert ($hit -ge 1) "ops.jsonl contains chaos-test op ($hit records)"

playwright-cli close 2>$null | Out-Null
if ($staticProc) { Stop-Process -Id $staticProc.Id -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Write-Host ""
Write-Host "[chaos-e2e] done, failed = $fail"
exit $fail
