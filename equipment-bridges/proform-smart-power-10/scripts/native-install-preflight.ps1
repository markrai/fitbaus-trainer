# SPDX-License-Identifier: AGPL-3.0-only
# Fail-closed preflight before in-place Bike Bridge install (adb install -r).
# Usage:
#   . .\native-install-preflight.ps1
#   Assert-BikeBridgeInstallPreflight -AdbPath adb.exe -Serial 192.168.1.226:5555 `
#     -ApkPath path\to\app.apk -ExpectedApplicationId com.fitbaus.bikebridge

function Resolve-AndroidBuildTool {
    param([Parameter(Mandatory = $true)][string]$ToolName)
    $roots = @()
    if ($env:ANDROID_HOME) { $roots += $env:ANDROID_HOME }
    if ($env:ANDROID_SDK_ROOT) { $roots += $env:ANDROID_SDK_ROOT }
    $localSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    if (Test-Path $localSdk) { $roots += $localSdk }
    foreach ($root in ($roots | Select-Object -Unique)) {
        $bt = Join-Path $root 'build-tools'
        if (-not (Test-Path $bt)) { continue }
        $match = Get-ChildItem $bt -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object {
                $candidate = Join-Path $_.FullName $ToolName
                if (Test-Path $candidate) { $candidate }
            } |
            Select-Object -First 1
        if ($match) { return $match }
    }
    throw "Android build-tools '$ToolName' not found. Install SDK build-tools."
}

function Get-ApkPackageMetadata {
    param([Parameter(Mandatory = $true)][string]$ApkPath)
    if (-not (Test-Path $ApkPath)) { throw "APK not found: $ApkPath" }
    $aapt = Resolve-AndroidBuildTool 'aapt.exe'
    $badging = & $aapt dump badging $ApkPath 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "aapt dump badging failed for $ApkPath`n$badging" }
    $pkg = [regex]::Match($badging, "package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'")
    if (-not $pkg.Success) { throw "Could not parse package metadata from APK: $ApkPath" }
    $minSdk = [regex]::Match($badging, "sdkVersion:'(\d+)'")
    $native = [regex]::Match($badging, "native-code: '([^']+)'")
    return [pscustomobject]@{
        ApplicationId = $pkg.Groups[1].Value
        VersionCode   = [int]$pkg.Groups[2].Value
        VersionName   = $pkg.Groups[3].Value
        MinSdk        = if ($minSdk.Success) { [int]$minSdk.Groups[1].Value } else { $null }
        NativeCode    = if ($native.Success) { $native.Groups[1].Value } else { $null }
        Path          = (Resolve-Path $ApkPath).Path
        Length        = (Get-Item $ApkPath).Length
    }
}

function Get-ApkSignerCertSha256 {
    param([Parameter(Mandatory = $true)][string]$ApkPath)
    $apksigner = Resolve-AndroidBuildTool 'apksigner.bat'
    $out = & $apksigner verify --print-certs $ApkPath 2>&1 | Out-String
    $m = [regex]::Match($out, 'Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F:]+)')
    if (-not $m.Success) { throw "Could not read signer SHA-256 from APK: $ApkPath`n$out" }
    return ($m.Groups[1].Value -replace '[:\s]', '').ToLowerInvariant()
}

function Get-InstalledPackageVersion {
    param(
        [Parameter(Mandatory = $true)][string]$AdbPath,
        [Parameter(Mandatory = $true)][string]$Serial,
        [Parameter(Mandatory = $true)][string]$ApplicationId
    )
    $dump = & $AdbPath -s $Serial shell dumpsys package $ApplicationId 2>&1 | Out-String
    if ($dump -notmatch [regex]::Escape("Package [$ApplicationId]")) {
        return $null
    }
    $code = [regex]::Match($dump, 'versionCode=(\d+)')
    $name = [regex]::Match($dump, 'versionName=([^\s]+)')
    if (-not $code.Success) { throw "Installed package $ApplicationId has no versionCode in dumpsys" }
    return [pscustomobject]@{
        ApplicationId = $ApplicationId
        VersionCode   = [int]$code.Groups[1].Value
        VersionName   = if ($name.Success) { $name.Groups[1].Value } else { $null }
    }
}

