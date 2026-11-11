# SPDX-License-Identifier: AGPL-3.0-only
# One bounded native resistance write to prove mechanical load change.
# Does not start iFIT, does not send VerifySecurity, does not change HOME.
# HTTP 200 is not a pass. Pass requires field 2 to follow, watts change at held RPM,
# confirmed restoration of the baseline, and operator confirmation of the felt load change.
#
# Required:
#   -IConfirmBikeIdle
#   -IConfirmSteadyPedaling
#   -IApproveSingleResistanceWrite
#   -PairingToken
#
# Bounds: observed baseline must be steady within 1-6; one write of delta 2 within 1-6.
# The original write is never resent. Restoration is only attempted once the write is terminal.
# HTTP 503 means not transmitted; 502 means the bike rejected a transmitted write (state unverified).
# Exit: 0 telemetry pass and restore confirmed; 2 no change applied or verified unchanged;
#       3 inconclusive and restore confirmed; 4 unresolved, operator intervention required.

[CmdletBinding()]
param(
    [string]$BaseUrl = "http://192.168.1.226:8765",
    [string]$PairingToken = "",
    [switch]$IConfirmBikeIdle,
    [switch]$IConfirmSteadyPedaling,
    [switch]$IApproveSingleResistanceWrite,
    [switch]$OfflineDryRun,
    [ValidateRange(50, 1000)]
    [int]$SampleIntervalMs = 1000
)

$ErrorActionPreference = "Stop"
$MinRpm = 40
$SafeMin = 1
$SafeMax = 6
$Delta = 2
$BaselineSamples = 5
$ObserveSamples = 8
$MinFollowSamples = 3
$WattsRatio = 1.15
$RpmHoldRatio = 0.15
$MaxMetricAgeMs = 3000
$ResolveWindowSec = 10
$RestoreConfirmSec = 6
$FinalReadSec = 3
$RestoreInFlightRetries = 3

function Log([string]$msg) {
    Write-Host ("[{0}] {1}" -f ([datetime]::UtcNow.ToString("HH:mm:ss"), $msg))
}

function Fail([string]$msg) {
    throw $msg
}

if (-not $IConfirmBikeIdle) {
    Fail @"
Refusing actuation without idle confirmation.
Re-run with -IConfirmBikeIdle after verifying it is safe to change load.
"@
}
if (-not $IConfirmSteadyPedaling) {
    Fail @"
Mechanical proof requires steady pedaling.
Re-run with -IConfirmSteadyPedaling after holding a steady cadence.
"@
}
if (-not $IApproveSingleResistanceWrite) {
    Fail @"
Refusing live resistance mutation without explicit approval.
Re-run with -IApproveSingleResistanceWrite to send one bounded field-2 write.
"@
}

if ($OfflineDryRun) {
    Log "offline dry-run: flags accepted; no HTTP and no USB write"
    exit 0
}

$token = ($PairingToken -replace '[\s-]', '').ToUpperInvariant()
if ($token -cnotmatch '^[0-9A-Z]{8}$') {
    Fail "An 8-character -PairingToken from the Bike Bridge pairing screen is required."
}

$origin = $BaseUrl.TrimEnd("/")
$pollMs = [math]::Min(500, $SampleIntervalMs)

function Get-Json([string]$Path) {
    Invoke-RestMethod -Method Get -Uri ($origin + $Path) -TimeoutSec 5
}

