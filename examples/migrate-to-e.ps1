<#
  EXAMPLE SHIPPED WITH dsh-local-apps.
  Adjust $Root below to a real folder on the destination volume before use.

.SYNOPSIS
  Move C: folders to another volume and leave a directory junction behind.

.DESCRIPTION
  For every mapping the script copies the folder to the destination volume with
  robocopy /MOVE, then recreates the original path as a junction (mklink /J) so
  every program keeps reading the same path. Nothing is deleted until the copy
  completes, and every step is written to a log next to the script.

.EXAMPLE
  .\migrate-to-e.ps1 -DryRun
  .\migrate-to-e.ps1 -Root 'E:\C2E' -Confirm:$false

.NOTES
  Run it from an elevated shell. Close the owning application first (IDE, Docker,
  browsers): a file held open makes robocopy retry and finally fail that folder.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Root = 'E:\C2E',
  [string[]]$Only = @(),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$user = $env:USERPROFILE
$local = $env:LOCALAPPDATA
$roaming = $env:APPDATA
$log = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) ('migrate-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

# name, source, destination subfolder, owning app (for the reminder)
$plan = @(
  [pscustomobject]@{ Name = 'JetBrains';  Source = "$local\JetBrains";                 Dest = 'JetBrains';       App = 'IntelliJ IDEA / PyCharm' }
  [pscustomobject]@{ Name = 'vscode';     Source = "$user\.vscode";                    Dest = 'vscode';          App = 'VS Code' }
  [pscustomobject]@{ Name = 'm2';         Source = "$user\.m2";                        Dest = 'm2';              App = 'Maven' }
  [pscustomobject]@{ Name = 'pnpm';       Source = "$local\pnpm";                      Dest = 'pnpm-store';      App = 'pnpm' }
  [pscustomobject]@{ Name = 'npm-cache';  Source = "$local\npm-cache";                 Dest = 'npm-cache';       App = 'npm' }
  [pscustomobject]@{ Name = 'docker';     Source = "$user\.docker";                    Dest = 'docker';          App = 'Docker CLI' }
  [pscustomobject]@{ Name = 'Temp';       Source = "$local\Temp";                      Dest = 'Temp';            App = 'close every app first' }
  [pscustomobject]@{ Name = 'DockerDesktop'; Source = "$local\Programs\DockerDesktop"; Dest = 'DockerDesktop';   App = 'Docker Desktop' }
  [pscustomobject]@{ Name = 'Downloads';  Source = "$user\Downloads";                  Dest = 'Downloads';       App = '' }
  [pscustomobject]@{ Name = 'Videos';     Source = "$user\Videos";                     Dest = 'Videos';          App = '' }
  [pscustomobject]@{ Name = 'Pictures';   Source = "$user\Pictures";                   Dest = 'Pictures';        App = '' }
)

function Write-Log([string]$message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $message
  Write-Host $line
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

function Get-FolderSize([string]$path) {
  $sum = (Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  if ($null -eq $sum) { 0 } else { $sum }
}

Write-Log "target root: $Root"
if (-not (Test-Path -LiteralPath $Root)) {
  if ($DryRun) { Write-Log "dry-run: would create $Root" } else { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
}

$selected = if ($Only.Count -gt 0) { $plan | Where-Object { $Only -contains $_.Name } } else { $plan }
$totalPlanned = 0

foreach ($item in $selected) {
  $source = $item.Source
  $dest = Join-Path $Root $item.Dest

  if (-not (Test-Path -LiteralPath $source)) { Write-Log "skip $($item.Name): source missing"; continue }
  $info = Get-Item -LiteralPath $source -Force
  if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) { Write-Log "skip $($item.Name): already a junction"; continue }

  $size = Get-FolderSize $source
  $totalPlanned += $size
  Write-Log ("plan {0,-14} {1,8:N0} MB  {2} -> {3}" -f $item.Name, ($size / 1MB), $source, $dest)

  if ($DryRun) { continue }
  if ($item.App) { Write-Log "  make sure $($item.App) is closed" }

  if (Test-Path -LiteralPath $dest) {
    Write-Log "  ERROR: destination already exists, leaving source untouched: $dest"
    continue
  }

  $robocopy = Start-Process -FilePath robocopy.exe -ArgumentList @($source, $dest, '/E', '/MOVE', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NP') -Wait -PassThru -NoNewWindow
  if ($robocopy.ExitCode -ge 8) {
    Write-Log "  ERROR: robocopy exit code $($robocopy.ExitCode) for $($item.Name); source kept"
    continue
  }

  if (Test-Path -LiteralPath $source) {
    $left = Get-ChildItem -LiteralPath $source -Force -ErrorAction SilentlyContinue
    if ($left) { Write-Log "  ERROR: source still has content, not linking: $source"; continue }
    Remove-Item -LiteralPath $source -Force -Recurse -ErrorAction SilentlyContinue
  }

  cmd.exe /c mklink /J "$source" "$dest" | Out-Null
  if (Test-Path -LiteralPath $source) {
    Write-Log "  linked $source -> $dest"
  } else {
    Write-Log "  ERROR: junction was not created for $($item.Name)"
  }
}

if (-not $DryRun) {
  Write-Log 'refreshing TEMP/TMP for the user (points at the migrated Temp folder)'
  $tempTarget = Join-Path $Root 'Temp'
  if (Test-Path -LiteralPath $tempTarget) {
    [Environment]::SetEnvironmentVariable('TEMP', $tempTarget, 'User')
    [Environment]::SetEnvironmentVariable('TMP', $tempTarget, 'User')
    Write-Log "  TEMP/TMP -> $tempTarget (new processes only)"
  }
}

Write-Log ("done. planned {0:N1} GB. free on C: {1:N2} GB" -f ($totalPlanned / 1GB), ((Get-Volume -DriveLetter C).SizeRemaining / 1GB))
