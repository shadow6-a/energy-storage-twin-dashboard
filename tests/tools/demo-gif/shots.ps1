$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path assets/img/shots | Out-Null
$dir = 'assets/img/shots'

function Shot([string]$name) {
  Start-Sleep -Milliseconds 400
  playwright-cli screenshot --filename="e:/UI/$dir/$name.png" | Out-Null
}

playwright-cli eval "localStorage.clear()" | Out-Null
playwright-cli reload | Out-Null
Start-Sleep -Milliseconds 2800
playwright-cli resize 1920 1080 | Out-Null
Start-Sleep -Milliseconds 1000
Shot 'l0-overview'

# 下钻到簇
playwright-cli eval "document.querySelector('[data-act=locate]').click()" | Out-Null
Start-Sleep -Milliseconds 2600
Shot 'l3-cluster'

# 回到 L0，批量处置态
playwright-cli eval "(() => { const b=document.getElementById('btnDrillUp'); if(b) b.click(); })()" | Out-Null
Start-Sleep -Milliseconds 1200
playwright-cli eval "document.getElementById('btnAlertBatch').click()" | Out-Null
Start-Sleep -Milliseconds 500
playwright-cli eval "document.querySelectorAll('#alertList .al-row')[1].click()" | Out-Null
playwright-cli eval "document.querySelectorAll('#alertList .al-row')[2].click()" | Out-Null
Start-Sleep -Milliseconds 500
Shot 'batch-mode'

# 审计抽屉
playwright-cli press a | Out-Null
Start-Sleep -Milliseconds 900
Shot 'audit-drawer'
playwright-cli press Escape | Out-Null; Start-Sleep -Milliseconds 500

# 驾驶舱
playwright-cli press c | Out-Null
Start-Sleep -Milliseconds 1100
Shot 'cockpit'
playwright-cli press c | Out-Null; Start-Sleep -Milliseconds 800

# 文档页（L0 视口即可）
playwright-cli open "http://127.0.0.1:8931/mockups.html" | Out-Null
Start-Sleep -Milliseconds 2400
Shot 'doc-mockups'

echo "shots done"
