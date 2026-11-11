# SPDX-License-Identifier: AGPL-3.0-only
# Read the QUALIFICATION_IDENTITY marker compiled into a Bike Bridge APK.
# Usage:
#   . .\native-apk-identity.ps1
#   Get-ApkQualificationIdentity -ApkPath path\to\app.apk
#   Assert-ApkQualificationIdentity -ApkPath path\to\app.apk `
#     -ExpectedApplicationId com.fitbaus.bikebridge -ExpectedUnlock off

function Get-ApkLatin1Blob {
    param([Parameter(Mandatory = $true)][string]$ApkPath)
    if (-not (Test-Path $ApkPath)) { throw "APK not found: $ApkPath" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $ApkPath))
    try {
        $chunks = New-Object System.Collections.Generic.List[string]
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName -notlike 'classes*.dex') { continue }
            $stream = $entry.Open()
            try {
                $ms = New-Object IO.MemoryStream
                $stream.CopyTo($ms)
                [void]$chunks.Add([Text.Encoding]::GetEncoding("ISO-8859-1").GetString($ms.ToArray()))
            }
            finally {
                $stream.Dispose()
            }
        }
        if ($chunks.Count -eq 0) { throw "APK has no classes*.dex: $ApkPath" }
        return ($chunks -join "")
    }
    finally {
        $zip.Dispose()
    }
}

function Get-ApkQualificationIdentity {
    param([Parameter(Mandatory = $true)][string]$ApkPath)
    $blob = Get-ApkLatin1Blob $ApkPath
    $found = [regex]::Matches($blob, 'fitbaus\.applicationId=([A-Za-z0-9.]+);fitbaus\.unlockQualification=(off|auth|lockout)')
    if ($found.Count -eq 0) {
        throw "APK is missing QUALIFICATION_IDENTITY marker: $ApkPath"
    }
    $ids = @($found | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
    $unlocks = @($found | ForEach-Object { $_.Groups[2].Value } | Select-Object -Unique)
    if ($ids.Count -ne 1 -or $unlocks.Count -ne 1) {
        throw ("APK has conflicting QUALIFICATION_IDENTITY markers ids={0} unlock={1}: {2}" -f ($ids -join ','), ($unlocks -join ','), $ApkPath)
    }
    return [pscustomobject]@{
        ApplicationId       = $ids[0]
        UnlockQualification = $unlocks[0]
        Path                = $ApkPath
    }
}

function Assert-ApkQualificationIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$ApkPath,
        [Parameter(Mandatory = $true)][string]$ExpectedApplicationId,
        [Parameter(Mandatory = $true)][string]$ExpectedUnlock
    )
    $id = Get-ApkQualificationIdentity $ApkPath
    if ($id.ApplicationId -ne $ExpectedApplicationId) {
        throw ("APK applicationId is '{0}', expected '{1}': {2}" -f $id.ApplicationId, $ExpectedApplicationId, $ApkPath)
    }
    if ($id.UnlockQualification -ne $ExpectedUnlock) {
        throw ("APK UNLOCK_QUALIFICATION is '{0}', expected '{1}': {2}" -f $id.UnlockQualification, $ExpectedUnlock, $ApkPath)
    }
    return $id
}
