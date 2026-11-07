# Soak test (v2.2): long-run stability sampler - ZERO playwright dependency.
# UI telemetry (fps/heap/reconnects/data-age) is pushed by the dashboard itself
# over WS (assets/js/monitor.js) and exposed on /metrics - so we just poll there.
# The dashboard opens in the system default browser (real 72h unattended shape).
#
# 24h: powershell -ExecutionPolicy Bypass -File tests/soak.ps1 -Minutes 1440
# Quick: powershell -ExecutionPolicy Bypass -File tests/soak.ps1 -Minutes 5 -SampleSec 15
param(
  [int]$Minutes = 10,
  [int]$SampleSec = 30,
  [double]$HeapGrowthLimitMb = 30,
  [int]$BridgePort = 9013
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path -Parent $PSScriptRoot)

Start-Process cmd -ArgumentList "/c","node server/bridge.js $BridgePort > server/_soak_bridge.log 2>&1 & echo BRIDGE-EXIT %ERRORLEVEL% at %DATE% %TIME% >> server/_soak_bridge.log" -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 3
# open dashboard straight from bridge port (bridge serves nothing but ws/health, so use a static server)
if (-not (Get-NetTCPConnection -LocalPort 8931 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process python -ArgumentList "-m","http.server","8931","--bind","127.0.0.1" -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
}
Start-Process "http://127.0.0.1:8931/index.html?ws=$(('ws://127.0.0.1:' + $BridgePort + '/ws') -replace ':','%3A')"

$csv = 'tests/soak-latest.csv'
"ts,minutes,ui_heap_mb,ui_fps,ui_reconnects,ui_lastdata_age,bridge_rss_mb,bridge_lag_ms,ws_clients" | Out-File $csv -Encoding utf8
$firstHeap = $null; $lastHeap = 0; $bad = 0
$end = (Get-Date).AddMinutes($Minutes)
Write-Host "[soak] start, duration = $Minutes min, sample = ${SampleSec}s, heap limit = +$HeapGrowthLimitMb MB"
Write-Host "[soak] keep the dashboard browser tab open - it pushes fps/heap/age to /metrics every 10s"
function Get-M([string]$name, [string]$mx) {
  $m = $mx | Select-String ([regex]::Escape($name) + ' ([\-\d.]+)')
  if ($m) { return [double]$m.Matches[0].Groups[1].Value }
  return $null
}
while ((Get-Date) -lt $end) {
  Start-Sleep -Seconds $SampleSec
  try {
    $mx = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$BridgePort/metrics").Content
    $h = Get-M 'ess_ui_heap_mb' $mx
    $f = Get-M 'ess_ui_fps' $mx
    $rc = Get-M 'ess_ui_reconnects' $mx
    $age = Get-M 'ess_ui_last_data_age_seconds' $mx
    $rss = Get-M 'ess_bridge_rss_mb' $mx
    $lag = Get-M 'ess_bridge_eventloop_lag_ms' $mx
    $cl = Get-M 'ess_ws_clients' $mx
    if ($null -eq $h) { Write-Host "  WARN: no UI telemetry yet (browser closed?)"; $bad++; continue }
    if ($null -eq $firstHeap) { $firstHeap = $h }
    $lastHeap = $h
    $min = [math]::Round($Minutes - (($end - (Get-Date)).TotalMinutes), 1)
    "$(Get-Date -Format 'HH:mm:ss'),$min,$h,$f,$rc,$age,$rss,$lag,$cl" | Out-File $csv -Append -Encoding utf8
    Write-Host ("  t={0,6}m heap={1,7}MB fps={2,3} rc={3} age={4,4}s rss={5}MB lag={6}ms clients={7}" -f $min, $h, $f, $rc, $age, $rss, $lag, $cl)
    if ($age -gt 10 -or ($f -ne 0 -and $f -lt 10)) { $bad++; Write-Host "  WARN: stale data or fps drop" }
  } catch { Write-Host "  sample error: $($_.Exception.Message)"; $bad++ }
}
$growth = [math]::Round($lastHeap - $firstHeap, 1)
Write-Host ""
Write-Host "[soak] done: ui heap growth = $growth MB (limit +$HeapGrowthLimitMb), anomalies = $bad, see $csv"
Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
if ($growth -gt $HeapGrowthLimitMb -or $bad -gt [math]::Max(2, $Minutes)) { exit 1 }
exit 0
