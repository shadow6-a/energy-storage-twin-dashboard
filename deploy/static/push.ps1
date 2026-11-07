# One-shot static-site deploy from Windows to a Linux server over SSH.
# Usage:
#   powershell -ExecutionPolicy Bypass -File deploy/static/push.ps1 -Target 1.2.3.4 -User root -Key C:\keys\id_rsa
#   powershell -ExecutionPolicy Bypass -File deploy/static/push.ps1 -Target root@1.2.3.4 -Port 2222 -DryRun
param(
  [Parameter(Mandatory=$true)][string]$Target,
  [string]$User = 'root',
  [int]$Port = 22,
  [string]$Key = '',
  [string]$WebRoot = '/var/www/ess-twin',
  [int]$HttpPort = 80,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tar = Join-Path $repo 'dist\ess-twin-static.tar.gz'
$inst = Join-Path $PSScriptRoot 'install.sh'
if (-not (Test-Path $tar)) {
  Write-Host '[push] dist tarball missing, packing...'
  python (Join-Path $PSScriptRoot 'pack.py')
}
if (-not (Test-Path $tar)) { throw "pack failed: $tar" }
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) { throw 'scp not found (install OpenSSH client)' }
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw 'ssh not found (install OpenSSH client)' }

$dest = if ($Target -match '@') { $Target } else { "$User@$Target" }
$hostOnly = ($dest -split '@')[-1]
$keyArg = @()
if ($Key) { $keyArg = @('-i', $Key) }
$scpArgs = @('-P', "$Port") + $keyArg + @($tar, $inst, "${dest}:/tmp/")
$remoteCmd = "WEBROOT=$WebRoot PORT=$HttpPort bash /tmp/install.sh /tmp/ess-twin-static.tar.gz"
$sshArgs = @('-p', "$Port") + $keyArg + @($dest, $remoteCmd)

if ($DryRun) {
  Write-Host "[dry-run] scp $($scpArgs -join ' ')"
  Write-Host "[dry-run] ssh $($sshArgs -join ' ')"
  Write-Host "[dry-run] open http://${hostOnly}:$HttpPort/"
  exit 0
}
Write-Host "[push] uploading 18.9 MB tarball + installer to $dest ..."
& scp @scpArgs
if ($LASTEXITCODE -ne 0) { throw "scp failed ($LASTEXITCODE) - check host/user/key/firewall" }
Write-Host '[push] installing on server...'
& ssh @sshArgs
if ($LASTEXITCODE -ne 0) { throw "install failed ($LASTEXITCODE)" }
Write-Host ""
Write-Host "[push] done -> http://${hostOnly}:$HttpPort/"
Write-Host "[push] verify: curl -I http://${hostOnly}:$HttpPort/index.html"
