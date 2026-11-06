# ============================================================
# 大屏五视口回归脚本（v0.9.6 固化）
# 用法: powershell -ExecutionPolicy Bypass -File tests/regression.ps1
# 依赖: playwright-cli（IDE 内置）、python http.server
# 断言: 1) 五视口无横向溢出、无页面滚动  2) 关键字号符合档位  3) 0 console error
# 改版 CSS/布局后先跑本脚本，全部 PASS 再交付。
# ============================================================
param([int]$Port = 8790)
$ErrorActionPreference = 'Stop'
$fail = 0

function Assert([bool]$cond, [string]$msg, [string]$detail = '') {
  $script:totalAsserts++
  if ($cond) { Write-Host "  PASS  $msg" -ForegroundColor Green }
  else {
    Write-Host "  FAIL  $msg" -ForegroundColor Red
    if ($detail) { Write-Host "        ↳ $detail" -ForegroundColor Yellow }
    $script:fail++
    $script:failInView = $true
  }
}
# 从 playwright-cli 输出中提取 eval 返回的 JSON（### Result "..." 行）
function Get-Json([string]$out) {
  $m = [regex]::Match($out, '### Result "(.*)"')
  if (-not $m.Success) { throw "eval 无返回: $out" }
  return ($m.Groups[1].Value -replace '\\"', '"')
}

Write-Host "== 启动本地服务 :$Port =="
Start-Process -WindowStyle Hidden python -ArgumentList '-m', 'http.server', "$Port"
Start-Sleep 1

