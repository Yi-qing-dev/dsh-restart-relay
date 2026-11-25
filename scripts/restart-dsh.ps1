param(
  [int]$GraceSeconds = 3,
  [int]$WaitApprovalSeconds = 90,
  [int]$WaitExitSeconds = 25,
  [int]$PortReadySeconds = 60,
  [int]$MaxAttempts = 3,
  [int]$HostPid = 0,
  [switch]$SkipApproval,
  [switch]$DryRun
)

# Foreground mode: the plugin launches the restarter with a visible window and
# without this switch, so the user SEES the console that is doing the killing.
# That matters because security suites (火绒, 360, 电脑管家…) flag precisely the
# combination "svchost → hidden powershell → silently kills a process tree".
# A visible, one-shot console reads as "the app the user just clicked", while
# hidden-and-lurking reads as malicious. The window closes on exit because the
# console was started solely for this process.

$ErrorActionPreference = 'Continue'
$dsh = Join-Path $env:USERPROFILE '.dsh'
$log = Join-Path $dsh 'restart-supervisor.log'
$approvedMarker = Join-Path $dsh 'restart-approved'
$requestFile = Join-Path $dsh 'restart-request.json'
# The executable is resolved from the running process further down; this is only
# a last-resort fallback. Hardcoding an install path breaks every other machine.
$exe = $null

function Write-Log([string]$message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $log -Value $line -Encoding UTF8
}

# Walk up from the DSH host process to the Electron main process that owns it.
# Killing only this tree leaves any other DSH instance (e.g. one running inside
# a virtual desktop sandbox) untouched.
function Resolve-MainViaHost([int]$hostPid) {
  $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$hostPid" -ErrorAction SilentlyContinue
  if (-not $cur) { return $null }
  for ($i = 0; $i -lt 6; $i++) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
    if (-not $parent) { break }
    if ($parent.Name -eq 'DeepSeek Harness.exe' -and $parent.CommandLine -notmatch '--type=') {
      return $parent
    }
    $cur = $parent
  }
  return $null
}

# The GUI listens on a loopback port. Probing it is the only reliable "the new
# Host is actually usable" signal; a fixed sleep either wastes time or races.
function Get-DshListenPorts {
  $ports = @()
  Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
    Where-Object { $_.CommandLine -match '--expose-internals' } |
    ForEach-Object {
      Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { $ports += $_.LocalPort }
    }
  return $ports | Where-Object { $_ -gt 0 } | Sort-Object -Unique
}

function Test-PortOpen([int]$port) {
  # A plain TCP connect, not curl.exe.
  #
  # curl was the original probe and it broke in the worst possible way: curl.exe
  # is a console program, so once the console host dies (the cleanup helper can
  # close an empty terminal window, and this script may be running inside it) it
  # stops working entirely. The retry loop then concludes "DSH never came up"
  # and launches a second instance. .NET sockets need no console at all.
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    $signalled = $async.AsyncWaitHandle.WaitOne(1500)
    if (-not $signalled) { $client.Close(); return $false }
    $client.EndConnect($async)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

function Test-DshReachable([int[]]$ports) {
  # First listening port wins. The GUI answers 401 without a cookie and the
  # plugin host answers 404 on paths it does not own, so an HTTP status check
  # would need per-port expectations; a bound socket is the signal that matters
  # here — it only appears once the new host has started listening.
  foreach ($port in $ports) {
    if (Test-PortOpen $port) { return $port }
  }
  return 0
}

Write-Log '--- restart requested ---'

if ($HostPid -gt 0) {
  $main = Resolve-MainViaHost $HostPid
  if ($main) {
    Write-Log ("targeted via host pid {0} -> electron main {1}" -f $HostPid, $main.ProcessId)
  } else {
    Write-Log ("could not resolve main from host pid {0}; falling back to name scan" -f $HostPid)
  }
}

if (-not $main) {
  $main = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' } |
    Sort-Object CreationDate |
    Select-Object -First 1
}

if (-not $main) {
  Write-Log 'no Electron main process found; aborting'
  exit 1
}

# Relaunch exactly the binary that is running now. A hardcoded install path only
# works on the machine it was written on: users install DSH wherever they like,
# and a stale path turns "restart" into "close and never come back".
if ($main.ExecutablePath -and (Test-Path $main.ExecutablePath)) {
  $exe = $main.ExecutablePath
  Write-Log ("executable {0}" -f $exe)
} else {
  Write-Log 'could not read the running executable path; aborting (a relaunch would fail)'
  exit 6
}

Write-Log ("main pid={0}; grace={1}s; dryRun={2}; skipApproval={3}" -f $main.ProcessId, $GraceSeconds, $DryRun, $SkipApproval)

if ($DryRun) {
  Write-Log 'dry run: not killing anything'
  exit 0
}

# --- Approval gate -----------------------------------------------------------
# The restart only proceeds when the user pressed "立即重启" in the banner, which
# writes restart-approved. Without it the task is either still counting down or
# was deferred, and killing DSH here would destroy unsaved work.
if (-not $SkipApproval) {
  if (-not (Test-Path $approvedMarker)) {
    if (-not (Test-Path $requestFile)) {
      Write-Log 'no restart request and no approval; aborting'
      exit 2
    }
    Write-Log ("waiting up to {0}s for approval" -f $WaitApprovalSeconds)
    $approvalDeadline = (Get-Date).AddSeconds($WaitApprovalSeconds)
    while ((Get-Date) -lt $approvalDeadline) {
      if (Test-Path $approvedMarker) { break }
      # The plugin deletes the request when the user presses "稍后". Treating that
      # as an immediate abort means a deferred restart stops waiting right away
      # instead of holding the gate open for the full timeout.
      if (-not (Test-Path $requestFile)) {
        Write-Log 'request withdrawn (deferred); aborting without touching DSH'
        exit 5
      }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path $approvedMarker)) {
      Write-Log 'approval timeout; aborting without touching DSH'
      exit 3
    }
  }
  Write-Log 'approval present'
}

