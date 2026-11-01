<#
.SYNOPSIS
  Monthly, unattended cleanup of the regenerable junk on C:.

.DESCRIPTION
  Runs the same categories that were removed by hand on 2026-10-30:
  Windows Update download cache, WER reports, CBS logs, Windows\Temp,
  browser caches, and temp files older than 7 days. It never touches
  documents, chat data or installed programs, and it writes a small
  report next to itself so the growth can be reviewed over time.

  Registered as a scheduled task by register-cleanup-task.ps1.
#>
[CmdletBinding()]
param(
  [string]$LogDir
)

$ErrorActionPreference = 'Continue'

# $PSScriptRoot is not always populated while parameters bind, so resolve the
# log directory in the body: script folder first, then the known workspace path.
if (-not $LogDir) {
  if ($PSScriptRoot) { $LogDir = Join-Path $PSScriptRoot 'logs' }
  elseif ($MyInvocation.MyCommand.Path) { $LogDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'logs' }
  else { $LogDir = Join-Path $env:TEMP 'dsh-cleanup-logs' }
}
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# The task runs as S4U (no loaded profile), so the usual environment variables
# can be absent: resolve the user folders explicitly with a registry/known-path
# fallback instead of trusting $env:LOCALAPPDATA / $env:TEMP.
$userDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:USERNAME) { Join-Path 'C:\Users' $env:USERNAME } else { 'C:\Users\Default' }
$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $userDir 'AppData\Local' }
$userTemp = [Environment]::GetEnvironmentVariable('TEMP', 'User')
if (-not $userTemp) { $userTemp = Join-Path $localAppData 'Temp' }
$stamp = Get-Date -Format 'yyyyMM'
$log = Join-Path $LogDir ("cleanup-$stamp.log")

function Write-Log([string]$message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

function Get-Size([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return 0 }
  $sum = (Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  if ($null -eq $sum) { 0 } else { $sum }
}

function Clear-Path([string]$path, [string]$label, [int]$olderThanDays = -1) {
  if (-not (Test-Path -LiteralPath $path)) { Write-Log ("skip  {0,-22} (missing)" -f $label); return 0 }
  $before = Get-Size $path
  $items = Get-ChildItem -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if ($olderThanDays -ge 0) {
    $cutoff = (Get-Date).AddDays(-$olderThanDays)
    $items = $items | Where-Object { $_.LastWriteTime -lt $cutoff }
  }
  foreach ($item in $items) {
    Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
  $after = Get-Size $path
  $freed = [Math]::Max(0, $before - $after)
  Write-Log ("clean {0,-22} {1,9:N0} MB" -f $label, ($freed / 1MB))
  return $freed
}

$freeBefore = (Get-Volume -DriveLetter C).SizeRemaining
Write-Log '=== monthly cleanup start ==='
$total = 0

# 1. Windows Update download cache (needs the services stopped)
$total += Clear-Path 'C:\Windows\SoftwareDistribution\Download' 'update cache'
if (Test-Path 'C:\Windows\SoftwareDistribution\Download') {
  Stop-Service wuauserv -Force -ErrorAction SilentlyContinue
  Stop-Service bits -Force -ErrorAction SilentlyContinue
  $total += Clear-Path 'C:\Windows\SoftwareDistribution\Download' 'update cache (services stopped)'
  Start-Service wuauserv -ErrorAction SilentlyContinue
  Start-Service bits -ErrorAction SilentlyContinue
}

# 2. Logs and error reports
$total += Clear-Path 'C:\ProgramData\Microsoft\Windows\WER' 'WER reports'
$total += Clear-Path 'C:\Windows\Logs\CBS' 'CBS logs'
$total += Clear-Path 'C:\Windows\Temp' 'windows temp'

# 3. Browser caches
foreach ($browser in @(
  (Join-Path $localAppData 'Microsoft\Edge\User Data'),
  (Join-Path $localAppData 'Google\Chrome\User Data'))) {
  if (-not (Test-Path -LiteralPath $browser)) { continue }
  Get-ChildItem -LiteralPath $browser -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' } |
    ForEach-Object {
      foreach ($cache in 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache') {
        $total += Clear-Path (Join-Path $_.FullName $cache) ("browser cache " + $cache)
      }
    }
}

# 4. Temp files older than a week (the live ones stay)
$total += Clear-Path $userTemp 'user temp (>7d)' 7
$total += Clear-Path (Join-Path $localAppData 'Temp') 'old C: temp (>7d)' 7

$freeAfter = (Get-Volume -DriveLetter C).SizeRemaining
Write-Log ('total cleaned {0:N0} MB ; C: free {1:N2} GB -> {2:N2} GB' -f ($total / 1MB), ($freeBefore / 1GB), ($freeAfter / 1GB))
Write-Log '=== monthly cleanup done ==='
