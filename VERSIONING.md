# FitBaus product versioning

FitBaus uses one unified product version across Trainer web/PWA, Capacitor
Android and iOS, Native Bike Bridge, and arcade (shipped inside the Bridge
APK). **1.0.0** was the first unified release. **FitBaus Full 2.1.0**
(`versionCode 20100`) is the latest published Full release. Full 2.1.1 was prepared but
not published, and 2.1.2–2.1.3 were development versions. The next Full
minor release, **2.2.0** (`versionCode 20200`), is in release preparation on
`main`.

There is one authoritative source: [`version.js`](version.js).

```js
const APP_VERSION = "2.2.0";
```

Do not treat persistence schema versions, protocol identifiers, API versions,
migrations, dependency versions, or historical changelog entries as product
versions.

## What derives from `version.js`

| Surface | How it gets the version |
| --- | --- |
| `src/version.ts`, `package.json`, `package-lock.json` | `node scripts/sync-version.cjs` (`prebuild` / `prebuild:native`) |
| `dist/version.js` | TypeScript compile of `src/version.ts` |
| PWA cache name `fitbaus-trainer-<version>` | `sw.js` parses `dist/version.js` |
| iOS `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` | `sync-version.cjs` writes the Xcode project |
| Android Trainer `versionName` / `versionCode` | `android/` Gradle reads `rootProject.file("../version.js")` |
| Bike Bridge `versionName` / `versionCode` | Native Gradle reads `rootProject.file("../../../version.js")` |
| Bike Bridge HTTP `bridgeVersion` | `equipment-protocol` generates a JVM Kotlin constant at compile time |
| Native Capacitor web assets | `scripts/build-native.mjs` writes `www/fitbaus-version.json` from `version.js` and requires the bundled `www/dist/main.js` to contain that version |

Independent Gradle builds do **not** need a prior npm build. Missing or
malformed `version.js` fails the build.

The USB probe app is diagnostic tooling and keeps its own version.

## Numeric build codes

```
versionCode = major * 10000 + minor * 100 + patch
```

`1.0.0` → `10000`, `1.0.1` → `10001`, `2.0.0` → `20000`, `2.1.0` → `20100`. Minor and patch must
each be `0..99`. The result must stay inside Android's permitted `versionCode`
range (`1..2100000000`). Node and Gradle helpers enforce the same rules.
Published Lite **1.0.1** on production Bike Bridge requires Full to ship at
least **20000** for an in-place `adb install -r` upgrade.

Known installed maxima before 1.0.0: Trainer Android `1`, Bike Bridge `2`,
iOS build `1`. `10000` is monotonic for every preserved package identity:

- Trainer: `com.markrai.fitbaus.trainer`
- Bike Bridge staging: `com.fitbaus.bikebridge.native`
- Bike Bridge production: `com.fitbaus.bikebridge`

Package IDs, bundle IDs, pairing data, and persisted athlete/workout state
are not reset by a product-version bump.

## How to bump

1. Change `APP_VERSION` in `version.js`.
2. Run `npm run build` (syncs generated web/iOS/package metadata, compiles `dist/`).
3. Run `npm run check:version`.
4. Add a `CHANGELOG.md` entry.
5. Commit `version.js` together with the files `sync-version.cjs` and `tsc` update.
   Do not hand-edit `src/version.ts` or `dist/`.

Android and Bike Bridge pick up the new value on the next Gradle configure.

## Checks

```bash
npm run check:version
node scripts/check-version-consistency.cjs --require-gradle=bridge
node scripts/check-version-consistency.cjs --require-gradle=all
```

CI runs the file-level check on the Trainer job and the Gradle-resolved check
on the Native Bike Bridge job.

## Editions and release tracks

- **FitBaus Lite 1.x** — maintenance on `lite/1.x` from `v1.0.0` / published
  `v1.0.1`; no external UVC. Do not rewrite published Lite tags.
- **FitBaus Full 2.x** — feature edition on `main`, including external USB
  (UVC) webcam support and native YouTube playback. **2.1.0** / `20100` is
  published. **2.1.1** / `20101` was prepared but not published;
  **2.1.2** / `20102` and **2.1.3** / `20103` were development versions;
  **2.2.0** / `20200` is the next Full minor release candidate.
  Do not merge webcam into Lite.

Product versioning stays unified via `version.js`. Edition differences use
artifact filenames (for example `fitbaus-bikebridge-full-2.1.0.apk` vs
`fitbaus-bikebridge-lite-1.0.1.apk`), not package-ID forks.

Maintainer procedure, secrets, certificate pins, and physical qualification:
see [.github/release/RELEASE.md](.github/release/RELEASE.md). The Full 2.2.0
release checklist is [.github/release/plans/full-v2.2.0.md](.github/release/plans/full-v2.2.0.md).

## GitHub release procedure

Public installers are produced by **Release** (`.github/workflows/release.yml`).
For the published Full 2.1.0 release (historical example):

1. Tag: create the annotated tag `v2.1.0` on the `main` commit whose
   `version.js` declares `2.1.0`, and push it.
2. Run **Release** with `tag=v2.1.0`, matching `expected_commit`,
   `edition=full`, `mode=inspect`.
3. Physically qualify the exact signed Bike Bridge APK from that candidate on
   the console, and record the evidence and qualification record (details in
   `.github/release/RELEASE.md`).
4. Re-run **Release** with the same `tag`, `expected_commit`, `edition=full`,
   `mode=publish`, and `candidate_run_id` pointing at the qualified inspect
   run. GitHub Actions attaches the verified public files; maintainers do not
   manually sign APKs or re-upload assets for the happy path.

The older **Release artifacts** workflow remains inspection-oriented legacy
packaging; prefer **Release** for installer publication.

## Artifact signing classes

| Artifact | Class | Installability |
| --- | --- | --- |
| Trainer Android public APK | release-signed (Release workflow) | Sideloadable; upgrades need certificate continuity |
| Bike Bridge Lite/public APK | production-signed | Upgrades need the established production certificate |
| Bike Bridge staging APKs | inspection / debug | Engineering only |
| iOS IPA | not produced in CI | No macOS runner or App Store signing in this repository's workflows |
| Web zip | unsigned static files | Host on any static HTTPS server |

Do not present unsigned APKs as install-ready releases.

## Remaining gates (not version consistency)

- Certificate pins for Trainer and production Bike Bridge are recorded in
  `.github/release/signing-policy.json`; keep the pinned fingerprints in sync
  with the release keystores (details in `.github/release/RELEASE.md`)
- Verify existing GitHub Actions signing secrets remain configured
- Production Bike Bridge physical-device qualification record for each published version
- iOS distribution signing and a macOS build
- Console storage: measure APK size before installing on stock hardware
