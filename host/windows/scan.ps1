# scan.ps1: the pending Windows updates and the reboot flags, read-only, as one JSON document
# (lib/updates/collect-windows.ts). Uses the built-in Windows Update Agent COM API only (no module
# is installed); runs as the ssh user through gate.ps1's `status` verb.
#
# {"os":"windows","updates":[{"title","kb","categories":[…],"msrcSeverity"}],"rebootRequired":<bool>,
#  "rebootPending":<bool>,"pendingFileRename":<bool>}

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3

$MaxUpdates = 200
$updates = @()
$searchError = $null
try {
  $session = New-Object -ComObject "Microsoft.Update.Session"
  $searcher = $session.CreateUpdateSearcher()
  $found = $searcher.Search("IsInstalled=0 and IsHidden=0")
  $n = [math]::Min([int]$found.Updates.Count, $MaxUpdates)
  for ($i = 0; $i -lt $n; $i++) {
    $u = $found.Updates.Item($i)
    $kb = @($u.KBArticleIDs | ForEach-Object { [string]$_ }) | Select-Object -First 1
    $categories = @($u.Categories | ForEach-Object { [string]$_.Name })
    $updates += [ordered]@{
      title = [string]$u.Title
      kb = if ($kb) { [string]$kb } else { "" }
      categories = $categories
      msrcSeverity = if ($u.MsrcSeverity) { [string]$u.MsrcSeverity } else { "" }
    }
  }
} catch {
  $searchError = $_.Exception.Message
}

$wu = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired"
$cbs = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending"
$sm = "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager"
$rename = $false
try {
  $p = Get-ItemProperty -LiteralPath $sm -Name PendingFileRenameOperations -ErrorAction Stop
  $rename = @($p.PendingFileRenameOperations | Where-Object { $_ }).Count -gt 0
} catch {
  $rename = $false
}

$doc = [ordered]@{
  v = 1
  os = "windows"
  updates = $updates
  rebootRequired = [bool](Test-Path -LiteralPath $wu)
  rebootPending = [bool](Test-Path -LiteralPath $cbs)
  pendingFileRename = $rename
}
if ($null -ne $searchError) { $doc.error = $searchError }
Write-Output (ConvertTo-Json -Compress -Depth 5 $doc)
if ($null -ne $searchError) { exit 1 }
exit 0
