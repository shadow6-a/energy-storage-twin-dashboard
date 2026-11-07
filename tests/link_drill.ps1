# Offline / air-gapped link drill (v2.3.1): pull the "network cable" and watch the UI.
# NO public broker, NO Docker: local CSV bridge + local static server + browser only.
# Verifies: WS live -> amber reconnect + local simulation fallback -> smooth recovery.
#
#   powershell -ExecutionPolicy Bypass -File tests/link_drill.ps1
#   powershell -ExecutionPolicy Bypass -File tests/link_drill.ps1 -Manual   # no playwright-cli: print checkpoints
param(
  [int]$BridgePort = 9014,
  [int]$StaticPort = 8936,
  [switch]$Manual
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path -Parent $PSScriptRoot)
$fail = 0
$liveWord = "$([char]0x5B9E)$([char]0x65F6)"        # 实时
$reconnectWord = "$([char]0x91CD)$([char]0x8FDE)"   # 重连
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
  else { $script:fail++; Write-Host ("  FAIL  " + $msg) }
}
function Stop-Port([int]$p) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

Stop-Port $BridgePort; Stop-Port $StaticPort
Start-Process cmd -ArgumentList "/c","node tests/tools/http-static.js $StaticPort > server/_drill_static.log 2>&1" -WindowStyle Hidden | Out-Null
Start-Process cmd -ArgumentList "/c","node server/bridge.js $BridgePort > server/_drill_bridge.log 2>&1" -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 3
$wsParam = [uri]::EscapeDataString("ws://127.0.0.1:$BridgePort/ws")
$url = "http://127.0.0.1:$StaticPort/index.html?ws=$wsParam"
if ($Manual -or -not (Get-Command playwright-cli -ErrorAction SilentlyContinue)) {
  Write-Host "[manual] open: $url"
  Write-Host "[manual] checkpoint 1: badge = real-time (green), station values ticking"
  Write-Host "[manual] checkpoint 2: kill the bridge on port $BridgePort -> badge = reconnect Ns (amber), values keep drifting (local simulation)"
  Write-Host "[manual] checkpoint 3: restart bridge -> badge back to real-time within backoff, scada frames take over"
  exit 0
}

playwright-cli close 2>$null | Out-Null
playwright-cli open $url | Out-Null
$live = $null
foreach ($i in 1..15) {
  Start-Sleep -Seconds 1
  $live = Get-Json (playwright-cli eval "JSON.stringify({c:DataIO.status().connected,m:DataIO.status().msgCount,b:document.getElementById('hdrSrc').textContent})")
  if ($live.c -eq $true) { break }
}
Assert ($live.c -eq $true) "live WS connected within ${i}s"
Assert ($live.b -eq $liveWord) "badge = real-time"
$msgBefore = $live.m

# --- pull the cable: kill the bridge process (browser WS drops) ---
Stop-Port $BridgePort
Write-Host "  INJECT  bridge killed (simulated cable pull)"
Start-Sleep -Seconds 3
$down = Get-Json (playwright-cli eval "JSON.stringify({c:DataIO.status().connected,b:document.getElementById('hdrSrc').textContent,soc:DATA.STATIONS.find(s=>s.id==='S01').soc})")
Assert ($down.c -eq $false) "WS marked disconnected"
Assert ($down.b -like "*$reconnectWord*") "badge switched to reconnect (amber)"
Start-Sleep -Seconds 4
$down2 = Get-Json (playwright-cli eval "DATA.STATIONS.find(s=>s.id==='S01').soc")
Assert ([math]::Abs($down2 - $down.soc) -gt 0.0001) "local simulation keeps values drifting during outage (no frozen/stale UI)"

# --- plug the cable back: bridge restarts, exponential backoff reconnects ---
Start-Process cmd -ArgumentList "/c","node server/bridge.js $BridgePort >> server/_drill_bridge.log 2>&1" -WindowStyle Hidden | Out-Null
$up = $null
foreach ($i in 1..20) {
  Start-Sleep -Seconds 1
  $up = Get-Json (playwright-cli eval "JSON.stringify({c:DataIO.status().connected,m:DataIO.status().msgCount,b:document.getElementById('hdrSrc').textContent,rc:DataIO.status().reconnects,u:DataIO.status().url})")
  if ($up.c -eq $true) { break }
}
Assert ($up.c -eq $true) "reconnected within ${i}s (backoff <= 30s)"
Assert ($up.b -eq $liveWord) "badge back to real-time (smooth transition)"
Assert ($up.m -gt $msgBefore) "scada frames resumed (msgCount $msgBefore -> $($up.m))"
Assert ($up.rc -ge 1) "reconnect counter recorded ($($up.rc), visible in /metrics)"
Assert ($up.u -eq "ws://127.0.0.1:$BridgePort/ws") "reconnect kept the actual URL ($($up.u)), did not fall back to cfg default"

playwright-cli close 2>$null | Out-Null
Stop-Port $BridgePort; Stop-Port $StaticPort
Write-Host ""
Write-Host "[link-drill] done, failed = $fail"
exit $fail
