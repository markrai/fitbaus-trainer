# FitBaus Full 2.2.0 release checklist

> Historical release plan. The automatic release workflow supersedes the manual inspection and qualification gates documented below. See [Release engineering](../RELEASE.md).

**Status: source preparation.** No `v2.2.0` tag, signed candidate, physical qualification, or public GitHub Release exists yet. This checklist tracks the remaining release gates.

FitBaus Full 2.2.0 is a minor product version, not a separate edition. The canonical version is `2.2.0` in `version.js`, giving Android `versionCode 20200`. The latest published Full release is 2.1.0; the intervening 2.1.1–2.1.3 work is included without publishing those development versions.

## Merge and source gates

- [x] Merge [#77](https://github.com/markrai/fitbaus-trainer/pull/77), preparing the 2.2.0 product version and release checklist.
- [x] Merge [#75](https://github.com/markrai/fitbaus-trainer/pull/75), renaming the game-selection captions to MAVERICK, TRAILS and IT HEARS YOU.
- [x] Merge [#76](https://github.com/markrai/fitbaus-trainer/pull/76), removing the flashing orange proximity-edge markers in TRAILS.
- [x] Merge [#79](https://github.com/markrai/fitbaus-trainer/pull/79), adding the YouTube search microphone.
- [x] Merge [#81](https://github.com/markrai/fitbaus-trainer/pull/81), replacing the external recognizer with bundled offline speech, adding publication-age labels, and showing a red recording circle.
- [x] Reconcile the 2.2.0 changelog with all merged game, YouTube and voice-search changes. Use an undated `[2.2.0]` entry until GitHub publishes the release; the public Release page supplies its actual publication date.
- [ ] Merge documentation/release preparation [#80](https://github.com/markrai/fitbaus-trainer/pull/80), confirm no required fixes remain open, and freeze the exact `main` commit for the release.
- [ ] Both CI jobs pass on that final `main` commit: Trainer and Native Bike Bridge.
- [ ] Verify `npm run build`, `npm run check:version`, `npm test`, and Android unit tests. The CI Trainer job also requires `git diff --exit-code` after building.
- [ ] Confirm available storage on the console accommodates the signed APK, the bundled compressed speech model, and its first-run extraction without impairing existing workouts or apps.

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
- [ ] Confirm the APK contains the pinned 40 MB offline speech model and only the expected x86 native libraries, with production signing intact.
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
- [ ] YouTube search: verify the included Vosk x86/JNA libraries and checksum-verified English model are in the signed APK; install/update requires no Google services, separate speech app, account, model download, or Android settings changes.
- [ ] Voice search first run: measure private model extraction size/time, initial recognition startup, microphone input at 16 kHz and clear English transcriptions. Compare repeated searches after startup and ensure the bike remains responsive.
- [ ] While preparing, the normal microphone remains. When audio capture begins, the icon changes to a red circle. Tapping it cancels, restores the microphone and preserves typed text. Verify blank speech, errors and tab exits also clean up without an unexpected search.
- [ ] Verify the `:speech` process stops after completion/cancellation and does not affect ongoing Bike Bridge cadence, resistance, or camera state. Measure peak memory (PSS/RSS), CPU, temperature and low-memory process kills while repeatedly searching, entering games and returning from video playback. Do not qualify the release if the recognizer destabilizes the console.
- [ ] Verify tapping the search microphone never starts recognition while an active video player is using resources.
- [ ] Video previews: channel, views and relative age appear for available valid publication dates (minutes/hours/days/months/years); narrow cards can wrap metadata. Confirm missing/future dates and live videos omit age; Google playlist insertion dates are not mistaken for video publication dates.
- [ ] YouTube channel avatar navigation, captions, video seeking, volume, brightness, and account sign-in remain functional.
- [ ] Sustained playback for at least 10 minutes, with telemetry healthy, acceptable frame rate, memory and console temperature.

Record the actual tests, date, results, inspect run ID, source commit, signer fingerprint and APK SHA-256 in `.github/release/evidence/full-v2.2.0.md`. Do not copy historical qualification data or claim a pass without performing the test.

## Register qualification and publish

- [ ] Add the exact-binary qualification record in `.github/release/physical-qualification.json`, matching the source commit, APK SHA-256, signing certificate, package, version and new evidence path; merge it into `main`.
- [ ] Confirm the protected GitHub `release` Environment is restricted to `main` and the signing secrets remain configured.
- [ ] Re-run **Actions → Release** on `main` with the **same** `tag=v2.2.0`, `expected_commit` and `edition=full`; set `mode=publish` and `candidate_run_id` to the successful qualified inspect run ID.
- [ ] Confirm the workflow publishes **FitBaus Full 2.2.0** and that all six public files match the inspect candidate's checksums.

`mode=publish` deliberately refuses unqualified or modified candidates; it does not rebuild the APK. See [the full release procedure](../RELEASE.md).
