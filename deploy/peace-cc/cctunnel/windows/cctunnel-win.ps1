# cctunnel for Windows: use cloudcli on peace-cc through an SSH tunnel. cctunnel.cmd and ccopen.cmd run this file.
# cloudcli listens only on 127.0.0.1:3001 on peace-cc; the tunnel makes it http://127.0.0.1:3001 here.
# Windows OpenSSH has no ControlMaster and no -f, so every forward is its own hidden ssh.exe, tracked in
# %LOCALAPPDATA%\cctunnel. ssh must log in without asking anything: run "ssh peace-cc" once first.
#
#   cctunnel install               add this folder to the user PATH (then open a new terminal)
#   cctunnel [up]                  start the tunnel in the background; does nothing when it already works
#   ccopen [/path]                 up, then open http://127.0.0.1:3001/path in the browser (= cctunnel open)
#   cctunnel status                tunnel state and cloudcli health
#   cctunnel down                  stop the tunnel and its forwards
#   cctunnel fwd PORT[:REMOTE]...  also forward 127.0.0.1:PORT to port REMOTE (default PORT) on peace-cc
#   cctunnel unfwd PORT...         stop one of those forwards
#   cctunnel watch                 stay in the foreground and restart whatever drops; Ctrl-C stops everything
#
# Environment:
#   CCTUNNEL_HOST          ssh destination, an alias in ~\.ssh\config or user@host (default peace-cc)
#   CCTUNNEL_PORT          local port of the web UI (default 3001); every command needs the same value
#   CCTUNNEL_REMOTE_PORT   cloudcli's port on peace-cc (default 3001)
#   CCTUNNEL_SSH_OPTS      more ssh options, split at spaces, e.g. "-i ~/.ssh/id_peace"
$ErrorActionPreference = 'Stop'

function Get-Setting([string]$name, [string]$default) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ($v) { return $v }
  return $default
}

$Command = if ($args.Count) { [string]$args[0] } else { 'up' }
$Rest = @($args | Select-Object -Skip 1)
$TargetHost = Get-Setting 'CCTUNNEL_HOST' 'peace-cc'
$Port = Get-Setting 'CCTUNNEL_PORT' '3001'
$RemotePort = Get-Setting 'CCTUNNEL_REMOTE_PORT' '3001'
$ExtraOpts = @((Get-Setting 'CCTUNNEL_SSH_OPTS' '') -split '\s+' | Where-Object { $_ })
$StateDir = Join-Path $env:LOCALAPPDATA 'cctunnel'
$Name = ($TargetHost -replace '[^A-Za-z0-9._-]', '_') + '-' + $Port
$StateFile = Join-Path $StateDir "$Name.txt"   # one line per forward: LOCAL REMOTE PID START_TICKS_UTC
$script:Taken = $false
# One cctunnel at a time starts or stops this tunnel, so watch and ccopen in two terminals never race.
$script:Mutex = New-Object System.Threading.Mutex($false, "Local\cctunnel-$Name")

function Say([string]$m) { Write-Host "-> $m" }
function Warn([string]$m) { [Console]::Error.WriteLine("cctunnel: $m") }
function Fail([string]$m) { Warn $m; exit 1 }

function Lock-Tunnel {
  # Short waits: PowerShell cannot interrupt a blocked .NET call, so Ctrl-C only works between them.
  # A cctunnel killed while holding the lock leaves it abandoned; the wait then owns it anyway.
  $said = $false
  while ($true) {
    try { if ($script:Mutex.WaitOne(500)) { return } } catch [System.Threading.AbandonedMutexException] { return }
    if (-not $said) { Say 'waiting for another cctunnel command to finish'; $said = $true }
  }
}

function Show-Usage {
  foreach ($line in Get-Content -LiteralPath $PSCommandPath) {
    if ($line -notmatch '^#') { break }
    Write-Host ($line -replace '^# ?', '')
  }
}

function Test-PortArg([string]$p) {
  if ($p -notmatch '^\d{1,5}$' -or [int]$p -lt 1 -or [int]$p -gt 65535) { Fail "not a port: $p" }
}

