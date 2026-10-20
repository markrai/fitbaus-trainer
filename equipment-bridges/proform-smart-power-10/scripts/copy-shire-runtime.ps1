# Copy Wolf/standalone Shire runtime DLLs into third_party/shire-runtime (gitignored).
param(
    [string]$Source = $env:SHIRE_ASSEMBLIES_DIR,
    [string]$Destination = ""
)

$ErrorActionPreference = "Stop"
if (-not $Source) {
    throw "Provide -Source <path> or set SHIRE_ASSEMBLIES_DIR to your local Wolf/standalone assemblies directory."
}

if (-not $Destination) {
    $Destination = Join-Path $PSScriptRoot "..\third_party\shire-runtime"
}

if (-not (Test-Path $Source)) {
    throw "Shire runtime source not found: $Source"
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null

$required = @(
    "Shire.Core.dll",
    "Shire.Android.dll",
    "MvvmCross.Platform.dll",
    "System.Reactive.Interfaces.dll",
    "System.Reactive.Core.dll",
    "System.Reactive.Linq.dll",
    "System.Reactive.PlatformServices.dll",
    "MoreLinq.Portable.dll"
)

foreach ($name in $required) {
    $from = Join-Path $Source $name
    if (-not (Test-Path $from)) {
        throw "Missing required assembly: $from"
    }
    Copy-Item $from (Join-Path $Destination $name) -Force
    Write-Host "copied $name"
}

Write-Host "Shire runtime copied to $Destination"

# Pack-only Wolf closure. GPS/old Support cannot be MSBuild References (XA0121 under XA 13.2.2);
# Directory.Build.targets copies these into OutDir immediately before ResolveAssemblies.
$packDir = Join-Path $PSScriptRoot "..\third_party\shire-pack-deps"
New-Item -ItemType Directory -Force -Path $packDir | Out-Null
$framework = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@(
    "mscorlib", "System", "System.Core", "System.Xml", "System.Net", "System.Net.Http",
    "System.Runtime", "System.Runtime.Serialization", "System.ObjectModel",
    "System.Numerics", "System.Data", "System.Drawing", "System.Web",
    "Mono.Android", "Mono.Android.Export", "Java.Interop", "Mono.Security",
    "System.Windows", "System.Xml.Linq", "System.Json", "System.IO.Compression",
    "Xamarin.Android.NUnitLite"
) | ForEach-Object { [void]$framework.Add($_) }

Get-ChildItem $Source -Filter "*.dll" | ForEach-Object {
    if (-not $framework.Contains($_.BaseName)) {
        Copy-Item $_.FullName (Join-Path $packDir $_.Name) -Force
        Write-Host "pack $($_.Name)"
    }
}

Write-Host "Shire pack-deps copied to $packDir"
Write-Host "Use Wolf/standalone assemblies only. Do not mix with ERU 1.0.6583.27999."
