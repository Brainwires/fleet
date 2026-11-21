# gate.ps1: the forced command of Fleet's update key on a Windows host (docs/updates.md). Named in
# C:\ProgramData\ssh\administrators_authorized_keys by `command="powershell -NoProfile
# -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\FleetUpdate\gate.ps1",restrict`.
#
# It reads one verb from SSH_ORIGINAL_COMMAND and runs exactly that verb's command; anything else
# exits 64 having run nothing. The verb is compared with fixed words (case-sensitive), never
# evaluated, split or passed to another shell.
#
#   status            scan.ps1: the Windows Update searcher and the reboot keys (read-only), JSON
#   boot-id           the last boot time (UTC)
#   busy              busy.d\*.ps1 (exit 10 from any = busy)
#   install-security  schtasks /run /tn FleetUpdate-Install-Security   (install.ps1 -Mode security, as SYSTEM)
#   install-all       schtasks /run /tn FleetUpdate-Install-All        (install.ps1 -Mode all, as SYSTEM)
#   result            result.json, written by install.ps1
#   verify            verify.d\*.ps1, docker's state, free disk; JSON
#   reboot            schtasks /run /tn FleetUpdate-Reboot             (shutdown /r /t 60)
#
# The install runs as a scheduled task because the Windows Update installer refuses a network logon.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3

$Dir = $PSScriptRoot
$Verbs = @("status", "busy", "install-security", "install-all", "result", "verify", "reboot", "boot-id")
$Verb = [string]$env:SSH_ORIGINAL_COMMAND

function Refuse {
  [Console]::Error.WriteLine("fleet-update-gate: refused")
  exit 64
}

# Exactly one of the fixed words, compared case-sensitively.
$Known = $false
foreach ($v in $Verbs) { if ($Verb -ceq $v) { $Known = $true } }
if (-not $Known) { Refuse }

# The hooks in a folder (name pattern, files only), each run in-process; one result per hook.
function Invoke-Hooks([string]$Folder) {
  $results = @()
  if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { return , $results }
  foreach ($f in Get-ChildItem -LiteralPath $Folder -File -Filter "*.ps1" | Sort-Object Name) {
    if ($f.Name -notmatch '^[A-Za-z0-9._-]+\.ps1$') { continue }
    $global:LASTEXITCODE = 0
    $out = ""
    try {
      $out = (& $f.FullName 2>&1 | Out-String)
      $code = [int]$global:LASTEXITCODE
    } catch {
      $out = $_.Exception.Message
      $code = 1
    }
    if ($out.Length -gt 1024) { $out = $out.Substring(0, 1024) }
    $results += [ordered]@{ name = $f.Name; ok = ($code -eq 0); exit = $code; out = $out }
  }
  return , $results
}

function Start-FleetTask([string]$Name) {
  & schtasks.exe /run /tn $Name | Out-Null
  if ($LASTEXITCODE -ne 0) { exit 1 }
  Write-Output '{"state":"started"}'
  exit 0
}

if ($Verb -ceq "status") {
  & (Join-Path $Dir "scan.ps1")
  exit $LASTEXITCODE
} elseif ($Verb -ceq "boot-id") {
  $boot = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime
  Write-Output ($boot.ToUniversalTime().ToString("yyyyMMddTHHmmssZ"))
  exit 0
} elseif ($Verb -ceq "busy") {
  $checks = Invoke-Hooks (Join-Path $Dir "busy.d")
  $busy = @($checks | Where-Object { $_.exit -eq 10 }).Count -gt 0
  $failed = @($checks | Where-Object { $_.exit -ne 0 -and $_.exit -ne 10 }).Count -gt 0
  Write-Output (ConvertTo-Json -Compress -Depth 4 ([ordered]@{ v = 1; checks = $checks; busy = $busy }))
  if ($busy) { exit 10 }
  if ($failed) { exit 1 }
  exit 0
} elseif ($Verb -ceq "install-security") {
  Start-FleetTask "FleetUpdate-Install-Security"
} elseif ($Verb -ceq "install-all") {
  Start-FleetTask "FleetUpdate-Install-All"
} elseif ($Verb -ceq "reboot") {
  Start-FleetTask "FleetUpdate-Reboot"
} elseif ($Verb -ceq "result") {
  $file = Join-Path $Dir "result.json"
  if (Test-Path -LiteralPath $file -PathType Leaf) {
    Write-Output (Get-Content -LiteralPath $file -Raw)
  } else {
    Write-Output '{"v":1,"state":"none","startedAt":null,"exitCode":null,"rebootRequired":false,"tail":""}'
  }
  exit 0
} elseif ($Verb -ceq "verify") {
  $checks = Invoke-Hooks (Join-Path $Dir "verify.d")
  $svc = Get-Service -Name docker -ErrorAction SilentlyContinue
  $docker = if ($null -eq $svc) { "absent" } elseif ($svc.Status -eq "Running") { "active" } else { "inactive" }
  $drive = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(":")) -ErrorAction SilentlyContinue
  $free = if ($null -eq $drive) { $null } else { [int][math]::Floor($drive.Free / 1MB) }
  $ok = ($docker -ne "inactive") -and (@($checks | Where-Object { -not $_.ok }).Count -eq 0)
  $doc = [ordered]@{
    v = 1; system = ""; failedUnits = @(); docker = $docker; mounts = @(); freeDiskMb = $free
    xcodePlatforms = $null; checks = $checks; ok = $ok
  }
  Write-Output (ConvertTo-Json -Compress -Depth 4 $doc)
  if ($ok) { exit 0 } else { exit 1 }
}
Refuse
