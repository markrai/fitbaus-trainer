# Inspect a built FitBaus APK before installing it on the bike.
param(
    [Parameter(Mandatory = $true)]
    [string]$Apk
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Apk)) {
    throw "APK not found: $Apk"
}

function Assert-PublicDefaultCtor {
    param(
        [string]$Dll,
        [string]$Namespace,
        [string]$TypeName,
        [string]$Label
    )
    $work = Join-Path $env:TEMP ("fitbaus-ctor-inspect-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    try {
        Set-Content -Path (Join-Path $work "CtorInspect.csproj") -Value @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>
"@
        Set-Content -Path (Join-Path $work "Program.cs") -Value @'
using System;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
class P {
  static int Main(string[] args) {
    string dll = args[0];
    string nsWanted = args[1];
    string typeWanted = args[2];
    string label = args[3];
    using var fs = File.OpenRead(dll);
    using var pe = new PEReader(fs);
    var r = pe.GetMetadataReader();
    foreach (var th in r.TypeDefinitions) {
      var t = r.GetTypeDefinition(th);
      string ns = r.GetString(t.Namespace);
      string name = r.GetString(t.Name);
      if (ns != nsWanted || name != typeWanted) continue;
      foreach (var mh in t.GetMethods()) {
        var m = r.GetMethodDefinition(mh);
        if (r.GetString(m.Name) != ".ctor") continue;
        if (m.GetParameters().Count == 0 && (m.Attributes & MethodAttributes.Public) != 0) {
          Console.WriteLine(label + ".defaultCtor=present");
          return 0;
        }
      }
      Console.WriteLine(label + ".defaultCtor=missing");
      return 1;
    }
    Console.WriteLine(label + ".type=missing");
    return 1;
  }
}
'@
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $out = & dotnet run --project (Join-Path $work "CtorInspect.csproj") --configuration Release -- $Dll $Namespace $TypeName $Label 2>&1
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prev
        Write-Host ($out | Out-String)
        if ($code -ne 0) {
            throw "Linked $Dll is missing $Namespace.$TypeName public default constructor (Full-link regression)"
        }
        Write-Host "[OK]  $Label public default constructor"
    }
    finally {
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Assert-ShireBitFieldModel([string]$Dll) {
    $work = Join-Path $env:TEMP ("fitbaus-shire-bitfield-inspect-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    try {
        Set-Content -Path (Join-Path $work "BitFieldInspect.csproj") -Value @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>
"@
        Set-Content -Path (Join-Path $work "Program.cs") -Value @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
class P {
  static int Main(string[] args) {
    using var fs = File.OpenRead(args[0]);
    using var pe = new PEReader(fs);
    var r = pe.GetMetadataReader();
    TypeDefinition? values = null;
    foreach (var th in r.TypeDefinitions) {
      var t = r.GetTypeDefinition(th);
      if (r.GetString(t.Namespace) != "Shire.Core.FitPro.Equipment.Bits") continue;
      if (r.GetString(t.Name) == "BitFieldValues") values = t;
    }
    if (values == null) {
      Console.WriteLine("BitFieldValues.type=missing");
      return 1;
    }
    var props = new Dictionary<string, (bool setter, bool attr)>(StringComparer.Ordinal);
    int attributedWithSetter = 0;
    foreach (var ph in values.Value.GetProperties()) {
      var p = r.GetPropertyDefinition(ph);
      string name = r.GetString(p.Name);
      var acc = p.GetAccessors();
      bool setter = !acc.Setter.IsNil;
      bool attr = false;
      foreach (var cah in p.GetCustomAttributes()) {
        var ca = r.GetCustomAttribute(cah);
        if (AttrName(r, ca.Constructor).IndexOf("BitFieldPropertyInfo", StringComparison.Ordinal) >= 0) attr = true;
      }
      props[name] = (setter, attr);
      if (attr && setter) attributedWithSetter++;
    }
    Console.WriteLine("BitFieldValues.attributedWithSetter=" + attributedWithSetter);
    int rc = 0;
    if (attributedWithSetter < 88) {
      Console.WriteLine("BitFieldValues.attributedWithSetter=below-original-88");
      rc = 1;
    }
    string[] required = { "WorkoutMode", "IdleModeLockout", "Resistance", "Rpm", "Watts" };
    foreach (string n in required) {
      if (!props.ContainsKey(n)) {
        Console.WriteLine(n + ".property=missing");
        rc = 1;
        continue;
      }
      Console.WriteLine(n + ".property=present");
      Console.WriteLine(n + ".setter=" + (props[n].setter ? "present" : "missing"));
      if (!props[n].setter) rc = 1;
    }
    return rc;
  }
  static string AttrName(MetadataReader r, EntityHandle ctor) {
    if (ctor.Kind == HandleKind.MethodDefinition) {
      var md = r.GetMethodDefinition((MethodDefinitionHandle)ctor);
      var td = r.GetTypeDefinition(md.GetDeclaringType());
      return r.GetString(td.Name);
    }
    if (ctor.Kind == HandleKind.MemberReference) {
      var mr = r.GetMemberReference((MemberReferenceHandle)ctor);
      if (mr.Parent.Kind == HandleKind.TypeDefinition) {
        var td = r.GetTypeDefinition((TypeDefinitionHandle)mr.Parent);
        return r.GetString(td.Name);
      }
      if (mr.Parent.Kind == HandleKind.TypeReference) {
        var tr = r.GetTypeReference((TypeReferenceHandle)mr.Parent);
        return r.GetString(tr.Name);
      }
    }
    return "";
  }
}
'@
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $out = & dotnet run --project (Join-Path $work "BitFieldInspect.csproj") --configuration Release -- $Dll 2>&1
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prev
        Write-Host ($out | Out-String)
        if ($code -ne 0) {
            throw "Linked Shire.Core.dll is missing FitPro BitFieldValues reflection members/setters (Full-link regression)"
        }
        Write-Host "[OK]  BitFieldValues attributed properties retain setters"
    }
    finally {
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$aapt = Get-ChildItem (Join-Path $sdk "build-tools") -Recurse -Filter "aapt.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $aapt) {
    throw "aapt.exe not found under $sdk\build-tools"
}

Write-Host "=== badging ==="
& $aapt dump badging $Apk

Write-Host ""
Write-Host "=== permissions ==="
$permOut = & $aapt dump permissions $Apk | Out-String
Write-Host $permOut
if ($permOut -notmatch "android\.permission\.INTERNET") {
    throw "APK is missing INTERNET permission required for the LAN telemetry listener"
}
Write-Host "[OK]  android.permission.INTERNET"

Write-Host ""
Write-Host "=== native libs (x86) ==="
$tmp = Join-Path $env:TEMP ("fitbaus-apk-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path $Apk), $tmp)
    $requiredSo = @(
        "lib\x86\libmonodroid.so",
        "lib\x86\libmonosgen-2.0.so"
    )
    foreach ($rel in $requiredSo) {
        $path = Join-Path $tmp $rel
        if (Test-Path $path) { Write-Host "[OK]  $rel" } else { Write-Host "[NO]  $rel" }
    }

    Write-Host ""
    Write-Host "=== assemblies ==="
    $requiredDll = @(
        "Fitbaus.BikeBridge.Android.dll",
        "Shire.Core.dll",
        "Shire.Android.dll",
        "MvvmCross.Platform.dll",
        "System.Reactive.Linq.dll",
        "System.Reactive.Core.dll",
        "System.Reactive.Interfaces.dll",
        "System.Reactive.PlatformServices.dll",
        "MoreLinq.Portable.dll"
    )
    $assemblyFiles = @()
    if (Test-Path (Join-Path $tmp "assemblies")) {
        $assemblyFiles = Get-ChildItem (Join-Path $tmp "assemblies") -Recurse -Filter "*.dll" | ForEach-Object { $_.Name }
    }
    foreach ($name in $requiredDll) {
        if ($assemblyFiles -contains $name) { Write-Host "[OK]  $name" } else { Write-Host "[NO]  $name (may be packed in assemblies.blob; check XA pack format)" }
    }

    Write-Host ""
    Write-Host "=== MvvmCross IoC (Full-link reflection surface) ==="
    $mvx = Join-Path $tmp "assemblies\MvvmCross.Platform.dll"
    if (-not (Test-Path $mvx)) {
        Write-Host "[NO]  assemblies\MvvmCross.Platform.dll"
        throw "Packaged MvvmCross.Platform.dll is missing"
    }
    Assert-PublicDefaultCtor -Dll $mvx -Namespace "MvvmCross.Platform.IoC" -TypeName "MvxPropertyInjector" -Label "MvxPropertyInjector"

    Write-Host ""
    Write-Host "=== Rx PlatformServices (Full-link reflection surface) ==="
    $rx = Join-Path $tmp "assemblies\System.Reactive.PlatformServices.dll"
    if (-not (Test-Path $rx)) {
        Write-Host "[NO]  assemblies\System.Reactive.PlatformServices.dll"
        throw "Packaged System.Reactive.PlatformServices.dll is missing"
    }
    Assert-PublicDefaultCtor -Dll $rx -Namespace "System.Reactive.PlatformServices" -TypeName "CurrentPlatformEnlightenmentProvider" -Label "CurrentPlatformEnlightenmentProvider"

    Write-Host ""
    Write-Host "=== Shire BitFieldValues (Full-link reflection surface) ==="
    $shire = Join-Path $tmp "assemblies\Shire.Core.dll"
    if (-not (Test-Path $shire)) {
        Write-Host "[NO]  assemblies\Shire.Core.dll"
        throw "Packaged Shire.Core.dll is missing"
    }
    Assert-ShireBitFieldModel $shire
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
