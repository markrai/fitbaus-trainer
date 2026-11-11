# SPDX-License-Identifier: AGPL-3.0-only
# Offline checks for native-resistance-actuation.ps1. No USB; HTTP only to a local fake bridge.

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "native-resistance-actuation.ps1"
$failures = 0

function Assert-True($cond, $msg) {
    if (-not $cond) {
        Write-Host "FAIL $msg"
        $script:failures += 1
    }
    else {
        Write-Host "PASS $msg"
    }
}

function Invoke-Actuation([string[]]$ScriptArgs) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell.exe"
    $argList = @("-NoProfile", "-File", $script) + $ScriptArgs
    $psi.Arguments = ($argList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join " "
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd() + $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return [pscustomobject]@{
        ExitCode = $p.ExitCode
        Output   = $out
    }
}

$none = Invoke-Actuation @()
Assert-True ($none.ExitCode -ne 0) "refuses without flags"
Assert-True ($none.Output -match "IConfirmBikeIdle") "names idle confirmation"

$idleOnly = Invoke-Actuation @("-IConfirmBikeIdle")
Assert-True ($idleOnly.ExitCode -ne 0) "refuses with only idle confirmation"
Assert-True ($idleOnly.Output -match "IConfirmSteadyPedaling") "names pedaling confirmation"

$two = Invoke-Actuation @("-IConfirmBikeIdle", "-IConfirmSteadyPedaling")
Assert-True ($two.ExitCode -ne 0) "refuses without write approval"
Assert-True ($two.Output -match "IApproveSingleResistanceWrite") "names write approval"

$dry = Invoke-Actuation @(
    "-IConfirmBikeIdle",
    "-IConfirmSteadyPedaling",
    "-IApproveSingleResistanceWrite",
    "-OfflineDryRun"
)
Assert-True ($dry.ExitCode -eq 0) "dry-run exits 0 with all flags"
Assert-True ($dry.Output -match "no HTTP") "dry-run does not send HTTP"

$noToken = Invoke-Actuation @(
    "-IConfirmBikeIdle",
    "-IConfirmSteadyPedaling",
    "-IApproveSingleResistanceWrite",
    "-BaseUrl",
    "http://127.0.0.1:9"
)
Assert-True ($noToken.ExitCode -ne 0) "refuses live run without pairing token"
Assert-True ($noToken.Output -match "PairingToken") "names pairing token"

$badToken = Invoke-Actuation @(
    "-IConfirmBikeIdle",
    "-IConfirmSteadyPedaling",
    "-IApproveSingleResistanceWrite",
    "-BaseUrl",
    "http://127.0.0.1:9",
    "-PairingToken",
    "abc"
)
Assert-True ($badToken.ExitCode -ne 0) "refuses malformed pairing token"
Assert-True ($badToken.Output -match "PairingToken") "names malformed pairing token"

$fakeBridge = Join-Path $PSScriptRoot "native-resistance-actuation-fake-bridge.mjs"
$fakeToken = "XB5G5132"

function Invoke-Scenario([string]$Scenario) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "node"
    $psi.Arguments = ('"{0}" --scenario {1} --token {2}' -f $fakeBridge, $Scenario, $fakeToken)
    $psi.RedirectStandardOutput = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $node = [Diagnostics.Process]::Start($psi)
    try {
        $line = $node.StandardOutput.ReadLine()
        if ($line -notmatch '^LISTENING (\d+)$') { throw "fake bridge did not start: $line" }
        $url = "http://127.0.0.1:" + $Matches[1]
        $run = Invoke-Actuation @(
            "-IConfirmBikeIdle",
            "-IConfirmSteadyPedaling",
            "-IApproveSingleResistanceWrite",
            "-BaseUrl", $url,
            "-PairingToken", $fakeToken,
            "-SampleIntervalMs", "50"
        )
        $posts = @(Invoke-RestMethod -Uri ($url + "/__posts") -TimeoutSec 5)
        return [pscustomobject]@{
            ExitCode = $run.ExitCode
            Output   = $run.Output
            Levels   = (@($posts | ForEach-Object { $_.level }) -join ",")
            Statuses = (@($posts | ForEach-Object { $_.status }) -join ",")
        }
    }
    finally {
        if (-not $node.HasExited) { $node.Kill() }
    }
}

