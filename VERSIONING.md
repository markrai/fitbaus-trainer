# FitBaus product versioning

FitBaus uses one unified product version across Trainer web/PWA, Capacitor
Android and iOS, Native Bike Bridge, and arcade (shipped inside the Bridge
APK). **1.0.0** was the first unified release. The published release history is
available on the [GitHub Releases page](https://github.com/markrai/fitbaus-trainer/releases).

There is one authoritative source: [`version.js`](version.js).

```js
const APP_VERSION = "2.6.0";
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
  (UVC) webcam support and native YouTube playback. Do not merge webcam into Lite.

Product versioning stays unified via `version.js`. Edition differences use
artifact filenames (for example `fitbaus-bikebridge-full-2.1.0.apk` vs
`fitbaus-bikebridge-lite-1.0.1.apk`), not package-ID forks.

Maintainer procedure, secrets, certificate pins, and recommended hardware testing:
see [.github/release/RELEASE.md](.github/release/RELEASE.md).

## GitHub release procedure

Merge the version bump and changelog, then create and push the matching annotated tag:

```bash
git tag -a v2.6.0 -m "FitBaus Full 2.6.0"
git push origin v2.6.0
```

After successful tag CI, the Release workflow builds, signs, verifies and publishes
automatically. For an existing tag, use `gh workflow run release.yml --ref main -f tag=v2.6.0`.
The release uses default-branch tooling and immutable tagged application source.
Physical console acceptance is recommended, but is not a publication gate.

The older **Release artifacts** workflow remains inspection-oriented legacy packaging.

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
- Recommended physical testing of the production Bike Bridge, not a publication gate
- iOS distribution signing and a macOS build
- Console storage: measure APK size before installing on stock hardware
