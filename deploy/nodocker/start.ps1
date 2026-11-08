# Zero-Docker observability stack: bridge + collector + offline dashboard.
# Usage: powershell -ExecutionPolicy Bypass -File deploy/nodocker/start.ps1
#        powershell -ExecutionPolicy Bypass -File deploy/nodocker/start.ps1 -BridgePort 9001 -WebPort 9099 -IntervalSec 5 -NoBrowser
param(
  [int]$BridgePort = 9001,
  [int]$WebPort = 9099,
  [int]$IntervalSec = 5,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js not found (only Node is required, no Docker)' }

$bridgeUp = Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue
if (-not $bridgeUp) {
  Write-Host "[start] no bridge on $BridgePort -> starting CSV demo bridge"
  Start-Process cmd -ArgumentList "/c","node server/bridge.js $BridgePort > server/_nodocker_bridge.log 2>&1" -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 3
}

$webUp = Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue
if (-not $webUp) {
  Start-Process cmd -ArgumentList "/c","node deploy/nodocker/collector.js --bridge http://127.0.0.1:$BridgePort --web $WebPort --interval $IntervalSec > deploy/nodocker/_collector.log 2>&1" -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
} else {
  Write-Host "[start] collector already listening on $WebPort (reusing)"
}

# A dashboard tab must stay open: monitor.js pushes fps/heap/reconnects into /metrics over WS.
if (-not (Get-NetTCPConnection -LocalPort 8931 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process cmd -ArgumentList "/c","node tests/tools/http-static.js 8931 > server/_nodocker_static.log 2>&1" -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
}
$ui = "http://127.0.0.1:8931/index.html?ws=live"
$url = "http://127.0.0.1:$WebPort/"
if (-not $NoBrowser) { Start-Process $ui; Start-Sleep -Seconds 2; Start-Process $url }
Write-Host ""
Write-Host "[start] dashboard : $url"
Write-Host "[start] big screen: $ui  (keep this tab open for UI telemetry)"
Write-Host "[start] api       : ${url}api/series"
Write-Host "[start] history   : deploy/nodocker/metrics-history.csv"
Write-Host "[start] alerts    : deploy/nodocker/alerts.log"
Write-Host "[start] stop      : Get-NetTCPConnection -LocalPort $WebPort -State Listen | % { Stop-Process -Id `$_.OwningProcess -Force }"
