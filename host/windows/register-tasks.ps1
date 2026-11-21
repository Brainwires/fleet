# register-tasks.ps1: one-time setup on a Windows host, in an elevated PowerShell (docs/updates.md).
# Creates C:\ProgramData\FleetUpdate (SYSTEM and Administrators only), copies the scripts there and
# registers the three on-demand SYSTEM tasks the gate starts. No trigger: they run only when the
# gate asks. Run it from the folder holding gate.ps1, scan.ps1 and install.ps1.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3

$d = "C:\ProgramData\FleetUpdate"
New-Item -ItemType Directory $d -Force | Out-Null
New-Item -ItemType Directory (Join-Path $d "busy.d") -Force | Out-Null
New-Item -ItemType Directory (Join-Path $d "verify.d") -Force | Out-Null
& icacls.exe $d /inheritance:r /grant "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
Copy-Item (Join-Path $PSScriptRoot "gate.ps1"), (Join-Path $PSScriptRoot "scan.ps1"), (Join-Path $PSScriptRoot "install.ps1") $d -Force

$ps = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $d\install.ps1 -Mode"
$sys = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask "FleetUpdate-Install-Security" -Principal $sys -Settings $settings -Force `
  -Action (New-ScheduledTaskAction -Execute "powershell.exe" -Argument "$ps security") | Out-Null
Register-ScheduledTask "FleetUpdate-Install-All" -Principal $sys -Settings $settings -Force `
  -Action (New-ScheduledTaskAction -Execute "powershell.exe" -Argument "$ps all") | Out-Null
Register-ScheduledTask "FleetUpdate-Reboot" -Principal $sys -Settings $settings -Force `
  -Action (New-ScheduledTaskAction -Execute "shutdown.exe" -Argument '/r /t 60 /c "fleet-update"') | Out-Null
Write-Output "Registered FleetUpdate-Install-Security, FleetUpdate-Install-All and FleetUpdate-Reboot."
