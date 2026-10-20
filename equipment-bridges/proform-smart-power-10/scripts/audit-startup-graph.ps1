# Inspect the linked FitBaus Android assembly for startup JIT graph invariants.
# Usage:
#   powershell -File scripts\audit-startup-graph.ps1 -Apk path\to.apk
#   powershell -File scripts\audit-startup-graph.ps1 -Dll path\to\Fitbaus.BikeBridge.Android.dll
param(
    [string]$Apk,
    [string]$Dll
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrEmpty($Apk) -and [string]::IsNullOrEmpty($Dll)) {
    throw "Specify -Apk or -Dll"
}

$tmp = $null
$dllPath = $Dll
if (-not [string]::IsNullOrEmpty($Apk)) {
    if (-not (Test-Path $Apk)) { throw "APK not found: $Apk" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $tmp = Join-Path $env:TEMP ("fitbaus-startup-audit-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path $Apk), $tmp)
    $dllPath = Join-Path $tmp "assemblies\Fitbaus.BikeBridge.Android.dll"
}

if (-not (Test-Path $dllPath)) {
    throw "Android DLL not found: $dllPath"
}

$work = Join-Path $env:TEMP ("fitbaus-startup-il-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
    Set-Content -Path (Join-Path $work "StartupIlAudit.csproj") -Value @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>
"@
    Set-Content -Path (Join-Path $work "Program.cs") -Encoding UTF8 -Value @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
class P {
  static readonly bool[] TokenOp = InitTokenOps();
  static readonly int[] OpSize = InitOpSize();
  static bool[] InitTokenOps() {
    var a = new bool[256];
    a[0x28] = true;
    a[0x6F] = true;
    a[0x73] = true;
    a[0x74] = true;
    a[0x75] = true;
    a[0x79] = true;
    a[0x7B] = true;
    a[0x7C] = true;
    a[0x7D] = true;
    a[0x7E] = true;
    a[0x7F] = true;
    a[0x80] = true;
    a[0x8C] = true;
    a[0x8D] = true;
    a[0xD0] = true;
    a[0x70] = true;
    a[0x27] = true;
    a[0xA3] = true;
    a[0xA4] = true;
    a[0xA5] = true;
    return a;
  }
  static int[] InitOpSize() {
    var s = new int[256];
    s[0x0E] = 1; s[0x0F] = 1; s[0x10] = 1; s[0x11] = 1; s[0x12] = 1; s[0x13] = 1;
    s[0x1F] = 1;
    s[0x20] = 4; s[0x21] = 8; s[0x22] = 4; s[0x23] = 8;
    s[0x25] = 0; s[0x26] = 0; s[0x27] = 4; s[0x28] = 4; s[0x29] = 4;
    s[0x2B] = 1; s[0x2C] = 1; s[0x2D] = 1; s[0x2E] = 1; s[0x2F] = 1;
    s[0x30] = 1; s[0x31] = 1; s[0x32] = 1; s[0x33] = 1; s[0x34] = 1; s[0x35] = 1;
    s[0x36] = 1; s[0x37] = 1; s[0x38] = 4;
    s[0x39] = 4; s[0x3A] = 4; s[0x3B] = 4; s[0x3C] = 4; s[0x3D] = 4; s[0x3E] = 4;
    s[0x3F] = 4; s[0x40] = 4; s[0x41] = 4; s[0x42] = 4; s[0x43] = 4;
    s[0x6F] = 4; s[0x70] = 4; s[0x71] = 4; s[0x73] = 4; s[0x74] = 4; s[0x75] = 4;
    s[0x79] = 4; s[0x7A] = 4; s[0x7B] = 4; s[0x7C] = 4; s[0x7D] = 4; s[0x7E] = 4;
    s[0x7F] = 4; s[0x80] = 4; s[0x81] = 1; s[0x8C] = 4; s[0x8D] = 4;
    s[0xA3] = 4; s[0xA4] = 4; s[0xA5] = 4; s[0xC2] = 4; s[0xC6] = 4; s[0xD0] = 4;
    s[0xDD] = 4; s[0xDE] = 1; s[0xDF] = 4; s[0xE0] = 4;
    s[0x72] = 4;
    return s;
  }
  static int Main(string[] args) {
    using var fs = File.OpenRead(args[0]);
    using var pe = new PEReader(fs);
    var r = pe.GetMetadataReader();
    string firstHttp = "";
    bool tcpMember = false;
    int rc = 0;
    string appBr = "MISSING";
    string appSock = "MISSING";
    string appTcp = "MISSING";
    string actBr = "MISSING";
    string actSock = "MISSING";
    string actTcp = "MISSING";
    foreach (var th in r.TypeDefinitions) {
      var t = r.GetTypeDefinition(th);
      string typeName = TypeName(r, t);
      foreach (var mh in t.GetMethods()) {
        var m = r.GetMethodDefinition(mh);
        string methodName = r.GetString(m.Name);
        var hits = MethodHits(pe, r, m);
        if (hits.Any(h => Contains(h, "TcpListener") || Contains(h, "TcpClient") || Contains(h, "System.Net.Sockets"))) tcpMember = true;
        if (firstHttp.Length == 0) {
          foreach (var h in hits) {
            if (Contains(h, "TelemetryHttpServer") && !Contains(h, "ITelemetryHttpServer")) {
              firstHttp = typeName + "::" + methodName;
              break;
            }
          }
        }
        bool isAppOnCreate = typeName.EndsWith(".BridgeApplication") && methodName == "OnCreate";
        bool isActOnCreate = typeName.EndsWith(".MainActivity") && methodName == "OnCreate";
        bool interesting = isAppOnCreate || isActOnCreate
          || (typeName.EndsWith(".BridgeRuntime") && (methodName == "EnsureStarted" || methodName == ".ctor" || methodName == "Initialize" || methodName == "ConstructHttpServerObject" || methodName == "StartHttpListener"))
          || (typeName.EndsWith(".MainActivity") && methodName == "StartBridgeRuntime")
          || (typeName.EndsWith(".TelemetryHttpServer") && methodName == ".ctor");
        if (!interesting) continue;
        Console.WriteLine("METHOD " + typeName + "::" + methodName);
        foreach (var h in hits.Distinct().OrderBy(x => x, StringComparer.Ordinal)) Console.WriteLine("  " + h);
        bool br = hits.Any(h => h.IndexOf(".BridgeRuntime::", StringComparison.Ordinal) >= 0 || h.EndsWith(".BridgeRuntime", StringComparison.Ordinal));
        bool sock = hits.Any(h => Contains(h, "System.Net.Sockets") || Contains(h, "TcpListener") || Contains(h, "TcpClient"));
        bool tcp = hits.Any(h => Contains(h, "TcpListener"));
        if (isAppOnCreate) { appBr = br ? "YES" : "NO"; appSock = sock ? "YES" : "NO"; appTcp = tcp ? "YES" : "NO"; }
        if (isActOnCreate) { actBr = br ? "YES" : "NO"; actSock = sock ? "YES" : "NO"; actTcp = tcp ? "YES" : "NO"; }
      }
    }
    bool tcpType = false;
    foreach (var trh in r.TypeReferences) {
      var tr = r.GetTypeReference(trh);
      if (r.GetString(tr.Name) == "TcpListener") tcpType = true;
    }
    Console.WriteLine("BridgeApplication.OnCreate.BridgeRuntime=" + appBr);
    Console.WriteLine("BridgeApplication.OnCreate.System.Net.Sockets=" + appSock);
    Console.WriteLine("BridgeApplication.OnCreate.TcpListener=" + appTcp);
    Console.WriteLine("MainActivity.OnCreate.BridgeRuntime=" + actBr);
    Console.WriteLine("MainActivity.OnCreate.System.Net.Sockets=" + actSock);
    Console.WriteLine("MainActivity.OnCreate.TcpListener=" + actTcp);
    Console.WriteLine("Assembly.TcpListenerTypeRef=" + (tcpType ? "YES" : "NO"));
    Console.WriteLine("Assembly.TcpListenerOrSocketsMemberInIl=" + (tcpMember ? "YES" : "NO"));
    Console.WriteLine("First.TelemetryHttpServerMethod=" + (firstHttp.Length == 0 ? "(none)" : firstHttp));
    if (appBr != "NO" || appSock != "NO" || appTcp != "NO") {
      Console.WriteLine("INVARIANT_FAIL BridgeApplication.OnCreate must not reference BridgeRuntime or sockets");
      rc = 1;
    } else {
      Console.WriteLine("INVARIANT_OK BridgeApplication.OnCreate -> NO BridgeRuntime, NO sockets");
    }
    if (actTcp != "NO" || actSock != "NO") {
      Console.WriteLine("INVARIANT_FAIL MainActivity.OnCreate references sockets");
      rc = 1;
    } else {
      Console.WriteLine("INVARIANT_OK MainActivity.OnCreate -> NO TcpListener/System.Net.Sockets");
    }
    return rc;
  }
  static bool Contains(string h, string n) { return h.IndexOf(n, StringComparison.Ordinal) >= 0; }
  static List<string> MethodHits(PEReader pe, MetadataReader r, MethodDefinition m) {
    var hits = new List<string>();
    if (m.RelativeVirtualAddress == 0) return hits;
    var body = pe.GetMethodBody(m.RelativeVirtualAddress);
    byte[] il = body.GetILBytes();
    int i = 0;
    while (i < il.Length) {
      int op = il[i++];
      if (op == 0xFE) {
        if (i >= il.Length) break;
        int op2 = il[i++];
        if (op2 == 0x09 || op2 == 0x0A || op2 == 0x0B || op2 == 0x0C || op2 == 0x0D || op2 == 0x0E) {
          if (i + 4 <= il.Length) { AddToken(r, hits, BitConverter.ToInt32(il, i)); i += 4; }
        } else if (op2 == 0x06 || op2 == 0x15 || op2 == 0x16) {
          i += 4;
        } else if (op2 == 0x12) i += 1;
        continue;
      }
      if (op == 0x44) {
        if (i + 4 > il.Length) break;
        int n = BitConverter.ToInt32(il, i); i += 4 + 4 * (n + 1);
        continue;
      }
      int sz = OpSize[op];
      if (TokenOp[op] && sz == 4 && i + 4 <= il.Length) AddToken(r, hits, BitConverter.ToInt32(il, i));
      i += sz;
    }
    return hits;
  }
  static void AddToken(MetadataReader r, List<string> hits, int token) {
    var h = MetadataTokens.Handle(token);
    if (h.IsNil) return;
    try {
      if (h.Kind == HandleKind.MemberReference) {
        var mr = r.GetMemberReference((MemberReferenceHandle)h);
        hits.Add(ParentName(r, mr.Parent) + "::" + r.GetString(mr.Name));
      } else if (h.Kind == HandleKind.MethodDefinition) {
        var md = r.GetMethodDefinition((MethodDefinitionHandle)h);
        var td = r.GetTypeDefinition(md.GetDeclaringType());
        hits.Add(TypeName(r, td) + "::" + r.GetString(md.Name));
      } else if (h.Kind == HandleKind.TypeReference) {
        hits.Add(TypeRefName(r, (TypeReferenceHandle)h));
      } else if (h.Kind == HandleKind.TypeDefinition) {
        hits.Add(TypeName(r, r.GetTypeDefinition((TypeDefinitionHandle)h)));
      } else if (h.Kind == HandleKind.FieldDefinition) {
        var fd = r.GetFieldDefinition((FieldDefinitionHandle)h);
        var td = r.GetTypeDefinition(fd.GetDeclaringType());
        hits.Add(TypeName(r, td) + "::" + r.GetString(fd.Name));
      }
    } catch { }
  }
  static string TypeName(MetadataReader r, TypeDefinition t) {
    string ns = r.GetString(t.Namespace);
    string name = r.GetString(t.Name);
    return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
  }
  static string TypeRefName(MetadataReader r, TypeReferenceHandle h) {
    var t = r.GetTypeReference(h);
    string ns = r.GetString(t.Namespace);
    string name = r.GetString(t.Name);
    return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
  }
  static string ParentName(MetadataReader r, EntityHandle h) {
    if (h.Kind == HandleKind.TypeReference) return TypeRefName(r, (TypeReferenceHandle)h);
    if (h.Kind == HandleKind.TypeDefinition) return TypeName(r, r.GetTypeDefinition((TypeDefinitionHandle)h));
    return h.Kind.ToString();
  }
}
'@

    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = & dotnet run --project (Join-Path $work "StartupIlAudit.csproj") --configuration Release -- $dllPath 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    Write-Host ($out | Out-String)
    if ($code -ne 0) {
        throw "Startup graph audit failed (exit $code)"
    }
    Write-Host "[OK]  startup graph invariants"
}
finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    if ($tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
