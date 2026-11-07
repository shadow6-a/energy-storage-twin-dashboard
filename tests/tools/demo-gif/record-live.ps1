# Record live-mode (MQTT driven) cover shot + 15s GIF frames.
# Precondition: bridge(9001, mqtt) + mqtt-sim running; static server on 8931.
# Usage: powershell -ExecutionPolicy Bypass -File tests/tools/demo-gif/record-live.ps1 [prefix]
param([string]$Prefix = '')
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path _gif | Out-Null
Remove-Item _gif\f*.png -ErrorAction SilentlyContinue
if (-not $Prefix) { $Prefix = (Get-Content server/_pfx.txt -ErrorAction SilentlyContinue) }
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
Set-Location $root
$script:n = 0
function Cap {
  $script:n++
  $f = "_gif\f{0:d3}.png" -f $script:n
  playwright-cli screenshot --filename="$root/$f" | Out-Null
  Start-Sleep -Milliseconds 250
}

playwright-cli close 2>$null | Out-Null
playwright-cli open "http://127.0.0.1:8931/index.html?ws=live" | Out-Null
playwright-cli resize 1920 1080 | Out-Null
Start-Sleep -Seconds 5

# cover: full-HD live shot (green badge + ticking data)
playwright-cli screenshot --filename="$root/assets/mockups/00-cover.png" | Out-Null

# 1) L0 overview, data ticking (4s)
1..8 | ForEach-Object { Cap }

# 2) MQTT alert pops into ledger (2s)
Start-Process cmd -ArgumentList "/c","node tests/tools/mqtt/publish-alert.js mqtt://broker.emqx.io:1883 $Prefix/alert > server/_pub.out 2>&1" -WindowStyle Hidden | Out-Null
Start-Sleep -Milliseconds 1200
1..4 | ForEach-Object { Cap }

# 3) locate -> drill down to cluster (3s)
playwright-cli eval "(() => { const b=document.querySelector('#alertList .al-row [data-act=locate]'); if (b) b.click(); return !!b; })()" | Out-Null
Start-Sleep -Milliseconds 800
1..6 | ForEach-Object { Cap }

# 4) ack the alert (3s)
playwright-cli eval "(() => { const b=document.querySelector('#alertList .al-row [data-act=ack]'); if (b) b.click(); return !!b; })()" | Out-Null
Start-Sleep -Milliseconds 900
1..6 | ForEach-Object { Cap }

# 5) back to L0, let it breathe (3s)
playwright-cli press Escape | Out-Null
Start-Sleep -Milliseconds 600
1..6 | ForEach-Object { Cap }

playwright-cli close 2>$null | Out-Null
Write-Host "frames=$script:n"
