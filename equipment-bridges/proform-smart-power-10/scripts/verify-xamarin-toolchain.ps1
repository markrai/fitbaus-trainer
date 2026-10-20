# Verify archived Xamarin.Android 13.2.2 + JDK 11 + Platform 24.
# Does not install anything.
$ErrorActionPreference = "Continue"
$failed = $false

function Ok($msg) { Write-Host "[OK]  $msg" -ForegroundColor Green }
function Bad($msg) { Write-Host "[NO]  $msg" -ForegroundColor Red; $script:failed = $true }
function Info($msg) { Write-Host "[..]  $msg" }

$vsRoots = @(
    (Join-Path ${env:ProgramFiles} "Microsoft Visual Studio\2022\Community"),
    (Join-Path ${env:ProgramFiles} "Microsoft Visual Studio\2022\Professional"),
    (Join-Path ${env:ProgramFiles} "Microsoft Visual Studio\2022\Enterprise"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\BuildTools")
) | Where-Object { Test-Path $_ }
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }

$targetCandidates = @()
foreach ($vs in $vsRoots) {
    $targetCandidates += (Join-Path $vs "MSBuild\Xamarin\Android\Xamarin.Android.CSharp.targets")
}
$targetCandidates += (Join-Path ${env:ProgramFiles(x86)} "MSBuild\Xamarin\Android\Xamarin.Android.CSharp.targets")
$targets = $targetCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($targets) { Ok "Xamarin.Android.CSharp.targets: $targets" } else { Bad "Xamarin.Android.CSharp.targets not found (install XA 13.2.2 d17-8)" }

$refRoots = @()
foreach ($vs in $vsRoots) {
    $refRoots += (Join-Path $vs "Common7\IDE\ReferenceAssemblies\Microsoft\Framework\MonoAndroid")
}
$refRoots += (Join-Path ${env:ProgramFiles(x86)} "Reference Assemblies\Microsoft\Framework\MonoAndroid")
$foundV70 = $false
$listed = @()
foreach ($root in $refRoots) {
    if (Test-Path $root) {
        $listed += (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
        if (Test-Path (Join-Path $root "v7.0\Mono.Android.dll")) { $foundV70 = $true }
    }
}
if ($listed.Count -gt 0) {
    Info ("MonoAndroid TFMs: " + (($listed | Select-Object -Unique) -join ", "))
} else {
    Bad "No MonoAndroid reference assemblies"
}
if ($foundV70) { Ok "MonoAndroid v7.0 reference assemblies present" } else { Bad "MonoAndroid v7.0 not present (needed for TargetFrameworkVersion v7.0, or bump TFM after install)" }

$androidJar = Join-Path $sdk "platforms\android-24\android.jar"
if (Test-Path $androidJar) { Ok "Android SDK Platform 24: $androidJar" } else { Bad "Android SDK Platform 24 missing ($androidJar). minSdk 22 does not replace this." }

$x86Mono = Get-ChildItem $vs -Recurse -Filter "libmonosgen-2.0.so" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x86\\' } |
    Select-Object -First 3 -ExpandProperty FullName
if ($x86Mono) { Ok ("x86 libmonosgen-2.0.so: " + ($x86Mono -join "; ")) } else { Info "Could not find x86 libmonosgen-2.0.so under VS (XA may store it elsewhere; inspect the built APK)" }

Info "JAVA_HOME=$env:JAVA_HOME"
$java = $null
if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
    $java = Join-Path $env:JAVA_HOME "bin\java.exe"
} else {
    $java = (Get-Command java -ErrorAction SilentlyContinue).Source
}
if ($java) {
    $ver = & $java -version 2>&1 | Out-String
    Info $ver.Trim()
    if ($ver -match '"11\.') { Ok "JDK 11 detected" } else { Bad "JDK 11 required for Xamarin.Android 12+. Current java is not 11.x" }
} else {
    Bad "java not found"
}

if ($failed) {
    Write-Host ""
    Write-Host "Toolchain NOT ready. See docs/TOOLCHAIN.md"
    exit 1
}
Write-Host ""
Write-Host "Toolchain looks ready. Next: compile-check, then msbuild the Android project, then scripts/inspect-apk.ps1"
exit 0
