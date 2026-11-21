# Pester 5 tests for gate.ps1, scan.ps1 and install.ps1 with a fake Windows Update COM object and a
# fake schtasks.exe; nothing touches Windows Update, the registry or the task scheduler.
# Run on a Windows host or lab VM: Invoke-Pester host/windows/tests

BeforeAll {
  $Src = Split-Path -Parent $PSScriptRoot

  function New-FakeUpdate([string]$Title, [string[]]$Categories, [string]$Severity, [string]$Kb) {
    $u = [pscustomobject]@{
      Title = $Title
      KBArticleIDs = @($Kb)
      Categories = @($Categories | ForEach-Object { [pscustomobject]@{ Name = $_ } })
      MsrcSeverity = $Severity
      EulaAccepted = $true
    }
    $u | Add-Member -MemberType ScriptMethod -Name AcceptEula -Value { $this.EulaAccepted = $true }
    return $u
  }

  function New-FakeCollection([object[]]$Items) {
    $list = New-Object System.Collections.ArrayList
    foreach ($i in $Items) { [void]$list.Add($i) }
    $c = [pscustomobject]@{ List = $list }
    $c | Add-Member -MemberType ScriptProperty -Name Count -Value { $this.List.Count }
    $c | Add-Member -MemberType ScriptMethod -Name Item -Value { param($i) $this.List[$i] }
    $c | Add-Member -MemberType ScriptMethod -Name Add -Value { param($u) $this.List.Add($u) }
    return $c
  }

  function New-FakeSession([object[]]$Updates, [int]$InstallCode = 2, [bool]$Reboot = $false) {
    $s = [pscustomobject]@{ Updates = $Updates; InstallCode = $InstallCode; Reboot = $Reboot }
    $s | Add-Member -MemberType ScriptMethod -Name CreateUpdateSearcher -Value {
      $ups = $this.Updates
      $searcher = [pscustomobject]@{ Ups = $ups; Criteria = $null }
      $searcher | Add-Member -MemberType ScriptMethod -Name Search -Value {
        param($criteria)
        $script:SearchCriteria = $criteria
        [pscustomobject]@{ Updates = (New-FakeCollection $this.Ups) }
      }
      $searcher
    }
    $s | Add-Member -MemberType ScriptMethod -Name CreateUpdateDownloader -Value {
      $d = [pscustomobject]@{ Updates = $null }
      $d | Add-Member -MemberType ScriptMethod -Name Download -Value {
        $script:Downloaded = $this.Updates.Count
        [pscustomobject]@{ ResultCode = 2 }
      }
      $d
    }
    $code = $InstallCode
    $reboot = $Reboot
    $s | Add-Member -MemberType ScriptMethod -Name CreateUpdateInstaller -Value {
      $i = [pscustomobject]@{ Updates = $null; Code = $this.InstallCode; Reboot = $this.Reboot }
      $i | Add-Member -MemberType ScriptMethod -Name Install -Value {
        $script:Installed = @($this.Updates.List | ForEach-Object { $_.Title })
        [pscustomobject]@{ ResultCode = $this.Code; RebootRequired = $this.Reboot }
      }
      $i
    }
    return $s
  }

  $Ups = @(
    (New-FakeUpdate "2026-11 Cumulative Update" @("Security Updates") "Critical" "5050001"),
    (New-FakeUpdate "Defender definitions" @("Definition Updates") "" "2267602"),
    (New-FakeUpdate "Driver update" @("Drivers") "" "")
  )
}

