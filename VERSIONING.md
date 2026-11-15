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

## Editions and release tracks

- **FitBaus Lite 1.x** — maintenance on `lite/1.x` from `v1.0.0`; no external UVC.
- **FitBaus Full 2.x** — feature work toward `main` (webcam support lives on
  `feature/external-webcam` until promoted). Do not merge webcam into Lite.

Product versioning stays unified via `version.js`. Edition differences use
artifact filenames (for example `fitbaus-bikebridge-lite-1.0.0.apk`), not
package-ID forks.

Maintainer procedure, secrets, certificate pins, and physical qualification:
see [docs/RELEASE.md](docs/RELEASE.md).

## GitHub release procedure (Point A)

Public installers are produced by **Release** (`.github/workflows/release.yml`):

1. Ensure the release tag already exists (for example annotated `v1.0.0`).
2. Fill signing secrets and certificate pins; record Bridge physical qualification
   before `mode=publish` (details in `docs/RELEASE.md`).
3. Run **Release** with `tag=v1.0.0`, matching `expected_commit`, `edition=lite`,
   `mode=inspect`.
4. Confirm Actions artifacts, fingerprints, and `SHA256SUMS.txt`.
5. Re-run with `mode=publish`. GitHub Actions attaches the verified public files.
   Maintainers do not manually sign APKs or re-upload assets for the happy path.

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

- Populate Trainer and Bridge certificate pins in `.github/release/signing-policy.json`
- Configure GitHub Actions signing secrets
- Production Bike Bridge physical-device qualification record for each published version
- iOS distribution signing and a macOS build
- Console storage: measure APK size before installing on stock hardware
