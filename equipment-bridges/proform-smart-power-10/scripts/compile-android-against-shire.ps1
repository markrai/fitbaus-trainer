# Compile FitBaus Android + shared sources against original Xamarin/Shire reference assemblies.
# BCL/Mono.Android come from the untrimmed ERU extraction (the Wolf APK copies are linker-stripped).
# Shire/Rx/MvvmCross come from Wolf/standalone (the bike's stack).
# This does NOT produce an APK.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$defaultShire = Join-Path $root "third_party\shire-runtime"
$shire = if ($env:ShireRuntimeDir) { $env:ShireRuntimeDir } else { $defaultShire }
$bcl = $env:XamarinRefDir
$outDir = Join-Path $root "artifacts\compile-check"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (-not (Test-Path (Join-Path $shire "Shire.Core.dll"))) {
    throw "Shire runtime not found at $shire. Run scripts\copy-shire-runtime.ps1 -Source <assemblies> or set ShireRuntimeDir."
}
if (-not $bcl -or -not (Test-Path (Join-Path $bcl "Mono.Android.dll"))) {
    throw "Set XamarinRefDir to a directory containing untrimmed Mono.Android.dll (compile-time BCL refs only)."
}

$sdkRoot = Join-Path ${env:ProgramFiles} "dotnet\sdk"
$sdk = Get-ChildItem $sdkRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
$cscDll = Join-Path $sdk.FullName "Roslyn\bincore\csc.dll"
if (-not (Test-Path $cscDll)) {
    throw "Roslyn csc.dll not found under $sdkRoot"
}

$sources = @()
$sources += Get-ChildItem (Join-Path $root "src\Fitbaus.BikeBridge.Core\*.cs") | ForEach-Object { $_.FullName }
$sources += Get-ChildItem (Join-Path $root "src\Fitbaus.BikeBridge.Android\*.cs") | ForEach-Object { $_.FullName }
$sources += Get-ChildItem (Join-Path $root "src\Fitbaus.BikeBridge.Android\Properties\*.cs") -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }

function Add-Ref([string]$dir, [string]$name, [System.Collections.Generic.List[string]]$bag) {
    $path = Join-Path $dir $name
    if (-not (Test-Path $path)) {
        throw "Missing reference: $path"
    }
    $bag.Add("/r:$path")
}

$refs = New-Object System.Collections.Generic.List[string]
foreach ($name in @(
        "mscorlib.dll",
        "System.dll",
        "System.Core.dll",
        "System.Xml.dll",
        "System.Runtime.dll",
        "Mono.Android.dll",
        "Java.Interop.dll"
    )) {
    Add-Ref $bcl $name $refs
}
foreach ($name in @(
        "Shire.Core.dll",
        "Shire.Android.dll",
        "MvvmCross.Platform.dll",
        "System.Reactive.Interfaces.dll",
        "System.Reactive.Core.dll",
        "System.Reactive.Linq.dll",
        "System.Reactive.PlatformServices.dll",
        "MoreLinq.Portable.dll"
    )) {
    Add-Ref $shire $name $refs
}

$outDll = Join-Path $outDir "Fitbaus.BikeBridge.Android.dll"
$argList = @(
    "/nologo",
    "/nostdlib",
    "/noconfig",
    "/langversion:6",
    "/define:__ANDROID__;__ANDROID_22__;DEBUG",
    "/target:library",
    "/out:$outDll"
) + $refs.ToArray() + $sources

Write-Host "Compiling $($sources.Count) sources"
Write-Host "BCL refs: $bcl"
Write-Host "Shire refs: $shire"
& dotnet exec $cscDll @argList
if ($LASTEXITCODE -ne 0) {
    throw "compile-check failed with exit $LASTEXITCODE"
}

Write-Host "OK: $outDll"
Get-Item $outDll | Format-List FullName, Length, LastWriteTime