$port = Test-DshReachable (Get-DshListenPorts)
if ($port -gt 0) { Write-Log ("current GUI port {0}" -f $port) } else { Write-Log 'current GUI port unknown' }

Start-Sleep -Seconds $GraceSeconds

# --- Kill, relaunch, verify --------------------------------------------------
$attempt = 0
$ok = $false

while ($attempt -lt $MaxAttempts -and -not $ok) {
  $attempt++
  Write-Log ("attempt {0}/{1}" -f $attempt, $MaxAttempts)

  $target = Get-CimInstance Win32_Process -Filter "ProcessId=$($main.ProcessId)" -ErrorAction SilentlyContinue
  if ($target) {
    Write-Log ("killing tree of {0}" -f $main.ProcessId)
    & taskkill.exe /PID $main.ProcessId /T /F 2>&1 | Out-Null
  } else {
    Write-Log 'main process already gone'
  }

  $killAt = Get-Date
  $exitDeadline = (Get-Date).AddSeconds($WaitExitSeconds)
  while ((Get-Date) -lt $exitDeadline) {
    if (-not (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 400
  }
  $left = Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($left) {
    # Not a failure: on a retry the app we launched a moment ago is still here.
    # Launching another copy because we mistook it for a failed start is how
    # duplicate instances appear, so only launch when nothing is running.
    Write-Log ("warning: {0} process(es) still alive; not relaunching" -f ($left | Measure-Object).Count)
  } else {
    Write-Log 'all dsh processes exited'

    Start-Sleep -Seconds 3
    Write-Log 'relaunching DeepSeek Harness'
    # Redirect the child's stdio to files instead of letting it inherit this
    # script's console. If DSH inherits our handles it keeps them after we exit;
    # the console goes away with us, and the next console.info() inside
    # electron-updater dies with "write EPIPE" and pops a main-process error box.
    $outLog = Join-Path $dsh 'dsh-stdout.log'
    $errLog = Join-Path $dsh 'dsh-stderr.log'
    try {
      Start-Process -FilePath $exe -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    } catch {
      Write-Log ("redirected launch failed ({0}); falling back to plain launch" -f $_.Exception.Message)
      Start-Process -FilePath $exe
    }
  }

  # Wait for the new Host to answer on some loopback port, not for a fixed delay.
  $readyDeadline = (Get-Date).AddSeconds($PortReadySeconds)
  while ((Get-Date) -lt $readyDeadline) {
    Start-Sleep -Milliseconds 500
    $ports = Get-DshListenPorts
    if ($ports.Count -eq 0) { continue }
    $reached = Test-DshReachable $ports
    if ($reached -gt 0) {
      $elapsed = [int]((Get-Date) - $killAt).TotalMilliseconds
      Write-Log ("port ready on {0} after {1}ms (attempt {2})" -f $reached, $elapsed, $attempt)
      Write-Log ("timing killToPortMs={0}" -f $elapsed)
      $ok = $true
      break
    }
  }

  if (-not $ok) {
    Write-Log ("attempt {0} failed: port not reachable within {1}s" -f $attempt, $PortReadySeconds)
  }
}

# Consume the approval marker so a stale one cannot trigger the next restart.
if (Test-Path $approvedMarker) {
  Remove-Item $approvedMarker -Force -ErrorAction SilentlyContinue
}

if ($ok) {
  Write-Log '--- restart done ---'
  exit 0
}

Write-Log ("gave up after {0} attempts; DSH may be down, start it manually" -f $MaxAttempts)
exit 4
