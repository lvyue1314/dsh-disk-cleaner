# Examples

Two PowerShell scripts that automate what the tools do by hand.

## migrate-to-e.ps1

Moves a fixed list of user folders to another volume and leaves a junction behind.

```powershell
.\migrate-to-e.ps1 -Root 'E:\C2E' -DryRun          # report only
.\migrate-to-e.ps1 -Root 'E:\C2E' -Only 'm2','vscode'
```

Edit the `$plan` table to match the folders you actually want to move. The script copies with
robocopy, keeps the source when the copy reports an error, and only then creates the junction.

## monthly-cleanup.ps1

Unattended cleanup for Task Scheduler: Windows Update download cache, WER reports, CBS logs,
Windows Temp, browser caches and temp files older than seven days. It writes
`logs/cleanup-YYYYMM.log` next to itself.

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\path\monthly-cleanup.ps1"'
$trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 4 -DaysOfWeek Sunday -At 3:00am
Register-ScheduledTask -TaskName 'DSH-Monthly-Cleanup' -Action $action -Trigger $trigger `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable) `
  -Principal (New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Highest)
```

## rollback

The migration is reversible. Remove the junction with `rmdir "<link>"` (a junction is deleted as a
link; its target is untouched), copy the data back with robocopy, then delete the copy on the other
volume.