function Post-Resistance([int]$Level) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($origin + "/api/v1/resistance") `
            -ContentType "application/json" -Headers @{ "X-Fitbaus-Token" = $token } `
            -Body ("{`"value`":$Level}") -TimeoutSec 5
        return [pscustomobject]@{ StatusCode = [int]$r.StatusCode; Content = [string]$r.Content }
    }
    catch {
        $response = $_.Exception.Response
        if ($null -eq $response) {
            return [pscustomobject]@{ StatusCode = 0; Content = $_.Exception.Message }
        }
        $body = ""
        if ($null -ne $_.ErrorDetails -and -not [string]::IsNullOrEmpty($_.ErrorDetails.Message)) {
            $body = $_.ErrorDetails.Message
        }
        else {
            try {
                $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
                $body = $reader.ReadToEnd()
            }
            catch {
            }
        }
        return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Content = $body }
    }
}

function Test-DefinitelyNotApplied([int]$StatusCode) {
    return $StatusCode -in @(400, 401, 404, 503)
}

function To-Instant($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return [DateTimeOffset]::new($Value.ToUniversalTime()) }
    $parsed = [DateTimeOffset]::MinValue
    $ok = [DateTimeOffset]::TryParse(
        [string]$Value,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal,
        [ref]$parsed
    )
    if ($ok) { return $parsed.ToUniversalTime() }
    return $null
}

function Test-Newer($Candidate, $Reference) {
    if ($null -eq $Candidate) { return $false }
    if ($null -eq $Reference) { return $true }
    return $Candidate -gt $Reference
}

function Median([double[]]$Values) {
    $sorted = @($Values | Sort-Object)
    if ($sorted.Count -eq 0) { return $null }
    $mid = [int][math]::Floor(($sorted.Count - 1) / 2)
    if ($sorted.Count % 2 -eq 1) { return [double]$sorted[$mid] }
    return ([double]$sorted[$mid] + [double]$sorted[$mid + 1]) / 2.0
}

$script:lastValidResistance = $null

function Read-Sample($PreviousAt) {
    try {
        $t = Get-Json "/api/v1/telemetry"
    }
    catch {
        return [pscustomobject]@{ Valid = $false; Reason = "telemetry unreachable: " + $_.Exception.Message }
    }
    $reasons = @()
    if (-not ($t.connected -eq $true -and $t.initialized -eq $true)) { $reasons += "bridge not connected/initialized" }
    $at = To-Instant $t.snapshotAt
    if ($null -eq $at) {
        $reasons += "snapshotAt missing"
    }
    elseif ($null -ne $PreviousAt -and $at -le $PreviousAt) {
        $reasons += "snapshot not advancing"
    }
    foreach ($name in @("rpm", "watts", "resistance")) {
        $m = $t.$name
        if ($null -eq $m -or $m.current -ne $true) {
            $reasons += "$name not current"
            continue
        }
        if ($null -eq $m.value) {
            $reasons += "$name value null"
            continue
        }
        $observedAt = To-Instant $m.observedAt
        if ($null -eq $observedAt -or $null -eq $at) {
            $reasons += "$name observedAt missing"
            continue
        }
        $age = ($at - $observedAt).TotalMilliseconds
        if ($age -lt 0 -or $age -gt $MaxMetricAgeMs) {
            $reasons += ("{0} stale ({1:N0} ms)" -f $name, $age)
        }
    }
    $valid = $reasons.Count -eq 0
    $sample = [pscustomobject]@{
        Valid        = $valid
        Reason       = ($reasons -join "; ")
        Rpm          = if ($valid) { [double]$t.rpm.value } else { $null }
        Watts        = if ($valid) { [double]$t.watts.value } else { $null }
        Resistance   = if ($valid) { [int]$t.resistance.value } else { $null }
        SnapshotAt   = $at
        ResistanceAt = if ($valid) { To-Instant $t.resistance.observedAt } else { $null }
    }
    if ($valid) { $script:lastValidResistance = $sample.Resistance }
    return $sample
}

function Collect-Samples([int]$Count, [string]$Label) {
    $rows = @()
    $previousAt = $null
    for ($i = 0; $i -lt $Count; $i++) {
        $s = Read-Sample $previousAt
        if ($s.Valid) {
            Log ("{0} rpm={1} W={2} R={3}" -f $Label, $s.Rpm, $s.Watts, $s.Resistance)
            $previousAt = $s.SnapshotAt
        }
        else {
            Log ("{0} INVALID: {1}" -f $Label, $s.Reason)
        }
        $rows += $s
        if ($i -lt $Count - 1) { Start-Sleep -Milliseconds $SampleIntervalMs }
    }
    return $rows
}

function Resolve-UncertainWrite([int]$Target, $PriorRequestedAt) {
    $deadline = [datetime]::UtcNow.AddSeconds($ResolveWindowSec)
    while ([datetime]::UtcNow -lt $deadline) {
        try {
            $st = Get-Json "/api/v1/status"
            $requestedAt = To-Instant $st.resistance.requestedAt
            if ($st.resistance.requested -eq $Target -and (Test-Newer $requestedAt $PriorRequestedAt)) {
                return $true
            }
        }
        catch {
        }
        Start-Sleep -Milliseconds $pollMs
    }
    return $false
}

function Confirm-Observed([int]$Level, $AfterInstant, [int]$WindowSec) {
    $deadline = [datetime]::UtcNow.AddSeconds($WindowSec)
    $last = $null
    while ([datetime]::UtcNow -lt $deadline) {
        $s = Read-Sample $null
        if ($s.Valid -and (Test-Newer $s.ResistanceAt $AfterInstant)) {
            $last = $s.Resistance
            if ($s.Resistance -eq $Level) {
                return [pscustomobject]@{ Confirmed = $true; Observed = $s.Resistance }
            }
        }
        Start-Sleep -Milliseconds $pollMs
    }
    return [pscustomobject]@{ Confirmed = $false; Observed = $last }
}

function Confirm-Unchanged([int]$Level) {
    $deadline = [datetime]::UtcNow.AddSeconds($ResolveWindowSec)
    $reference = $null
    $seen = @()
    while ([datetime]::UtcNow -lt $deadline -and $seen.Count -lt $MinFollowSamples) {
        $s = Read-Sample $null
        if ($s.Valid) {
            if ($null -eq $reference) {
                $reference = $s.SnapshotAt
            }
            elseif (Test-Newer $s.ResistanceAt $reference) {
                if ($seen.Count -eq 0 -or (Test-Newer $s.ResistanceAt $seen[-1].ResistanceAt)) { $seen += $s }
            }
        }
        Start-Sleep -Milliseconds $pollMs
    }
    $other = @($seen | Where-Object { $_.Resistance -ne $Level })
    $detail = if ($seen.Count -eq 0) { "no fresh field-2 readings" } else { "observed " + (($seen | ForEach-Object { "R" + $_.Resistance }) -join ",") }
    return [pscustomobject]@{
        Unchanged = ($seen.Count -ge $MinFollowSamples -and $other.Count -eq 0)
        Count     = $seen.Count
        Detail    = $detail
    }
}

function Restore-Baseline([int]$Level) {
    for ($attempt = 1; $attempt -le $RestoreInFlightRetries; $attempt++) {
        Log ("stop: restoring baseline R{0}" -f $Level)
        $resp = Post-Resistance $Level
        if ($resp.StatusCode -eq 200) {
            $doneAt = $null
            try {
                $st = Get-Json "/api/v1/status"
                if ($st.resistance.requested -eq $Level) { $doneAt = To-Instant $st.resistance.requestedAt }
            }
            catch {
            }
            if ($null -eq $doneAt) {
                Log "restore: HTTP 200 but bridge status does not show the restore request"
                return "Unconfirmed"
            }
            $seen = Confirm-Observed $Level $doneAt $RestoreConfirmSec
            if ($seen.Confirmed) {
                Log ("restore: confirmed field 2 observed R{0}" -f $seen.Observed)
                return "Confirmed"
            }
            Log ("restore: HTTP 200 but field 2 not observed at R{0} (last fresh observation: {1})" -f $Level, $(if ($null -eq $seen.Observed) { "none" } else { "R" + $seen.Observed }))
            return "Unconfirmed"
        }
        if ($resp.StatusCode -eq 503 -and $resp.Content -match "in flight" -and $attempt -lt $RestoreInFlightRetries) {
            Log "restore: bridge reports a command in flight (not transmitted); retrying restore"
            Start-Sleep -Milliseconds 500
            continue
        }
        if (Test-DefinitelyNotApplied $resp.StatusCode) {
            Log ("restore: rejected HTTP {0}: {1}" -f $resp.StatusCode, $resp.Content)
            return "Rejected"
        }
        Log ("restore: outcome uncertain HTTP {0}: {1}" -f $resp.StatusCode, $resp.Content)
        return "Uncertain"
    }
    return "Rejected"
}

$writeState = "NotSent"
$mechanical = $null
$restoreState = "NotNeeded"
$failure = $null
$target = $null
$r0 = $null

try {
    $status = Get-Json "/api/v1/status"
    if (-not $status.resistanceControlAvailable) {
        Fail "native resistanceControlAvailable is false. Rebuild/install the native APK that includes the field-2 write path, then launch Native Bridge. HTTP acceptance without USB write is not enabled."
    }
    if (-not $status.connected -or -not $status.initialized) {
        Fail "native bridge is not connected/initialized"
    }

    $baseline = @(Collect-Samples $BaselineSamples "baseline")
    $invalidBaseline = @($baseline | Where-Object { -not $_.Valid })
    if ($invalidBaseline.Count -gt 0) {
        Fail ("baseline telemetry is not fresh/current ({0} of {1} samples invalid); no write sent" -f $invalidBaseline.Count, $baseline.Count)
    }
    $levels = @($baseline | ForEach-Object { $_.Resistance } | Sort-Object -Unique)
    if ($levels.Count -ne 1) {
        Fail ("baseline resistance was not steady (observed {0}); no write sent" -f ($levels -join ","))
    }
    $r0 = [int]$levels[0]
    if ($r0 -lt $SafeMin -or $r0 -gt $SafeMax) {
        Fail ("observed baseline R{0} is outside the test window {1}-{2}; set the console to R{1}-R{2} and re-run; no write sent" -f $r0, $SafeMin, $SafeMax)
    }
    $rpm0 = Median (@($baseline | ForEach-Object { $_.Rpm }))
    $watts0 = Median (@($baseline | ForEach-Object { $_.Watts }))
    if ($rpm0 -lt $MinRpm) {
        Fail ("baseline median RPM {0} is below {1}; hold a steady cadence; no write sent" -f $rpm0, $MinRpm)
    }

    $target = $r0 + $Delta
    if ($target -gt $SafeMax) { $target = $r0 - $Delta }
    if ($target -lt $SafeMin -or $target -gt $SafeMax -or $target -eq $r0) {
        Fail ("could not choose a safe target from observed R{0} within {1}-{2}; no write sent" -f $r0, $SafeMin, $SafeMax)
    }

    $priorRequestedAt = To-Instant (Get-Json "/api/v1/status").resistance.requestedAt
    Log ("commanding R{0} -> R{1} (one field-2 write)" -f $r0, $target)
    $writeState = "Unresolved"
    $resp = Post-Resistance $target
    if ($resp.StatusCode -eq 200) {
        $writeState = "Accepted"
    }
    elseif (Test-DefinitelyNotApplied $resp.StatusCode) {
        $writeState = "NotApplied"
        Fail ("write not transmitted HTTP {0}: {1}" -f $resp.StatusCode, $resp.Content)
    }
    elseif ($resp.StatusCode -eq 502) {
        $writeState = "RejectedAfterTransmit"
        Log ("write reached the bike but was rejected HTTP 502: {0}; verifying field 2 without resending" -f $resp.Content)
        $check = Confirm-Unchanged $r0
        if ($check.Unchanged) {
            $writeState = "RejectedVerifiedUnchanged"
            Fail ("bike rejected the write; field 2 verified unchanged at R{0} across {1} fresh readings" -f $r0, $check.Count)
        }
        Fail ("bike rejected the write but field 2 is not verified unchanged ({0}); restoring baseline" -f $check.Detail)
    }
    else {
        Log ("write outcome uncertain HTTP {0}: {1}; waiting up to {2}s for a terminal Done without resending" -f $resp.StatusCode, $resp.Content, $ResolveWindowSec)
        if (Resolve-UncertainWrite $target $priorRequestedAt) {
            $writeState = "Accepted"
            $mechanical = "write outcome was uncertain at the caller; late Done observed; no mechanical evidence collected"
            Log ("write resolved: bridge reports Done for R{0} after the caller timeout" -f $target)
        }
        else {
            Fail "write outcome unresolved: no terminal Done observed; restoration withheld to avoid racing an in-flight write"
        }
    }

    if ($null -eq $mechanical) {
        $st = Get-Json "/api/v1/status"
        $doneAt = To-Instant $st.resistance.requestedAt
        Log "protocol: USB Done for requested $target"
        $after = @(Collect-Samples $ObserveSamples "after")
        $invalidAfter = @($after | Where-Object { -not $_.Valid })
        $follow = @($after | Where-Object { $_.Valid -and (Test-Newer $_.ResistanceAt $doneAt) })
        if ($st.resistance.requested -ne $target -or $null -eq $doneAt) {
            $mechanical = "bridge status does not show the accepted request"
        }
        elseif ($invalidAfter.Count -gt 0) {
            $mechanical = ("{0} of {1} observation samples were stale/invalid ({2})" -f $invalidAfter.Count, $after.Count, (($invalidAfter | ForEach-Object { $_.Reason } | Sort-Object -Unique) -join " | "))
        }
        elseif ($follow.Count -lt $MinFollowSamples) {
            $mechanical = ("only {0} fresh field-2 readings after Done; need {1}" -f $follow.Count, $MinFollowSamples)
        }
        elseif (@($follow | Where-Object { $_.Resistance -ne $target }).Count -gt 0) {
            $mechanical = ("field 2 did not follow R{0} (observed {1})" -f $target, (($follow | ForEach-Object { $_.Resistance } | Sort-Object -Unique) -join ","))
        }
        else {
            $rpm1 = Median (@($follow | ForEach-Object { $_.Rpm }))
            $watts1 = Median (@($follow | ForEach-Object { $_.Watts }))
            $rpmDelta = [math]::Abs($rpm1 - $rpm0) / [math]::Max($rpm0, 1)
            $increased = $target -gt $r0
            $moved = if ($increased) { $watts1 -ge ($watts0 * $WattsRatio) } else { $watts1 -le ($watts0 / $WattsRatio) }
            if ($rpm1 -lt $MinRpm) {
                $mechanical = ("cadence dropped to median RPM {0}" -f $rpm1)
            }
            elseif ($rpmDelta -gt $RpmHoldRatio) {
                $mechanical = ("RPM changed by {0:P0}" -f $rpmDelta)
            }
            elseif (-not $moved) {
                $mechanical = ("watts {0} -> {1} at RPM {2} -> {3} did not meet the {4:P0} threshold" -f $watts0, $watts1, $rpm0, $rpm1, ($WattsRatio - 1))
            }
            else {
                $mechanical = "Pass"
                Log ("telemetry: field 2 followed R{0}; watts {1} -> {2} at held RPM {3} -> {4}" -f $target, $watts0, $watts1, $rpm0, $rpm1)
            }
        }
    }
}
catch {
    $failure = $_.Exception.Message
    Log ("FAIL: " + $failure)
}
finally {
    if ($writeState -eq "Accepted" -or $writeState -eq "RejectedAfterTransmit") {
        try {
            $restoreState = Restore-Baseline $r0
        }
        catch {
            $restoreState = "Uncertain"
            Log ("restore: exception " + $_.Exception.Message)
        }
    }
    elseif ($writeState -eq "Unresolved") {
        $restoreState = "Withheld"
    }
}

$final = $null
$finalDeadline = [datetime]::UtcNow.AddSeconds($FinalReadSec)
while ([datetime]::UtcNow -lt $finalDeadline) {
    $s = Read-Sample $null
    if ($s.Valid) {
        $final = $s
        break
    }
    Start-Sleep -Milliseconds $pollMs
}
if ($null -ne $final) {
    Log ("final observed resistance: R{0} (fresh at {1:o})" -f $final.Resistance, $final.SnapshotAt)
}
else {
    Log ("final observed resistance: unknown (no fresh telemetry); last fresh observation: {0}" -f $(if ($null -eq $script:lastValidResistance) { "none" } else { "R" + $script:lastValidResistance }))
}

$unresolved = $writeState -eq "Unresolved" -or $restoreState -in @("Rejected", "Unconfirmed", "Uncertain")
if ($unresolved) {
    Log ("UNRESOLVED: write={0} restore={1}{2}" -f $writeState, $restoreState, $(if ($null -ne $target) { "; commanded R$target from baseline R$r0" } else { "" }))
    Log "operator: stop pedaling; do not re-run this script; check the console resistance display and use the console keys to return to the baseline; then check GET /api/v1/status"
    exit 4
}
if ($writeState -in @("NotSent", "NotApplied", "RejectedVerifiedUnchanged")) {
    Log ("FAIL: no resistance change was applied (write={0})" -f $writeState)
    exit 2
}
if ($mechanical -eq "Pass" -and $restoreState -eq "Confirmed") {
    Log ("TELEMETRY_PASS: R{0} -> R{1} followed, watts moved at held RPM, baseline R{0} restored and confirmed. Not accepted until the operator confirms the felt pedal load change." -f $r0, $target)
    exit 0
}
$reason = if ($null -ne $mechanical) { $mechanical } elseif ($null -ne $failure) { $failure } else { "no mechanical evidence" }
Log ("INCONCLUSIVE: {0}; restore={1}" -f $reason, $restoreState)
exit 3