function Read-State {
  if (Test-Path -LiteralPath $StateFile) {
    foreach ($line in @(Get-Content -LiteralPath $StateFile)) {
      $f = @($line -split ' ')
      if ($f.Count -eq 4) {
        New-Object psobject -Property @{ Local = [int]$f[0]; Remote = [int]$f[1]; Proc = [int]$f[2]; Ticks = [long]$f[3] }
      }
    }
  }
}

function Write-State($list) {
  $lines = @($list | Where-Object { $_ } | ForEach-Object { '{0} {1} {2} {3}' -f $_.Local, $_.Remote, $_.Proc, $_.Ticks })
  if ($lines.Count) {
    if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }
    Set-Content -LiteralPath $StateFile -Value $lines -Encoding ASCII
  } else {
    Remove-Item -LiteralPath $StateFile -ErrorAction SilentlyContinue
  }
}

# Replaces the entry for one local port; $null just removes it.
function Set-Entry([int]$local, $entry) {
  Write-State (@(Read-State | Where-Object { $_.Local -ne $local }) + $entry)
}

# True when the ssh of this entry still runs: same PID and same start time (UTC, so a time zone change does not
# matter), so a PID that Windows gave to another program does not count.
function Test-Alive($t) {
  try {
    $p = Get-Process -Id $t.Proc -ErrorAction Stop
    return [Math]::Abs($p.StartTime.ToUniversalTime().Ticks - $t.Ticks) -lt 10000000
  } catch {
    return $false
  }
}

function Stop-Entry($t) {
  if (Test-Alive $t) {
    Stop-Process -Id $t.Proc -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $t.Proc -Timeout 5 -ErrorAction SilentlyContinue
  }
}

function Get-PortOwners([int]$p) {
  @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) | ForEach-Object { [int]$_.OwningProcess }
}

function Get-SshPath {
  foreach ($n in 'ssh.exe', 'ssh') {
    $c = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Path }
  }
  Fail 'ssh.exe not found; install the OpenSSH client (Settings > Apps > Optional features)'
}