try {
  playwright-cli open "http://127.0.0.1:$Port/index.html" | Out-Null
  $viewports = @(
    @{ w = 1024; h = 768;  minAlertFs = 14; expLeft = 230; expRow = 34 },
    @{ w = 1280; h = 720;  minAlertFs = 14; expLeft = 230; expRow = 34 },
    @{ w = 1920; h = 1080; minAlertFs = 14; expLeft = 260; expRow = 75 },
    @{ w = 2560; h = 1440; minAlertFs = 19; expLeft = 260; expRow = 94 },
    @{ w = 3840; h = 1080; minAlertFs = 21; expLeft = 260; expRow = 101 }
  )
  $errTotal = 0
  New-Item -ItemType Directory -Force -Path "$PSScriptRoot/artifacts" | Out-Null
  foreach ($vp in $viewports) {
    Write-Host "== $($vp.w)x$($vp.h) =="
    $script:failInView = $false
    # 视口独立状态：清掉驾驶舱/密度等 localStorage 记忆（v1.2），保证期望表前提成立
    playwright-cli eval "localStorage.clear()" | Out-Null
    playwright-cli reload | Out-Null
    playwright-cli resize $vp.w $vp.h | Out-Null
    Start-Sleep -Milliseconds 900
    $j = Get-Json (playwright-cli eval "(() => { const canScroll = () => { const y = scrollY; scrollTo(0, 9e5); const m = scrollY > 0; scrollTo(0, y); return m; }; const lis = [...document.querySelectorAll('#alertList [role=listitem]')]; return JSON.stringify({ overflowX: document.documentElement.scrollWidth > innerWidth, scrollY: canScroll(), alertFs: parseFloat(getComputedStyle(document.querySelector('.al-txt')).fontSize), chipH: document.querySelector('#alertFilters .chip').offsetHeight, rows: document.querySelectorAll('#alertList .al-row').length, leftColW: Math.round(document.querySelector('.col-left').getBoundingClientRect().width * 10) / 10, alRowH: Math.round(document.querySelector('.al-row').getBoundingClientRect().height), liCount: lis.length, ariaOk: lis.filter(l => /^[^，]+告警，[^，]+，.+/.test(l.getAttribute('aria-label') || '')).length }); })()")
    $o = $j | ConvertFrom-Json
    Assert (-not $o.overflowX) "无横向溢出" "实际 scrollWidth 大于视口——嫌疑：.app overflow:hidden 被移除、或某元素超出流式网格（用 .playwright-cli 截图排查溢出源）"
    Assert (-not $o.scrollY)   "无页面滚动（含标注层缩放溢出）" "实际可纵向滚动——嫌疑：.anno-layer 缩放溢出未被裁剪（.app{overflow:hidden} 是否还在？）"
    Assert ($o.alertFs -ge $vp.minAlertFs) "告警字号 $($o.alertFs)px >= 档位 $($vp.minAlertFs)px" "嫌疑：字号令牌或 2K+/窄端覆盖层被改动（tokens.css --fs-* / dashboard.css 断点块）"
    Assert ($o.chipH -ge 22)   "筛选 chip 高度 $($o.chipH)px 可点" "嫌疑：chip 高度断点规则未生效（命中了错误断点，参考 benchmark 期望表）"
    Assert ($o.rows -ge 1)     "告警列表渲染 $($o.rows) 行" "嫌疑：renderAlerts 未执行或告警筛选态异常"
    Assert ($o.liCount -eq $o.rows -and $o.ariaOk -eq $o.rows) "ARIA 角色断言：$($o.ariaOk)/$($o.liCount) 个 listitem 携带完整 aria-label（等级+状态+全文）" "嫌疑：al-row 模板 role/aria-label 被移除（app.js renderAlerts）"
    # 断点归属断言（v0.9.8）：防「以为生效、实际命中的是另一断点」复发
    Assert ([Math]::Abs($o.leftColW - $vp.expLeft) -le 2) "左列宽 $($o.leftColW)px ≈ 期望 $($vp.expLeft)px（断点命中正确）" "期望 $($vp.expLeft) 实际 $($o.leftColW)——嫌疑：@media 断点错位（检查 dashboard.css max-width:1400/1100 块）或 clamp 值被改动"
    if ($vp.expRow -gt 0) {
      Assert ([Math]::Abs($o.alRowH - $vp.expRow) -le 3) "告警行高 $($o.alRowH)px ≈ 期望 $($vp.expRow)px（断点命中正确）" "期望 $($vp.expRow) 实际 $($o.alRowH)——嫌疑：al-row 单行化（max-height:820）或 2K 档规则未命中"
    }
    if ($script:failInView) {
      $shot = "$PSScriptRoot/artifacts/fail-$($vp.w)x$($vp.h).png"
      playwright-cli screenshot --filename=$shot | Out-Null
      Write-Host "  留痕: $shot" -ForegroundColor Yellow
    }
    # 密度开关回归断言（v1.0，仅 1280×720 视口执行一次，测毕恢复标准态）
    if ($vp.w -eq 1280) {
      $jk = Get-Json (playwright-cli eval "(() => { const bb=()=>Math.round(document.querySelector('.bottombar').getBoundingClientRect().height); const st=()=>Math.round(document.getElementById('stage').getBoundingClientRect().height); const before={bb:bb(),st:st()}; document.getElementById('btnCompact').click(); const compact={bb:bb(),st:st(),btn:document.getElementById('btnCompact').textContent}; return JSON.stringify({before,compact}); })()")
      $k = $jk | ConvertFrom-Json
      Assert ([Math]::Abs($k.compact.bb - 77) -le 2) "紧凑态策略条 $($k.compact.bb)px ≈ 77px（标准态 $($k.before.bb)px）" "嫌疑：body.compact 规则或类名笔误（compact 段，注意 .strat-info 类名）"
      Assert ($k.compact.st -ge 500) "紧凑态主视图 $($k.compact.st)px >= 500px（标准态 $($k.before.st)px）" "嫌疑：紧凑折叠未生效，策略条未让出高度"
      playwright-cli reload | Out-Null
      Start-Sleep -Milliseconds 900
      $jp = Get-Json (playwright-cli eval "'persist:'+document.body.classList.contains('compact')+'/'+document.getElementById('btnCompact').classList.contains('is-on')")
      Assert ($jp -match 'persist:true/true') "localStorage 持久化：刷新后保持紧凑态" "嫌疑：applyCompact 初始化未读 localStorage 或存储 key 变更"
      playwright-cli eval "localStorage.setItem('uiCompact','0'); document.getElementById('btnCompact').click()" | Out-Null
      Start-Sleep -Milliseconds 400
      # 驾驶舱模式回归断言（v1.2，仅 1280×720 视口执行一次，测毕恢复标准态）
      $jc = Get-Json (playwright-cli eval "(() => { const open=()=>document.getElementById('aiDrawer').classList.contains('on'); const ck=()=>document.body.classList.contains('cockpit'); const before={ck:ck(),left:getComputedStyle(document.querySelector('.col-left')).display}; document.getElementById('btnCockpit').click(); const on={ck:ck(),left:getComputedStyle(document.querySelector('.col-left')).display,sw:document.documentElement.scrollWidth,centerW:Math.round(document.getElementById('stage').getBoundingClientRect().width)}; document.getElementById('btnCockpit').click(); const off=ck(); return JSON.stringify({before,on,off}); })()")
      $cp = $jc | ConvertFrom-Json
      Assert ($cp.on.ck -eq $true -and $cp.on.left -eq 'none') "驾驶舱态：左右面板隐藏、仅留主视图" "嫌疑：body.cockpit 规则未生效或选择器笔误（tokens.css cockpit 段）"
      Assert ($cp.on.sw -le 1282 -and $cp.on.centerW -ge 1240) "驾驶舱态无溢出：主视图 $($cp.on.centerW)px ≈ 1280 - 2×16 padding" "嫌疑：cockpit 网格单列未生效或 topbar/装饰层溢出（v1.2 曾修 topbar::after -10px 外扩）"
      Assert ($cp.off -eq $false) "驾驶舱退出恢复正常" "嫌疑：toggleCockpit 恢复逻辑缺失"
      playwright-cli eval "localStorage.clear()" | Out-Null
    }
    $c = (playwright-cli console error) -join "`n"
    if ($c -match 'Errors:\s*(\d+)') { $errTotal += [int]$Matches[1] }
  }
  Assert ($errTotal -eq 0) "console error 总数 = $errTotal"
}
finally {
  playwright-cli close 2>$null | Out-Null
  Get-Process python -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "http.server $Port" } | Stop-Process -Force
}

Write-Host ""
# 运行证据归档（v1.0）：版本号 + 时间戳 + 结果摘要，可被 CHANGELOG 引用
$ver = ([regex]::Match((Get-Content index.html -Raw), 'v[\d.]+-prototype')).Value
$summary = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $ver  断言 $($totalAsserts) 项  失败 $fail  —— $(if ($fail -eq 0) { 'PASS' } else { 'FAIL' })"
$summary | Add-Content -Path "$PSScriptRoot/artifacts/last-run.txt"
Write-Host $summary
if ($fail -eq 0) { Write-Host '== 回归全部通过 ==' -ForegroundColor Green }
else { Write-Host "== $fail 项失败 ==" -ForegroundColor Red; exit 1 }