function Assert-Scenario([string]$Scenario, [int]$ExitCode, [string]$Levels, [string[]]$Patterns) {
    $r = Invoke-Scenario $Scenario
    $detail = "exit=$($r.ExitCode) posts=[$($r.Levels)] statuses=[$($r.Statuses)]"
    Assert-True ($r.ExitCode -eq $ExitCode) "$Scenario exits $ExitCode ($detail)"
    Assert-True ($r.Levels -eq $Levels) "$Scenario sends exactly [$Levels] ($detail)"
    foreach ($p in $Patterns) {
        Assert-True ($r.Output -match $p) "$Scenario output matches '$p'"
    }
    if ($r.ExitCode -ne $ExitCode -or $r.Levels -ne $Levels) {
        Write-Host $r.Output
    }
}

Assert-Scenario "pass" 0 "4,2" @("TELEMETRY_PASS", "restore: confirmed field 2 observed R2", "final observed resistance: R2", "operator confirms the felt")
Assert-Scenario "baseline0" 2 "" @("baseline R0 is outside the test window 1-6", "no write sent")
Assert-Scenario "baselineHigh" 2 "" @("baseline R8 is outside the test window 1-6")
Assert-Scenario "baselineUnstable" 2 "" @("not steady")
Assert-Scenario "baselineStale" 2 "" @("rpm not current", "baseline telemetry is not fresh")
Assert-Scenario "rejected503" 2 "4" @("write not transmitted HTTP 503", "no resistance change was applied")
Assert-Scenario "rejected502Unchanged" 2 "4" @("rejected HTTP 502", "verified unchanged at R2", "write=RejectedVerifiedUnchanged")
Assert-Scenario "rejected502Applied" 3 "4,2" @("rejected HTTP 502", "not verified unchanged \(observed R4", "restore: confirmed", "INCONCLUSIVE")
Assert-Scenario "rejected502Stale" 3 "4,2" @("not verified unchanged \(no fresh field-2 readings\)", "restore: confirmed", "INCONCLUSIVE")
Assert-Scenario "restoreRejectedAfterTransmit" 4 "4,2" @("restore: outcome uncertain HTTP 502", "UNRESOLVED: write=Accepted")
Assert-Scenario "uncertainUnresolved" 4 "4" @("restoration withheld", "UNRESOLVED: write=Unresolved restore=Withheld", "final observed resistance: R2", "do not re-run")
Assert-Scenario "networkTimeout" 4 "4" @("write outcome uncertain HTTP 0", "UNRESOLVED: write=Unresolved restore=Withheld")
Assert-Scenario "uncertainLateDone" 3 "4,2" @("late Done observed", "restore: confirmed", "INCONCLUSIVE")
Assert-Scenario "restoreRejected" 4 "4,2" @("restore: rejected HTTP 503: .*not transmitted", "UNRESOLVED: write=Accepted restore=Rejected", "final observed resistance: R4")
Assert-Scenario "restoreUncertain" 4 "4,2" @("restore: outcome uncertain HTTP 504", "UNRESOLVED: write=Accepted restore=Uncertain")
Assert-Scenario "restoreUnconfirmed" 4 "4,2" @("field 2 not observed at R2", "UNRESOLVED: write=Accepted restore=Unconfirmed", "final observed resistance: R4")
Assert-Scenario "restoreInFlightThenOk" 0 "4,2,2" @("command in flight", "TELEMETRY_PASS")
Assert-Scenario "staleAfterWrite" 3 "4,2" @("watts not current", "INCONCLUSIVE", "restore=Confirmed")
Assert-Scenario "frozenSnapshot" 3 "4,2" @("snapshot not advancing", "INCONCLUSIVE")
Assert-Scenario "staleMetricAge" 3 "4,2" @("resistance stale", "INCONCLUSIVE")
Assert-Scenario "nullWatts" 3 "4,2" @("watts value null", "INCONCLUSIVE")
Assert-Scenario "fieldNotFollowing" 3 "4,2" @("field 2 did not follow R4", "INCONCLUSIVE")
Assert-Scenario "wattsFlat" 3 "4,2" @("did not meet", "INCONCLUSIVE")

if ($failures -gt 0) {
    Write-Error "$failures offline actuation checks failed"
    exit 1
}
Write-Host "native-resistance-actuation offline checks passed"
exit 0
