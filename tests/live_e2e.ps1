# ============================================================
# Live link E2E test (v2.0): bridge -> browser -> writeback
# Usage: powershell -ExecutionPolicy Bypass -File tests/live_e2e.ps1
# Precondition: static server on :8931 (python -m http.server 8931)
# NOTE: ASCII only on purpose - PowerShell 5.1 encoding pitfalls.
# ============================================================
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # playwright-cli outputs UTF-8
$fail = 0
function Get-Json([string]$out) {
  $idx = $out.IndexOf('### Result ')
  if ($idx -lt 0) { throw "eval no return: $out" }
  $seg = $out.Substring($idx + 10)
  $cut = $seg.IndexOf('### Ran Playwright')
  if ($cut -ge 0) { $seg = $seg.Substring(0, $cut) }        # detached mode: no newline before trailer
  $v = $seg.Trim()
  if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) -replace '\\"', '"' }
  try { $o = $v | ConvertFrom-Json } catch { $o = $v }
  return $o
}
function Assert($cond, $msg) {
  if ($cond) { Write-Host ("  PASS  " + $msg) }
  else { $script:fail++; Write-Host ("  FAIL  " + $msg); exit 1 }
}

# --- start own static server (isolated port, immune to outer command cleanup) ---
$staticPort = 8932
$staticProc = $null
if (-not (Get-NetTCPConnection -LocalPort $staticPort -State Listen -ErrorAction SilentlyContinue)) {
  $staticProc = Start-Process python -ArgumentList "-m","http.server","$staticPort","--bind","127.0.0.1" -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
}
$base = "http://127.0.0.1:$staticPort"

# --- start bridge (idempotent) ---
$listening = Get-NetTCPConnection -LocalPort 9001 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  $null = Start-Process node -ArgumentList "server/bridge.js" -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
  Write-Host "[e2e] bridge started"
} else {
  Write-Host "[e2e] bridge already running, reuse"
}
$health = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9001/health).Content
Assert ($health -match '"ok":true') "bridge /health"

# --- browser connect (poll up to 15s for ws handshake) ---
playwright-cli open "$base/index.html?ws=live" | Out-Null
$r = $null
foreach ($i in 1..15) {
  Start-Sleep -Seconds 1
  $r = Get-Json (playwright-cli eval "JSON.stringify({badge:document.getElementById('hdrSrc').textContent, mode:DataIO.status().mode, connected:DataIO.status().connected})")
  if ($r.mode -eq 'ws' -and $r.connected -eq $true) { break }
}
Write-Host ("  DEBUG last=" + ($r | ConvertTo-Json -Compress))
Assert ($r.mode -eq 'ws' -and $r.connected -eq $true) "websocket connected (mode=ws) within ${i}s"
$liveCn = "$([char]0x5B9E)$([char]0x65F6)"
Assert ($r.badge -eq $liveCn) "topbar badge = live"

# --- per-second data flow ---
$s1 = Get-Json (playwright-cli eval "JSON.stringify(DATA.STATIONS.map(s=>s.power))")
Start-Sleep -Seconds 3
$s2 = Get-Json (playwright-cli eval "JSON.stringify(DATA.STATIONS.map(s=>s.power))")
$changed = 0
for ($i = 0; $i -lt $s1.Count; $i++) { if ($s1[$i] -ne $s2[$i]) { $changed++ } }
Assert ($changed -ge 2) "per-second push flowing ($changed/8 stations changed in 3s)"
$r6 = Get-Json (playwright-cli eval "DATA.stationById('S06').power")
Assert ($r6 -eq 0) "offline station (S06) forced to 0 MW"

# --- history frame ---
$h = Get-Json (playwright-cli eval "JSON.stringify(DataIO.historyFor('S01') ? {n:DataIO.historyFor('S01').plan.length, live:DataIO.historyFor('S01').live} : null)")
Assert ($h -and $h.n -eq 96 -and $h.live) "history 24h frame took over main chart (96 pts)"

# --- writeback to ops.jsonl ---
Remove-Item server/data/ops.jsonl -ErrorAction SilentlyContinue
playwright-cli eval "(() => { const b = document.querySelector('.al-act[data-act=ack]'); if (b) b.click(); return !!b; })()" | Out-Null
Start-Sleep -Milliseconds 1200
$ops = Get-Content server/data/ops.jsonl -Encoding UTF8 -ErrorAction SilentlyContinue
Assert ($ops -match '"action":"ack"') "writeback landed in ops.jsonl (ack)"

# --- disconnect degrade + auto reconnect ---
$pid9001 = (Get-NetTCPConnection -LocalPort 9001 -State Listen | Select-Object -First 1).OwningProcess
Stop-Process -Id $pid9001 -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 4
$badge = Get-Json (playwright-cli eval "document.getElementById('hdrSrc').textContent + '|' + document.getElementById('hdrSrc').className")
Assert ($badge -match 'warn') "disconnect degrade: badge switched to retry state"
$null = Start-Process node -ArgumentList "server/bridge.js" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 14
$ok = Get-Json (playwright-cli eval "document.getElementById('hdrSrc').textContent + '|' + DataIO.status().connected")
Assert ($ok -match 'true') "auto reconnect restored live link"

playwright-cli close 2>$null | Out-Null
if ($staticProc) { Stop-Process -Id $staticProc.Id -Force -ErrorAction SilentlyContinue }
Write-Host ""
Write-Host "[e2e] done, failed = $fail"
exit $fail