# Quotes arguments the way Windows programs split their command line.
function Join-Args([string[]]$list) {
  ($list | ForEach-Object {
    if ($_ -eq '' -or $_ -match '[\s"]') { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' } else { $_ }
  }) -join ' '
}

# Process.Start hands ssh every inheritable handle of ours. When our output goes to a pipe ($x = ccopen,
# ccopen | Out-Null), ssh would keep that pipe open and the caller would wait until the tunnel stops.
# So the std handles are not inheritable while ssh starts (flag 0), and inheritable again afterwards (flag 1).
function Set-StdInheritance([int]$flag) {
  if (-not ([Console]::IsOutputRedirected -or [Console]::IsErrorRedirected -or [Console]::IsInputRedirected)) { return }
  try {
    if (-not ('CcTunnel.Native' -as [type])) {
      Add-Type -Namespace CcTunnel -Name Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool SetHandleInformation(IntPtr h, int mask, int flags);
'@
    }
    foreach ($n in -10, -11, -12) { [void][CcTunnel.Native]::SetHandleInformation([CcTunnel.Native]::GetStdHandle($n), 1, $flag) }
  } catch { }
}

# Says why ssh gave up; its own messages are printed above.
function Show-Failure([string]$log, [int]$local) {
  if ($log -match "\]:${local}: ") {
    if ($local -eq $Port) { Warn "cannot listen on 127.0.0.1:$local; set CCTUNNEL_PORT to another port" }
    else { Warn "cannot listen on 127.0.0.1:$local; forward another local port: cctunnel fwd OTHER:REMOTE" }
  } elseif ($log -match 'Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED') {
    Warn "ssh does not trust ${TargetHost}'s host key yet; run ""ssh $TargetHost"" once and answer yes"
  } elseif ($log -match 'Too many authentication failures') {
    Warn "ssh offered $TargetHost too many other keys; put IdentityFile and ""IdentitiesOnly yes"" under its Host block in ~\.ssh\config"
  } elseif ($log -match 'Permission denied') {
    Warn "$TargetHost refused the login; ""ssh $TargetHost"" must work without a prompt. Load a key with a passphrase with ssh-add; if that cannot reach the agent, start it once in an admin PowerShell: Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent"
  } elseif ($log -match 'Could not request local forwarding|remote port forwarding failed') {
    Warn "a LocalForward or RemoteForward under ""Host $TargetHost"" in ~\.ssh\config failed; give cctunnel an alias without them (CCTUNNEL_HOST)"
  } elseif ($log -match ': terminating, ') {
    Warn 'ssh cannot read its config'
  } else {
    Warn "ssh to $TargetHost failed"
  }
}

# Starts a hidden ssh for 127.0.0.1:LOCAL -> TARGET:REMOTE on the far side and returns its entry,
# or $null after saying why it could not.
function Start-Forward([int]$local, [string]$target, [int]$remote) {
  $owners = @(Get-PortOwners $local)
  if ($owners.Count) {
    $who = Get-Process -Id $owners[0] -ErrorAction SilentlyContinue
    $what = if ($who) { $who.ProcessName } else { 'another program' }
    Warn "127.0.0.1:$local is taken by $what (PID $($owners[0]))"
    if ($local -eq $Port) {
      $alt = if ($Port -eq 13001) { 13002 } else { 13001 }
      Warn "give every cctunnel command another port: setx CCTUNNEL_PORT $alt, then open a new terminal"
      $script:Taken = $true
    }
    return $null
  }
  if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }
  $log = Join-Path $StateDir "$Name-$local.log"
  Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
  # No ConnectTimeout: Windows 10's ssh (before 8.6) always waits all of it. The deadline below bounds the wait.
  $sshArgs = $ExtraOpts + @('-n', '-N', '-E', $log, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR',
    '-L', "127.0.0.1:${local}:${target}:${remote}", $TargetHost)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Get-SshPath
  $psi.Arguments = Join-Args $sshArgs
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = $StateDir   # Windows locks a process's current folder; do not hold the caller's
  Set-StdInheritance 0
  try { $p = [System.Diagnostics.Process]::Start($psi) } finally { Set-StdInheritance 1 }
  $entry = $null
  $late = $false
  try {
    $deadline = (Get-Date).AddSeconds(25)
    while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
      if (@(Get-PortOwners $local) -contains $p.Id) {
        $entry = New-Object psobject -Property @{
          Local = $local; Remote = $remote; Proc = $p.Id; Ticks = $p.StartTime.ToUniversalTime().Ticks
        }
        return $entry
      }
      Start-Sleep -Milliseconds 300
    }
    $late = -not $p.HasExited
  } finally {
    # Ctrl-C does not reach the hidden ssh.exe: stop it here, or it would hold the port without being tracked.
    if (-not $entry -and -not $p.HasExited) {
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      [void]$p.WaitForExit(5000)   # until it is gone, ssh keeps its log locked
    }
  }
  $text = ''
  if (Test-Path -LiteralPath $log) { $text = (Get-Content -LiteralPath $log -ErrorAction SilentlyContinue) -join "`n" }
  if ($text) {
    [Console]::Error.WriteLine($text)
    Show-Failure $text $local
  } elseif ($late) {
    Warn "ssh did not get through to $TargetHost in 25 s; is the network up?"
  } else {
    # ssh checks its command-line options before it opens the -E log; let it say what is wrong with them.
    if ($ExtraOpts.Count) { & $psi.FileName @ExtraOpts -G $TargetHost > $null }
    Warn "ssh to $TargetHost failed"
  }
  return $null
}

