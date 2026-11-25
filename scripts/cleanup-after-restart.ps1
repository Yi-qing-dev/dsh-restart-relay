# Post-restart cleanup, run once on the next boot after a relay restart.
#
# Why this is a file instead of an inline -Command: passing a multi-line script
# with embedded double quotes through Node's execFile mangles the command line on
# Windows (execFile quotes the whole argument, and CreateProcess hands PowerShell
# something it cannot parse). A file has no quoting to get wrong.
#
# Two jobs:
#   1. drop the one-shot scheduled task the restart used;
#   2. close a terminal window that is still on screen with nothing running in it.
#      Task Scheduler hands the restarter to Windows Terminal / conhost, and that
#      host can outlive the shell it was hosting — leaving an empty black window.
#
# Order matters. This runs a few seconds after boot, while the restarter is often
# STILL RUNNING (it is waiting for the port, then writing its log). Deleting a
# running scheduled task terminates the process that owns it — which kills the
# restarter mid-flight, before it records "restart done" or the measured timing.
# So: wait for the task to finish first, then delete it.

$ErrorActionPreference = 'Continue'

$taskName = 'DshSelfRestart'
$log = Join-Path $env:USERPROFILE '.dsh\restart-supervisor.log'

function Write-Log([string]$message) {
  $line = '[{0}] cleanup: {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $log -Value $line -Encoding UTF8
}

# State of a scheduled task, or $null when it does not exist.
#
# Uses Get-ScheduledTask rather than parsing `schtasks` output: schtasks localises
# its errors, so a regex looking for "ERROR" silently reports every missing task
# as present on a Chinese (or any non-English) Windows.
function Get-TaskState([string]$name) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($null -eq $task) { return $null }
  $first = @($task)[0]
  if ($null -eq $first) { return $null }
  return [string]$first.State
}

# 1. let the restarter finish, then drop the task
$state = Get-TaskState $taskName
if ($null -eq $state) {
  Write-Log "scheduled task $taskName already gone"
} else {
  $deadline = (Get-Date).AddSeconds(90)
  $waited = 0
  while ($state -eq 'Running' -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $waited++
    $state = Get-TaskState $taskName
  }

  if ($state -eq 'Running') {
    # Still running after 90s: leave it alone rather than kill a working restart.
    Write-Log "task $taskName still running after ${waited}s; leaving it for the next boot"
  } else {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    if ($null -eq (Get-TaskState $taskName)) {
      Write-Log "deleted scheduled task $taskName (waited ${waited}s for it to finish)"
    } else {
      Write-Log "could not delete task $taskName"
    }
  }
}

# 2. a terminal window whose shell has exited is a dead window
#
# But only touch it once no restarter is alive. The restarter may still be polling
# for the new host, and it runs inside that console: closing the console host
# breaks any console program it calls afterwards. (That is exactly how a curl-based
# port probe once failed 52 seconds in a row and then launched a duplicate DSH.)
$restarters = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'restart-dsh\.ps1' })

if ($restarters.Count -gt 0) {
  Write-Log ("$($restarters.Count) restarter process(es) still alive; leaving terminal windows alone")
  exit 0
}

$cutoff = (Get-Date).AddMinutes(-10)
$hosts = @(Get-CimInstance Win32_Process -Filter "Name='OpenConsole.exe' OR Name='WindowsTerminal.exe'" -ErrorAction SilentlyContinue)
$closed = 0

foreach ($hostProc in $hosts) {
  if ($hostProc.CreationDate -lt $cutoff) { continue }

  # Only the ones the scheduler started: parent is a service host, not a user
  # shell. Hardcoding a PID would only work on the machine it was written on.
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($hostProc.ParentProcessId)" -ErrorAction SilentlyContinue
  if (-not $parent -or $parent.Name -ne 'svchost.exe') { continue }

  $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ParentProcessId -eq $hostProc.ProcessId })
  if ($children.Count -eq 0) {
    Stop-Process -Id $hostProc.ProcessId -Force -ErrorAction SilentlyContinue
    $closed++
  }
}

if ($closed -gt 0) {
  Write-Log "closed $closed empty terminal window(s)"
} else {
  Write-Log 'no empty terminal window to close'
}