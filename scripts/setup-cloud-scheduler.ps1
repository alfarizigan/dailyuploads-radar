param(
  [ValidateSet('install', 'status', 'remove')]
  [string]$Action = 'install',
  [string]$TaskName = 'DailyUploadsRadar-CloudSync'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$VbsPath = Join-Path $PSScriptRoot 'silent-cloud-ping.vbs'
$WscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'

if ($Action -eq 'remove') {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed scheduled task '$TaskName'."
  } else {
    Write-Output "Scheduled task '$TaskName' is not installed."
  }
  exit 0
}

if ($Action -eq 'status') {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Output "Scheduled task '$TaskName' is NOT installed."
    exit 1
  }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  [PSCustomObject]@{
    TaskName       = $task.TaskName
    State          = [string]$task.State
    LastRunTime    = $info.LastRunTime
    LastTaskResult = $info.LastTaskResult
    NextRunTime    = $info.NextRunTime
  } | Format-List
  exit 0
}

# Calculate next staggered 15-minute slot (:09, :24, :39, :54) — 2m after GitHub's (7,22,37,52) cron
# so if GitHub's native schedule runs on time, cloud-pinger automatically skips without duplicate work.
$now = Get-Date
$slots = @(9, 24, 39, 54)
$nextMinute = $null
foreach ($s in $slots) {
  if ($now.Minute -lt $s) {
    $nextMinute = $s
    break
  }
}
if ($null -eq $nextMinute) {
  $baseHour = $now.Date.AddHours($now.Hour + 1)
  $startAt = $baseHour.AddMinutes(9)
} else {
  $startAt = $now.Date.AddHours($now.Hour).AddMinutes($nextMinute)
}

$taskAction = New-ScheduledTaskAction `
  -Execute $WscriptExe `
  -Argument "//B //Nologo `"$VbsPath`"" `
  -WorkingDirectory $RepoRoot

$taskTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At $startAt `
  -RepetitionInterval (New-TimeSpan -Minutes 15) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$taskSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -Hidden

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $taskAction `
  -Trigger $taskTrigger `
  -Settings $taskSettings `
  -Description 'Smart 15-minute GitHub Cloud Sync pinger for DailyUploads Radar (skips automatically if GitHub cron already synced).' `
  -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Output "Installed silent 15-minute scheduled task '$TaskName' (NextRunTime: $($info.NextRunTime))."