# curl's exit code (0 = cloudcli answered, 28 = no reply in 5 s: the link is dead, -1 = no curl) and cloudcli's version.
function Get-Health {
  $curl = $null
  foreach ($n in 'curl.exe', 'curl') {
    if (-not $curl) { $curl = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
  }
  if (-not $curl) { return New-Object psobject -Property @{ Code = -1; Version = '' } }
  $body = & $curl.Path --noproxy '*' -fs -m 5 "http://127.0.0.1:$Port/health"
  $code = $LASTEXITCODE
  $version = ''
  if ($code -eq 0) {
    try {
      $j = ($body -join "`n") | ConvertFrom-Json
      if ($j.status -eq 'ok') { $version = [string]$j.version } else { $code = 1 }
    } catch {
      $code = 1
    }
  }
  return New-Object psobject -Property @{ Code = $code; Version = $version }
}

function Wait-Health {
  for ($i = 0; $i -lt 5; $i++) {
    if ((Get-Health).Code -le 0) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# Makes sure the web UI tunnel runs. -Quiet: say nothing when it already does. -NoHealth: only check that ssh runs.
function Confirm-Ui([switch]$Quiet, [switch]$NoHealth) {
  $ui = @(Read-State | Where-Object { $_.Local -eq $Port })
  if ($ui.Count -and (Test-Alive $ui[0])) {
    if ($NoHealth) { return $true }
    $h = Get-Health
    if ($h.Code -le 0) {
      if (-not $Quiet) { Say "tunnel already up: http://127.0.0.1:$Port -> port $RemotePort on $TargetHost" }
      return $true
    }
    # 28: no reply at all, the connection is dead. Other errors mean peace-cc answered and cloudcli did not.
    if ($h.Code -ne 28 -and $h.Code -ne 7) {
      Warn "tunnel is up but cloudcli does not answer on 127.0.0.1:$Port (is cloudcli.service running on ${TargetHost}?)"
      return $true
    }
    Say 'no answer through the tunnel; reconnecting'
    foreach ($t in @(Read-State)) { Stop-Entry $t }   # the forwards ride the same dead link; up restarts them
  }
  $t = Start-Forward $Port '127.0.0.1' $RemotePort
  if (-not $t) { return $false }
  Set-Entry $Port $t
  Say "tunnel up: http://127.0.0.1:$Port -> port $RemotePort on $TargetHost"
  if (-not $NoHealth -and -not (Wait-Health)) {
    Warn "tunnel is up but cloudcli does not answer on 127.0.0.1:$Port (is cloudcli.service running on ${TargetHost}?)"
  }
  return $true
}

# Restarts saved forwards whose ssh has exited. False when one could not start.
function Confirm-Forwards {
  $ok = $true
  foreach ($t in @(Read-State)) {
    if ($t.Local -eq $Port -or (Test-Alive $t)) { continue }
    $n = Start-Forward $t.Local 'localhost' $t.Remote
    if (-not $n) { $ok = $false; continue }
    Set-Entry $n.Local $n
    Say "http://127.0.0.1:$($n.Local) (port $($n.Remote) on $TargetHost)"
  }
  return $ok
}

function Stop-All {
  $any = $false
  foreach ($t in @(Read-State)) {
    if (Test-Alive $t) { Stop-Entry $t; $any = $true }
  }
  Remove-Item -LiteralPath $StateFile -ErrorAction SilentlyContinue
  return $any
}

function Split-Spec([string]$spec) {
  $parts = @($spec -split ':', 2)
  $l = $parts[0]
  $r = if ($parts.Count -gt 1) { $parts[1] } else { $parts[0] }
  Test-PortArg $l
  Test-PortArg $r
  return @([int]$l, [int]$r)
}

function Invoke-Up {
  if (-not (Confirm-Ui)) { exit 1 }
  [void](Confirm-Forwards)
}

function Invoke-Open {
  $path = if ($Rest.Count) { [string]$Rest[0] } else { '/' }
  if (-not $path.StartsWith('/')) { $path = "/$path" }
  Invoke-Up
  $url = "http://127.0.0.1:$Port$path"
  Say $url
  Start-Process $url
}

function Show-Status {
  $rc = 0
  $state = @(Read-State)
  $ui = @($state | Where-Object { $_.Local -eq $Port })
  if ($ui.Count -and (Test-Alive $ui[0])) {
    Write-Host "tunnel:   up, http://127.0.0.1:$Port -> port $RemotePort on $TargetHost"
  } else {
    Write-Host 'tunnel:   down'
    $rc = 1
  }
  foreach ($t in @($state | Where-Object { $_.Local -ne $Port })) {
    $note = if (Test-Alive $t) { '' } else { ' (down; up restarts it)' }
    Write-Host "          http://127.0.0.1:$($t.Local) -> port $($t.Remote)$note"
  }
  $h = Get-Health
  if ($h.Code -lt 0) {
    Write-Host 'cloudcli: unknown (curl.exe is missing)'
  } elseif ($h.Code -eq 0) {
    $v = if ($h.Version) { " (v$($h.Version))" } else { '' }
    Write-Host "cloudcli: ok$v"
  } else {
    Write-Host "cloudcli: no answer on 127.0.0.1:$Port"
    $rc = 1
  }
  exit $rc
}

function Invoke-Fwd {
  if (-not $Rest.Count) { Fail 'usage: cctunnel fwd PORT[:REMOTE]...' }
  $specs = @()
  foreach ($s in $Rest) {
    $lr = Split-Spec $s
    if ($lr[0] -eq $Port) { Fail "127.0.0.1:$Port is the web UI tunnel itself" }
    $specs += ,$lr
  }
  if (-not (Confirm-Ui -Quiet)) { exit 1 }
  $rc = 0
  foreach ($lr in $specs) {
    $l = $lr[0]
    $r = $lr[1]
    $old = @(Read-State | Where-Object { $_.Local -eq $l })
    if ($old.Count -and (Test-Alive $old[0])) {
      if ($old[0].Remote -eq $r) { Say "http://127.0.0.1:$l (port $r on $TargetHost)"; continue }
      Warn "127.0.0.1:$l already goes to port $($old[0].Remote); run cctunnel unfwd $l first"
      $rc = 1
      continue
    }
    $n = Start-Forward $l 'localhost' $r
    if (-not $n) { $rc = 1; continue }
    Set-Entry $l $n
    Say "http://127.0.0.1:$l (port $r on $TargetHost)"
  }
  [void](Confirm-Forwards)   # saved forwards that a reconnect above stopped
  exit $rc
}

function Invoke-Unfwd {
  if (-not $Rest.Count) { Fail 'usage: cctunnel unfwd PORT...' }
  $rc = 0
  foreach ($s in $Rest) {
    $l = (Split-Spec $s)[0]
    $old = @(Read-State | Where-Object { $_.Local -eq $l -and $_.Local -ne $Port })
    if (-not $old.Count) { Warn "127.0.0.1:$l is not forwarded"; $rc = 1; continue }
    Stop-Entry $old[0]
    Set-Entry $l $null
    Say "stopped 127.0.0.1:$l"
  }
  exit $rc
}

function Invoke-Watch {
  Say 'keeping the tunnel up (Ctrl-C stops it)'
  $delay = 5
  $keep = $false
  try {
    while ($true) {
      Lock-Tunnel
      $script:Taken = $false
      $ok = Confirm-Ui -Quiet -NoHealth
      if ($script:Taken) { $keep = $true; exit 1 }   # another program has the web UI port; leave the forwards alone
      if ($ok) { [void](Confirm-Forwards) }   # a forward that cannot start must not slow down the web UI's restart
      $script:Mutex.ReleaseMutex()
      # Retry sooner after a success, back off to 30 s while offline.
      if ($ok) { $delay = 5 } else { $delay = [Math]::Min(30, $delay * 2) }
      Start-Sleep -Seconds $delay
    }
  } finally {
    if (-not $keep) {
      Lock-Tunnel
      [void](Stop-All)
    }
  }
}

# Adds this folder to the user PATH, keeping %VARIABLES% in the other entries as they are.
function Install-Path {
  $dir = $PSScriptRoot.TrimEnd('\')
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $parts = @($old -split ';' | Where-Object { $_ })
  $expanded = @($parts | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
  if ($expanded -contains $dir) {
    $key.Close()
    Say "$dir is already in your PATH"
    return
  }
  $new = (@($parts) + $dir) -join ';'
  $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  $key.Close()
  # Setting a user variable through .NET broadcasts the change, so new terminals see the new PATH.
  [Environment]::SetEnvironmentVariable('CCTUNNEL_INSTALL', '1', 'User')
  [Environment]::SetEnvironmentVariable('CCTUNNEL_INSTALL', $null, 'User')
  Say "added $dir to your PATH; open a new terminal and run: ccopen"
}

Test-PortArg $Port
Test-PortArg $RemotePort
$Port = [int]$Port
$RemotePort = [int]$RemotePort
if ($Command -in 'up', 'open', 'down', 'fwd', 'unfwd') { Lock-Tunnel }
switch ($Command) {
  'install' { Install-Path }
  'up'      { Invoke-Up }
  'open'    { Invoke-Open }
  'status'  { Show-Status }
  'down'    { if (Stop-All) { Say 'tunnel stopped' } else { Write-Host 'tunnel was not running' } }
  'fwd'     { Invoke-Fwd }
  'unfwd'   { Invoke-Unfwd }
  'watch'   { Invoke-Watch }
  'help'    { Show-Usage }
  '-h'      { Show-Usage }
  '--help'  { Show-Usage }
  '/?'      { Show-Usage }
  default   { Show-Usage; exit 2 }
}
