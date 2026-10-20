# Shire / Xamarin runtime (not vendored)

This bridge reuses original Wolf/standalone Shire-era assemblies at build and
device packaging time. Those binaries are **not** copied into Git.

FitBaus does **not** include those third-party runtime components in this
repository. They have their own licensing and rights. The FitBaus-owned source
license (intended AGPL-3.0-only under the parent Trainer repo) does **not**
grant rights to redistribute proprietary runtime DLLs. Public CI cannot build
the final device APK without separately supplied compatible assemblies.

## Populate gitignored directories

1. Obtain a local working set of **Wolf/standalone** assemblies (not ERU).
2. Copy into this repo’s ignored trees:

```powershell
powershell -File scripts\copy-shire-runtime.ps1 -Source <path-to-wolf-standalone-assemblies>
```

Optional environment variable used by some scripts:

```text
SHIRE_ASSEMBLIES_DIR   # source assemblies for copy-shire-runtime.ps1
ShireRuntimeDir        # MSBuild / compile-check runtime dir (defaults to third_party\shire-runtime)
XamarinRefDir          # untrimmed Mono.Android / BCL refs for compile-check only
SHIRE_ORIGINAL_DIR     # optional extra pack-deps source for Directory.Build.targets
```

Expected destinations (gitignored contents):

```text
third_party/shire-runtime/     # required Shire + Rx + MvvmCross + MoreLinq for compile/link
third_party/shire-pack-deps/   # broader Wolf closure copied into OutDir at package time
```

## Version note

Use the Wolf/standalone stack the bike actually runs, for example:

- standalone Shire.Core `1.0.6451.31616` — hardware path
- ERU Shire.Core `1.0.6583.27999` — sibling app; do **not** mix into the bike stack

ERU’s larger `Mono.Android` may still be useful as a **compile-time** BCL
reference only (`XamarinRefDir`); it is not the bike’s Shire version.
