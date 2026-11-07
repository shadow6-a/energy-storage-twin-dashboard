# Soak test (v2.2): long-run memory/stability sampler.
# Starts bridge(csv demo, zero external deps) + static server + dashboard,
# samples every SAMPLE_SEC: JS heap, FPS, bridge RSS, event-loop lag, WS msg count.
# Writes tests/soak-latest.csv; exit 1 if heap grows > HEAP_GROWTH_LIMIT_MB.
#
# 24h unattended: powershell -ExecutionPolicy Bypass -File tests/soak.ps1 -Minutes 1440
# Quick check:    powershell -ExecutionPolicy Bypass -File tests/soak.ps1 -Minutes 10
param(
  [int]$Minutes = 10,
  [int]$SampleSec = 30,
  [double]$HeapGrowthLimitMb = 30,
  [int]$BridgePort = 9013,
  [int]$StaticPort = 8935
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path -Parent $PSScriptRoot)

# --- services: csv demo source (no broker dependency for a clean 24h run) ---
$staticProc = $null
if (-not (Get-NetTCPConnection -LocalPort $StaticPort -State Listen -ErrorAction SilentlyContinue)) {
  $staticProc = Start-Process python -ArgumentList "-m","http.server","$StaticPort","--bind","127.0.0.1" -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
}
Start-Process cmd -ArgumentList "/c","node server/bridge.js $BridgePort > server/_soak_bridge.log 2>&1" -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 3
$wsParam = [uri]::EscapeDataString("ws://127.0.0.1:$BridgePort/ws")
playwright-cli close 2>$null | Out-Null
playwright-cli open "http://127.0.0.1:$StaticPort/index.html?ws=$wsParam" | Out-Null
playwright-cli resize 1280 800 | Out-Null
Start-Sleep -Seconds 6

$csv = 'tests/soak-latest.csv'
"ts,minutes,ui_heap_mb,ui_fps,ui_lastdata_age,bridge_rss_mb,bridge_lag_ms,ws_msgs" | Out-File $csv -Encoding utf8
$firstHeap = $null; $bad = 0
$end = (Get-Date).AddMinutes($Minutes)
Write-Host "[soak] start, duration = $Minutes min, sample = ${SampleSec}s, heap limit = +$HeapGrowthLimitMb MB"
while ((Get-Date) -lt $end) {
  Start-Sleep -Seconds $SampleSec
  try {
    $s = playwright-cli eval "JSON.stringify({h:performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576*10)/10:0,f:Monitor?Monitor.snapshot().fps:0,d:DataIO.status().lastDataTs?(Date.now()-DataIO.status().lastDataTs)/1000:-1,m:DataIO.status().msgCount})"
    $idx = $s.IndexOf('### Result ')
    $seg = $s.Substring($idx + 10); $cut = $seg.IndexOf('### Ran Playwright')
    if ($cut -ge 0) { $seg = $seg.Substring(0, $cut) }
    $v = $seg.Trim().Trim('"').Replace('\"','"') | ConvertFrom-Json
    $mx = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$BridgePort/metrics").Content
    $rss = ($mx | Select-String 'ess_bridge_rss_mb ([\d.]+)').Matches[0].Groups[1].Value
    $lag = ($mx | Select-String 'ess_bridge_eventloop_lag_ms (\d+)').Matches[0].Groups[1].Value
    if ($null -eq $firstHeap) { $firstHeap = $v.h }
    $min = [math]::Round(((Get-Date) - (Get-Date $end).AddMinutes(-$Minutes)).TotalMinutes, 1)
    "$(Get-Date -Format 'HH:mm:ss'),$min,$($v.h),$($v.f),$([math]::Round($v.d,1)),$rss,$lag,$($v.m)" | Out-File $csv -Append -Encoding utf8
    Write-Host ("  t={0,6}m heap={1,7}MB fps={2,3} dataAge={3,5}s rss={4}MB lag={5}ms msgs={6}" -f $min, $v.h, $v.f, [math]::Round($v.d,1), $rss, $lag, $v.m)
    if ($v.d -gt 10 -or $v.f -lt 10) { $bad++; Write-Host "  WARN: stale data or fps drop" }
  } catch { Write-Host "  sample error: $($_.Exception.Message)"; $bad++ }
}
$growth = [math]::Round($v.h - $firstHeap, 1)
Write-Host ""
Write-Host "[soak] done: heap growth = $growth MB (limit +$HeapGrowthLimitMb), anomalies = $bad"
playwright-cli close 2>$null | Out-Null
if ($staticProc) { Stop-Process -Id $staticProc.Id -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
if ($growth -gt $HeapGrowthLimitMb -or $bad -gt [math]::Max(2, $Minutes)) { exit 1 }
exit 0
