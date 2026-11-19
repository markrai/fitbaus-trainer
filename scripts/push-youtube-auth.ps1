param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

try {
    $root = Split-Path -Parent $PSScriptRoot
    $directory = Join-Path $root "secrets\youtube"
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "Create secrets\youtube in the repository root and place one Google OAuth JSON file in it."
    }
    $files = @(Get-ChildItem -LiteralPath $directory -Filter "*.json" -File)
    if ($files.Count -ne 1) {
        throw "Expected exactly one .json file in secrets\youtube; found $($files.Count)."
    }
    if ($files[0].Length -gt 16384) {
        throw "The OAuth JSON file exceeds the 16 KiB import limit."
    }
    try {
        $installed = (Get-Content -LiteralPath $files[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json).installed
    } catch {
        throw "The OAuth file is not valid Google client JSON."
    }
    if ($null -eq $installed -or
        $installed.client_id -notmatch '^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$' -or
        [string]::IsNullOrWhiteSpace($installed.client_secret) -or
        $installed.client_id.Length -gt 256 -or $installed.client_secret.Length -gt 256) {
        throw "The JSON must contain an installed TV OAuth client_id and client_secret."
    }
    if ($files[0].Length -gt 16384) {
        throw "The OAuth JSON file exceeds the 16 KiB import limit."
    }

    $serial = if ($env:FITBAUS_BIKE_ADB) { $env:FITBAUS_BIKE_ADB } else { "192.168.1.226:5555" }
    $package = "com.fitbaus.bikebridge"
    $serialWasSpecified = $false
    foreach ($argument in $Arguments) {
        if ($argument -ieq "staging") {
            $package = "com.fitbaus.bikebridge.native"
        } elseif ($argument -ieq "production") {
            $package = "com.fitbaus.bikebridge"
        } elseif (-not $serialWasSpecified) {
            $serial = $argument
            $serialWasSpecified = $true
        } else {
            throw "Usage: push_youtube_auth.bat [bike-ip[:port]] [production|staging]"
        }
    }
    if ($serial -notmatch '^[A-Za-z0-9.:-]+$') {
        throw "Invalid ADB device identifier."
    }
    if ($serial -match '^\d{1,3}(\.\d{1,3}){3}$') {
        $serial += ":5555"
    }

    $adbCommand = Get-Command adb.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    $adb = if ($adbCommand) { $adbCommand.Source } else { $null }
    if (-not $adb) {
        foreach ($candidate in @(
            "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
            "$env:ANDROID_HOME\platform-tools\adb.exe",
            "$env:ANDROID_SDK_ROOT\platform-tools\adb.exe"
        )) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $adb = $candidate
                break
            }
        }
    }
    if (-not $adb) {
        throw "adb.exe not found. Install Android SDK platform-tools or add adb to PATH."
    }

    function Invoke-AdbCommand {
        param([string[]]$CommandArgs)

        $priorPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $output = & $adb @CommandArgs 2>&1 | Out-String
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $priorPreference
        }
        return [pscustomobject]@{
            ExitCode = $exitCode
            Output = $output.Trim()
        }
    }

    Write-Host "FitBaus YouTube OAuth import"
    Write-Host "  bike: $serial"
    Write-Host "  app: $package"
    if ($serial -match ':\d+$') {
        $null = Invoke-AdbCommand -CommandArgs @("connect", $serial)
    }
    $state = Invoke-AdbCommand -CommandArgs @("-s", $serial, "get-state")
    if ($state.ExitCode -ne 0 -or $state.Output -ne "device") {
        throw "ADB device '$serial' is not connected or authorized."
    }
    $installedPackage = Invoke-AdbCommand -CommandArgs @("-s", $serial, "shell", "pm", "path", $package)
    if ($installedPackage.ExitCode -ne 0 -or $installedPackage.Output -notmatch 'package:') {
        throw "The selected FitBaus app is not installed on this bike. Deploy the OAuth-enabled APK first."
    }

    $nonce = [guid]::NewGuid().ToString("N")
    $stage = "/sdcard/Android/data/$package/files/youtube-auth-import"
    $remoteJson = "$stage/$nonce.json"
    $remoteStatus = "$stage/$nonce.status"
    $mkdir = Invoke-AdbCommand -CommandArgs @("-s", $serial, "shell", "mkdir", "-p", $stage)
    if ($mkdir.ExitCode -ne 0) {
        throw "Cannot create the temporary app-specific import directory on the bike."
    }

    try {
        $push = Invoke-AdbCommand -CommandArgs @("-s", $serial, "push", $files[0].FullName, $remoteJson)
        if ($push.ExitCode -ne 0) {
            throw "ADB failed to transfer the JSON."
        }
        $launch = Invoke-AdbCommand -CommandArgs @(
            "-s", $serial, "shell", "am", "start",
            "-n", "$package/com.fitbaus.bikebridge.host.NativeBridgeActivity",
            "-a", "com.fitbaus.bikebridge.action.IMPORT_YOUTUBE_AUTH",
            "--es", "com.fitbaus.bikebridge.extra.IMPORT_NONCE", $nonce
        )
        if ($launch.ExitCode -ne 0) {
            throw "Could not launch FitBaus's OAuth importer. Is the new APK installed?"
        }
        $deadline = (Get-Date).AddSeconds(30)
        do {
            Start-Sleep -Milliseconds 400
            $ack = Invoke-AdbCommand -CommandArgs @("-s", $serial, "shell", "cat $remoteStatus 2>/dev/null")
            $result = $ack.Output
            if ($result -eq "OK") {
                Write-Host "Credentials imported and encrypted on the bike."
                Write-Host "On the bike's YouTube screen, approve the displayed Google code using your phone."
                exit 0
            }
            if ($result -eq "ERROR") {
                throw "FitBaus rejected the JSON or could not save the credentials."
            }
        } while ((Get-Date) -lt $deadline)
        throw "No import acknowledgment from FitBaus. Check that the OAuth-enabled APK is installed."
    } finally {
        $null = Invoke-AdbCommand -CommandArgs @("-s", $serial, "shell", "rm", "-f", $remoteJson, $remoteStatus)
    }
} catch {
    Write-Host ("ERROR: " + $_.Exception.Message)
    exit 1
}