function Assert-BikeBridgeInstallPreflight {
    param(
        [Parameter(Mandatory = $true)][string]$AdbPath,
        [Parameter(Mandatory = $true)][string]$Serial,
        [Parameter(Mandatory = $true)][string]$ApkPath,
        [Parameter(Mandatory = $true)][string]$ExpectedApplicationId
    )

    $state = (& $AdbPath -s $Serial get-state 2>$null | Out-String).Trim()
    if ($state -ne 'device') {
        throw "Console $Serial is not reachable over adb (state: '$state')."
    }
    if (-not (Test-Path $ApkPath)) {
        throw "APK not found: $ApkPath"
    }

    $apk = Get-ApkPackageMetadata -ApkPath $ApkPath
    if ($apk.ApplicationId -ne $ExpectedApplicationId) {
        throw ("APK applicationId is '{0}', expected '{1}'. Refusing install that would target a different package identity." -f $apk.ApplicationId, $ExpectedApplicationId)
    }

    $apkCert = Get-ApkSignerCertSha256 -ApkPath $ApkPath
    Write-Host ("  APK      : {0} versionName={1} versionCode={2} minSdk={3} abi={4} size={5}" -f `
        $apk.ApplicationId, $apk.VersionName, $apk.VersionCode, $apk.MinSdk, $apk.NativeCode, $apk.Length)
    Write-Host ("  APK cert : SHA-256 {0}" -f $apkCert)

    $installed = Get-InstalledPackageVersion -AdbPath $AdbPath -Serial $Serial -ApplicationId $ExpectedApplicationId
    if ($null -eq $installed) {
        Write-Host ("  Installed: (not present) — fresh install of {0}" -f $ExpectedApplicationId)
        return [pscustomobject]@{
            Apk       = $apk
            Installed = $null
            ApkCert   = $apkCert
            Mode      = 'fresh'
        }
    }

    Write-Host ("  Installed: {0} versionName={1} versionCode={2}" -f `
        $installed.ApplicationId, $installed.VersionName, $installed.VersionCode)

    if ($apk.VersionCode -lt $installed.VersionCode) {
        throw ("Refusing VERSION DOWNGRADE: APK versionCode {0} ({1}) is lower than installed {2} ({3}) on {4}. Increase version.js and rebuild. Do not uninstall — that would erase pairing data." -f `
            $apk.VersionCode, $apk.VersionName, $installed.VersionCode, $installed.VersionName, $Serial)
    }
    if ($apk.VersionCode -eq $installed.VersionCode) {
        Write-Host "  Note     : versionCode matches installed; reinstall will replace in place if the signature matches."
    }

    # Installed package present: fail closed unless we can compare signer digests.
    $pathLine = (& $AdbPath -s $Serial shell pm path $ExpectedApplicationId 2>&1 | Out-String).Trim()
    $remote = [regex]::Match($pathLine, 'package:(.+\.apk)')
    if (-not $remote.Success) {
        throw ("Refusing INSTALL: package {0} is installed on {1} but its APK path could not be resolved for signing comparison (pm path: '{2}'). Fix adb access and retry; do not uninstall." -f `
            $ExpectedApplicationId, $Serial, $pathLine)
    }

    $tmp = Join-Path $env:TEMP ("fitbaus-preflight-{0}.apk" -f [guid]::NewGuid().ToString('N'))
    $pullOut = $null
    try {
        $pullOut = & $AdbPath -s $Serial pull $remote.Groups[1].Value $tmp 2>&1 | Out-String
        if (-not (Test-Path $tmp) -or ((Get-Item $tmp).Length -le 0)) {
            throw ("Refusing INSTALL: package {0} is installed on {1} but its signing certificate could not be checked (adb pull of '{2}' failed or produced no local APK). Output: {3}. Fix adb access and retry; do not uninstall." -f `
                $ExpectedApplicationId, $Serial, $remote.Groups[1].Value, $pullOut.Trim())
        }
        $installedCert = Get-ApkSignerCertSha256 -ApkPath $tmp
        Write-Host ("  Inst cert: SHA-256 {0}" -f $installedCert)
        if ($installedCert -ne $apkCert) {
            throw ("Refusing INSTALL: signing certificate mismatch. APK={0} installed={1}. Do not uninstall the console app to force this install." -f $apkCert, $installedCert)
        }
        Write-Host "  Signing  : compatible (SHA-256 match)"
    }
    finally {
        if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
    }

    return [pscustomobject]@{
        Apk           = $apk
        Installed     = $installed
        ApkCert       = $apkCert
        InstalledCert = $installedCert
        Mode          = 'upgrade'
    }
}
