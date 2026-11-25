param(
  [int]$DelaySeconds = 12,
  [int]$HostPid = 0,
  [string]$TaskName = 'DshSelfRestart',
  # Passed through to restart-dsh.ps1 so the whole chain can be exercised without
  # killing anything: it registers the real task and runs the real script, which
  # then stops at its dry-run gate.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# Resolved next to this file, not from a fixed profile path: the plugin ships
# both scripts and may be installed anywhere.
$script = Join-Path $PSScriptRoot 'restart-dsh.ps1'

if (-not (Test-Path $script)) {
  Write-Error "restart-dsh.ps1 not found at $script"
  exit 1
}

# Deliberately NOT hidden.
#
# An earlier version registered the task with <Hidden>true</Hidden> and
# -WindowStyle Hidden so no console appeared. That traded a cosmetic annoyance
# for a real risk: security suites flag exactly the pattern "svchost launches a
# hidden powershell that kills a process tree". The user saw 火绒 raise
# "隐藏执行PowerShell" on the hidden version; the same task with a visible
# console is something they can watch and understand.
#
# The console is a short-lived one-shot: it exists only while the restart runs
# and closes with the process. It is not a resident task either — the task is
# deleted by the caller once the restart completes.
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -GraceSeconds {1} -HostPid {2}' -f $script, $DelaySeconds, $HostPid
if ($DryRun) { $arguments += ' -DryRun -SkipApproval' }

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>DSH self-restart helper (one shot, ends with the restart)</Description>
  </RegistrationInfo>
  <Triggers />
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>$([System.Security.SecurityElement]::Escape($arguments))</Arguments>
    </Exec>
  </Actions>
</Task>
"@

$xmlPath = Join-Path $env:TEMP ("dsh-restart-{0}.xml" -f $TaskName)
[System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.UnicodeEncoding]::new($false, $true))

& schtasks.exe /create /tn $TaskName /xml $xmlPath /f | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error "schtasks /create failed with $LASTEXITCODE"
  Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
  exit 1
}

& schtasks.exe /run /tn $TaskName | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error "schtasks /run failed with $LASTEXITCODE"
  Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
  exit 1
}

Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
"restart scheduled: DSH stops in $DelaySeconds s, relaunches automatically (task $TaskName, hostPid $HostPid)"
