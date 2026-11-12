# FitBaus product versioning

FitBaus **1.0.0** is the first unified product version. Trainer web/PWA,
Capacitor Android and iOS, Native Bike Bridge, and arcade (shipped inside
the Bridge APK) all report the same semantic version.

There is one authoritative source: [`version.js`](version.js).

```js
const APP_VERSION = "1.0.0";
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

`1.0.0` → `10000`. Minor and patch must each be `0..99`. The result must stay
inside Android's permitted `versionCode` range (`1..2100000000`). Node and
Gradle helpers enforce the same rules.

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

## GitHub release procedure

Tagging `v1.0.0` and creating a GitHub Release is a **manual** step. Do not
rely on CI to publish.

1. Confirm `npm test`, `npm run check:version`, and Bike Bridge unit tests pass.
2. Run **Release artifacts** (`workflow_dispatch`) with `dry_run=true`.
3. Inspect uploaded artifacts and `SHA256SUMS.txt`.
4. If the inspection set is acceptable, create the Git tag and GitHub Release
   locally/manually and attach the intended files.
5. Production Bike Bridge packaging requires a separate
   `package_production_bridge=true` opt-in **and** signing secrets. Secrets
   alone do not package production. A packaged production APK is **not**
   physical-device qualification.

`dry_run=false` currently fails closed; this workflow never tags, pushes, or
creates a GitHub Release.

## Artifact signing classes

| Artifact | Class | Installability |
| --- | --- | --- |
| Trainer Android release APK | unsigned release | Not normally installable until signed |
| Bike Bridge staging release APK | unsigned release | Not normally installable until signed |
| Bike Bridge staging debug APK | debug-signed | Sideloadable; `adb install -r` needs the **same** debug certificate as any already-installed staging build |
| Bike Bridge production APK | production-signed, opt-in only | Upgrades require the production signing certificate already used on that console |
| iOS IPA | not produced in CI | No macOS runner or App Store signing in this repository's workflows |
| Web zip | unsigned static files | Host on any static HTTPS server |

Do not present unsigned APKs as install-ready releases.

## Remaining gates (not version consistency)

- Trainer Android Play/sideload signing
- iOS distribution signing and a macOS build
- Production Bike Bridge physical-device qualification on the ProForm Smart Power 10.0 console (Android 5.1.1 / API 22 / x86)
- Console storage: measure APK size before installing on stock hardware