Describe "gate.ps1" {
  BeforeEach {
    $work = Join-Path $TestDrive ([guid]::NewGuid())
    New-Item -ItemType Directory $work | Out-Null
    Copy-Item (Join-Path $Src "*.ps1") $work
    $Gate = Join-Path $work "gate.ps1"
    $script:Tasks = @()
    function global:schtasks.exe { $script:Tasks += , @($args); $global:LASTEXITCODE = 0 }
  }
  AfterEach { Remove-Item function:global:schtasks.exe -ErrorAction SilentlyContinue }

  It "runs exactly its task for <verb>" -ForEach @(
    @{ verb = "install-security"; task = "FleetUpdate-Install-Security" },
    @{ verb = "install-all"; task = "FleetUpdate-Install-All" },
    @{ verb = "reboot"; task = "FleetUpdate-Reboot" }
  ) {
    $env:SSH_ORIGINAL_COMMAND = $verb
    $null = & $Gate
    $LASTEXITCODE | Should -Be 0
    $script:Tasks.Count | Should -Be 1
    ($script:Tasks[0] -join " ") | Should -Be "/run /tn $task"
  }

  It "refuses <cmd> with 64 and runs nothing" -ForEach @(
    @{ cmd = "" }, @{ cmd = "STATUS" }, @{ cmd = "status " }, @{ cmd = "install-all; calc" },
    @{ cmd = "reboot`nreboot" }, @{ cmd = '$(calc)' }, @{ cmd = "install-all & schtasks /delete" },
    @{ cmd = "powershell -c whoami" }
  ) {
    $env:SSH_ORIGINAL_COMMAND = $cmd
    $null = & $Gate 2>$null
    $LASTEXITCODE | Should -Be 64
    $script:Tasks.Count | Should -Be 0
  }

  It "answers result with the none document before any install" {
    $env:SSH_ORIGINAL_COMMAND = "result"
    $out = & $Gate
    ($out | ConvertFrom-Json).state | Should -Be "none"
  }
}

Describe "scan.ps1" {
  It "lists the updates with their categories and severity, and the reboot flags" {
    Mock New-Object -ParameterFilter { $ComObject -eq "Microsoft.Update.Session" } { New-FakeSession $Ups }
    Mock Test-Path -ParameterFilter { $LiteralPath -like "*RebootRequired" } { $true }
    Mock Test-Path -ParameterFilter { $LiteralPath -like "*RebootPending" } { $false }
    Mock Get-ItemProperty { throw "absent" }
    $doc = & (Join-Path $Src "scan.ps1") | ConvertFrom-Json
    $doc.os | Should -Be "windows"
    @($doc.updates).Count | Should -Be 3
    $doc.updates[0].kb | Should -Be "5050001"
    $doc.updates[0].msrcSeverity | Should -Be "Critical"
    $doc.rebootRequired | Should -BeTrue
    $doc.rebootPending | Should -BeFalse
    $doc.pendingFileRename | Should -BeFalse
    $script:SearchCriteria | Should -Be "IsInstalled=0 and IsHidden=0"
  }
}

Describe "install.ps1" {
  BeforeEach {
    $work = Join-Path $TestDrive ([guid]::NewGuid())
    New-Item -ItemType Directory $work | Out-Null
    Copy-Item (Join-Path $Src "install.ps1") $work
    $Install = Join-Path $work "install.ps1"
    Mock New-Object -ParameterFilter { $ComObject -eq "Microsoft.Update.UpdateColl" } { New-FakeCollection @() }
  }

  It "installs only security updates in security mode" {
    Mock New-Object -ParameterFilter { $ComObject -eq "Microsoft.Update.Session" } { New-FakeSession $Ups }
    & $Install -Mode security
    $script:Installed | Should -Be @("2026-11 Cumulative Update")
    $r = Get-Content (Join-Path $work "result.json") -Raw | ConvertFrom-Json
    $r.state | Should -Be "succeeded"
    $r.exitCode | Should -Be 0
  }

  It "installs everything in all mode and reports the reboot" {
    Mock New-Object -ParameterFilter { $ComObject -eq "Microsoft.Update.Session" } { New-FakeSession $Ups 2 $true }
    & $Install -Mode all
    @($script:Installed).Count | Should -Be 3
    (Get-Content (Join-Path $work "result.json") -Raw | ConvertFrom-Json).rebootRequired | Should -BeTrue
  }

  It "records a failed install" {
    Mock New-Object -ParameterFilter { $ComObject -eq "Microsoft.Update.Session" } { New-FakeSession $Ups 4 }
    & $Install -Mode all
    $LASTEXITCODE | Should -Be 4
    (Get-Content (Join-Path $work "result.json") -Raw | ConvertFrom-Json).state | Should -Be "failed"
  }
}
