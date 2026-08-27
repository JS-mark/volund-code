$ErrorActionPreference = 'Stop'
$binary = $args[0]
$probe = (& $binary --probe | ConvertFrom-Json)
if ($probe.platform -ne 'windows' -or $probe.tier -ne 'partial') { throw 'Windows Tier 2 must disclose tier=partial' }
if (-not $probe.features.job_object -or -not $probe.features.restricted_token -or -not $probe.features.appcontainer -or -not $probe.features.acl_rollback -or -not $probe.features.orphan_cleanup) { throw 'Windows Tier 2 mechanisms are missing' }

function Invoke-Sandbox([string] $command, [hashtable] $permissions = @{}) {
  $request = @{
    command = $command
    cwd = $PWD.Path
    timeout_ms = 10000
    permissions = $permissions
  } | ConvertTo-Json -Compress -Depth 4
  $result = $request | & $binary | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "sandbox command failed: $command" }
  return $result
}

$builtin = Invoke-Sandbox 'echo tier-one-active'
if ($builtin.sandbox_tier -ne 'partial' -or $builtin.stdout.Trim() -ne 'tier-one-active') { throw 'restricted command did not execute at Partial tier' }

$privileges = Invoke-Sandbox 'whoami /priv'
if ($privileges.stdout -match 'SeDebugPrivilege|SeShutdownPrivilege|SeTakeOwnershipPrivilege') { throw 'restricted token retained a sensitive privilege' }

$nested = Invoke-Sandbox 'cmd.exe /D /C "cmd.exe /D /C echo escaped"'
if ($nested.stdout -match 'escaped') { throw 'Job Object active-process limit allowed a grandchild escape' }

$fixture = Join-Path $env:RUNNER_TEMP "volund-tier2-$PID"
$allowed = Join-Path $fixture 'allowed'
$denied = Join-Path $fixture 'denied'
New-Item -ItemType Directory -Force $allowed, $denied | Out-Null
Set-Content (Join-Path $denied 'secret.txt') 'must-not-leak'
$aclBefore = (Get-Acl $allowed).Sddl
$fsPermissions = @{ fs = @{ read = @($allowed); write = @($allowed) } }
$allowedFile = Join-Path $allowed 'written.txt'
$writeCommand = 'echo allowed>{0}' -f $allowedFile
$write = Invoke-Sandbox $writeCommand $fsPermissions
if ($write.exit_code -ne 0 -or -not (Test-Path $allowedFile)) { throw "AppContainer could not write an allowed path: $($write | ConvertTo-Json -Compress)" }
$aclAfter = (Get-Acl $allowed).Sddl
if ($aclAfter -ne $aclBefore) { throw 'AppContainer ACE was not rolled back after process exit' }

$deniedFile = Join-Path $denied 'secret.txt'
$readCommand = 'type {0}' -f $deniedFile
$readDenied = Invoke-Sandbox $readCommand
if ($readDenied.exit_code -eq 0 -or $readDenied.stdout -match 'must-not-leak') { throw 'AppContainer read a path outside the filesystem allowlist' }
Remove-Item -Recurse -Force $fixture
