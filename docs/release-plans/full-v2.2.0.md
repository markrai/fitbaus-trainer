# FitBaus Full 2.2.0 release checklist

**Status: candidate preparation only.** No v2.2.0 tag, signed candidate, physical qualification, or public GitHub Release is asserted by this document.

FitBaus Full 2.2.0 is a minor product version, not a separate edition. The canonical version is `2.2.0` in `version.js`, giving Android `versionCode 20200`. The latest published Full release is 2.1.0; the intervening 2.1.1–2.1.3 work is included without publishing those development versions.

## Merge and source gates

- [ ] Merge [#75](https://github.com/markrai/fitbaus-trainer/pull/75), renaming the game-selection captions to MAVERICK, TRAILS and IT HEARS YOU.
- [ ] Merge [#76](https://github.com/markrai/fitbaus-trainer/pull/76), removing the flashing orange proximity-edge markers in TRAILS.
- [ ] Merge this release-preparation PR after both are in `main`, and ensure no required follow-up fixes remain open.
- [ ] Check `CHANGELOG.md` for the #75 and #76 changes, add their release entries, and replace `Pending publication` with the actual release date before tagging.
- [ ] Both CI jobs pass for the final `main` source commit: Trainer and Native Bike Bridge.
- [ ] Verify `npm run build`, `npm run check:version`, `npm test`, and Android unit tests. The CI Trainer job additionally requires `git diff --exit-code` after the build.
- [ ] Confirm console free storage is sufficient for the actual signed APK before installation.

## Tag the exact source

After the final release commit is merged and CI is green:

```bash
git fetch origin --tags
git switch main
git pull --ff-only
npm ci
npm run build
npm run check:version
git diff --exit-code
git tag -a v2.2.0 -m "FitBaus Full 2.2.0"
git push origin v2.2.0
git rev-parse 'v2.2.0^{commit}'
```

**Never retarget an existing release tag.** Save the 40-character peeled commit hash. The Release workflow must execute on the default `main` branch with the exact immutable `v2.2.0` tag; it does not create the tag or build from an arbitrary branch.

## Inspect the signed release candidate

Open **Actions → Release → Run workflow**, choose the `main` branch, and enter:

| Input | Value |
| --- | --- |
| `tag` | `v2.2.0` |
| `expected_commit` | Exact peeled commit SHA from the command above |
| `edition` | `full` |
| `mode` | `inspect` |
| `candidate_run_id` | Leave blank |

The inspect workflow must build, sign and verify both APKs, including the production Bike Bridge package `com.fitbaus.bikebridge` (Android 5.1.1/API 22, x86, v1 signature). It also emits the Trainer APK, web bundle, `SHA256SUMS.txt`, `ARTIFACTS.md`, and `release-candidate.json` in the `fitbaus-release-candidate` artifact.

- [ ] Inspect run succeeded; record its GitHub Actions run ID.
- [ ] Extract the artifact and verify every published-file SHA-256, APK identity, `versionName 2.2.0`, `versionCode 20200`, and both signing certificates against `.github/release/signing-policy.json`.
- [ ] Preserve the exact candidate's `artifacts.bridgeApk.sha256`, `sourceCommit`, and `workflowRunId`. Do not substitute a locally rebuilt/debug APK.

## Qualify the exact candidate on the ProForm console

Use the signed `fitbaus-bikebridge-full-2.2.0.apk` from that inspect run. Back up the existing APK, check available storage, then use `adb install -r`. **Never uninstall the production app just to upgrade**, as that erases pairing.

- [ ] Installed version reports `2.2.0` / `20200`, production package identity, and retained bike pairing.
- [ ] Live cadence, watts, and resistance control continue functioning throughout game and YouTube use.
- [ ] Game-selection labels read MAVERICK, TRAILS, and IT HEARS YOU.
- [ ] TRAILS: edges remain visible but never flash orange; steering, edge slowdown, jump animation, tortoises and crash recovery still work.
- [ ] MAVERICK: face tracking, controller selection/remapping and flight visuals work.
- [ ] IT HEARS YOU: industrial GL rendering, controller/webcam steering, visibility after tab switches, multiple-ghoul behavior and map overlay work.
- [ ] Bricks and Biketris controller inputs, mappings, auto-restart or pedal-to-slow mode behave as intended.
- [ ] External USB webcam is available and camera-game switching operates correctly.
- [ ] YouTube: open videos directly from Discover and Search. Verify **the entire frame renders without a black left half**, across multiple videos and resolutions, and after repeated switch-to-floating-preview/restore transitions.
- [ ] YouTube voice search mic launches the installed speech recognizer when available, submits recognized text and leaves canceled searches untouched; on consoles without a recognizer it reports that limitation without crashing.
- [ ] YouTube channel avatar navigation, captions, video seeking, volume, brightness, and account sign-in remain functional.
- [ ] Sustained playback for at least 10 minutes, with telemetry healthy, acceptable frame rate, memory and console temperature.

Record the actual tests, date, results, inspect run ID, source commit, signer fingerprint and APK SHA-256 in `docs/release-evidence/full-v2.2.0.md`. Do not copy historical qualification data or claim a pass without performing the test.

## Register qualification and publish

- [ ] Add the exact-binary qualification record in `.github/release/physical-qualification.json`, matching the source commit, APK SHA-256, signing certificate, package, version and new evidence path; merge it into `main`.
- [ ] Confirm the protected GitHub `release` Environment is restricted to `main` and the signing secrets remain configured.
- [ ] Re-run **Actions → Release** on `main` with the **same** `tag=v2.2.0`, `expected_commit` and `edition=full`; set `mode=publish` and `candidate_run_id` to the successful qualified inspect run ID.
- [ ] Confirm the workflow publishes **FitBaus Full 2.2.0** and that all six public files match the inspect candidate's checksums.

`mode=publish` deliberately refuses unqualified or modified candidates; it does not rebuild the APK. See [the full release procedure](../RELEASE.md).
