$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path _gif | Out-Null
Remove-Item _gif\*.png -ErrorAction SilentlyContinue
$script:n = 0
function Cap([int]$ms = 800) {
  Start-Sleep -Milliseconds 250
  $script:n++
  $f = "_gif/f{0:d2}.png" -f $script:n
  playwright-cli screenshot --filename="$PWD/$f" | Out-Null
  $rest = $ms - 250
  if ($rest -gt 0) { Start-Sleep -Milliseconds $rest }
}

playwright-cli eval "localStorage.clear()" | Out-Null
playwright-cli reload | Out-Null
Start-Sleep -Milliseconds 2800
playwright-cli resize 1280 800 | Out-Null
Start-Sleep -Milliseconds 900

# 1) L0 区域总览（两帧驻留）
Cap 1100; Cap 1100
# 2) Space 暂停 / 恢复
playwright-cli press Space | Out-Null; Cap 900
playwright-cli press Space | Out-Null; Start-Sleep -Milliseconds 400
# 3) 告警定位 → 自动下钻到簇（C-07）
playwright-cli eval "document.querySelector('[data-act=locate]').click()" | Out-Null
Cap 900; Cap 1500; Cap 1500
# 4) 确认 → 闭环（状态机流转）
playwright-cli eval "document.querySelector('[data-act=ack]').click()" | Out-Null
Cap 1100
playwright-cli eval "document.querySelector('[data-act=close]').click()" | Out-Null
Cap 1100; Cap 900
# 5) 批量处置：勾 2 条 → 批量闭环
playwright-cli eval "document.getElementById('btnAlertBatch').click()" | Out-Null
Cap 900
playwright-cli eval "document.querySelectorAll('.al-row')[1].click()" | Out-Null
playwright-cli eval "document.querySelectorAll('.al-row')[2].click()" | Out-Null
Cap 900
playwright-cli eval "document.querySelector('[data-batch=close]').click()" | Out-Null
Cap 1100; Cap 900
# 6) Ctrl+Z 撤销
playwright-cli press Control+z | Out-Null
Cap 1100; Cap 900
# 7) A 审计抽屉（留痕）
playwright-cli press a | Out-Null
Cap 1200; Cap 1500; Cap 1200
playwright-cli press Escape | Out-Null; Start-Sleep -Milliseconds 500
# 8) C 驾驶舱模式
playwright-cli press c | Out-Null
Cap 1200; Cap 1500; Cap 1200
playwright-cli press c | Out-Null; Start-Sleep -Milliseconds 700
Cap 1100

echo "frames=$script:n"
