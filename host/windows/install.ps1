# install.ps1: download and install pending Windows updates with the built-in Windows Update Agent
# COM API, as SYSTEM from the FleetUpdate-Install-* scheduled tasks (the installer refuses a
# network logon, so ssh only starts the task). Writes result.json beside itself
# (lib/updates/model.ts parseResultDoc): {"state":"running|succeeded|failed","startedAt":<epoch s>,
# "exitCode":<n>,"rebootRequired":<bool>,"tail":"…"}. Never reboots; the gate's `reboot` verb does.
#
#   -Mode security   updates in the "Security Updates" category or with an MSRC severity
#   -Mode all        every update that isn't installed or hidden

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("security", "all")]
  [string]$Mode
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3

$Dir = $PSScriptRoot
$ResultFile = Join-Path $Dir "result.json"
$LockFile = Join-Path $Dir "install.lock"

function Write-Result([string]$State, $ExitCode, [bool]$Reboot, [string]$Tail, [long]$Started) {
  if ($Tail.Length -gt 4000) { $Tail = $Tail.Substring($Tail.Length - 4000) }
  $doc = [ordered]@{
    v = 1; verb = "install-$Mode"; state = $State; startedAt = $Started; exitCode = $ExitCode
    rebootRequired = $Reboot; tail = $Tail
  }
  $tmp = "$ResultFile.tmp"
  Set-Content -LiteralPath $tmp -Value (ConvertTo-Json -Compress -Depth 3 $doc) -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $ResultFile -Force
}

# One install at a time: the lock file is opened exclusively for the whole run.
try {
  $lock = [System.IO.File]::Open($LockFile, "OpenOrCreate", "ReadWrite", "None")
} catch {
  exit 75
}

$started = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$log = New-Object System.Collections.Generic.List[string]
try {
  Write-Result "running" $null $false "" $started
  $session = New-Object -ComObject "Microsoft.Update.Session"
  $found = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0")
  $todo = New-Object -ComObject "Microsoft.Update.UpdateColl"
  for ($i = 0; $i -lt [int]$found.Updates.Count; $i++) {
    $u = $found.Updates.Item($i)
    $security = [bool]$u.MsrcSeverity -or
      (@($u.Categories | Where-Object { [string]$_.Name -eq "Security Updates" }).Count -gt 0)
    if ($Mode -eq "all" -or $security) {
      if (-not $u.EulaAccepted) { $u.AcceptEula() }
      [void]$todo.Add($u)
      $log.Add("selected: $([string]$u.Title)")
    }
  }
  if ([int]$todo.Count -eq 0) {
    $log.Add("nothing to install")
    Write-Result "succeeded" 0 $false ($log -join "`n") $started
    exit 0
  }
  $downloader = $session.CreateUpdateDownloader()
  $downloader.Updates = $todo
  $dl = $downloader.Download()
  $log.Add("download result: $([int]$dl.ResultCode)")
  $installer = $session.CreateUpdateInstaller()
  $installer.Updates = $todo
  $res = $installer.Install()
  # OperationResultCode: 2 succeeded, 3 succeeded with errors, 4 failed, 5 aborted.
  $rc = [int]$res.ResultCode
  $log.Add("install result: $rc")
  $code = if ($rc -eq 2) { 0 } else { $rc }
  $state = if ($rc -eq 2) { "succeeded" } else { "failed" }
  Write-Result $state $code ([bool]$res.RebootRequired) ($log -join "`n") $started
  exit $code
} catch {
  $log.Add("error: $($_.Exception.Message)")
  Write-Result "failed" 1 $false ($log -join "`n") $started
  exit 1
} finally {
  $lock.Close()
}
