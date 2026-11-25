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

$ErrorActionPreference = 'Continue'

$taskName = 'DshSelfRestart'
$log = Join-Path $env:USERPROFILE '.dsh\restart-supervisor.log'

function Write-Log([string]$message) {
  $line = '[{0}] cleanup: {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $log -Value $line -Encoding UTF8
}

# 1. the task has already run; it will not run again
$existing = & schtasks.exe /query /tn $taskName 2>&1
if ($existing -notmatch 'ERROR') {
  & schtasks.exe /delete /tn $taskName /f 2>&1 | Out-Null
  Write-Log "deleted scheduled task $taskName"
} else {
  Write-Log "scheduled task $taskName already gone"
}

# 2. a terminal window whose shell has exited is a dead window
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