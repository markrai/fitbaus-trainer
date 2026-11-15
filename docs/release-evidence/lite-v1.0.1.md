# Lite v1.0.1 — Bike Bridge physical acceptance

## Candidate

| Field | Value |
| --- | --- |
| Edition | lite |
| Version | 1.0.1 (versionCode 10001) |
| Application ID | `com.fitbaus.bikebridge` |
| Artifact | `fitbaus-bikebridge-lite-1.0.1.apk` |
| APK SHA-256 | `f9ec401394d11a27cda3cb88417769734263a4a551e1d9c9fab7fd469f600a61` |
| Signing cert SHA-256 | `5B2C6916536EBA269F9F47C925CC2B16A455CD80340A4F95C3E3CBBBFC42AF0C` |
| Source commit | `cf91c7d32fe54315cb5e1ec5488e8f477abe9a50` |
| Source tag | `v1.0.1` |
| Inspection workflow run | [43664785729](https://github.com/markrai/fitbaus-trainer/actions/runs/43664785729) |
| Provenance | `release-candidate-v1.0.1/release-candidate.json` |

Hashes above are taken from `release-candidate.json` → `artifacts.bridgeApk`.

## Console

| Field | Value |
| --- | --- |
| Hardware | ProForm Smart Power 10.0 |
| Platform | Android 5.1.1 / API 22 / x86 (`byt_t_crv2`) |
| ADB endpoint | `192.168.1.226:5555` |
| Acceptance date | 2026-11-14 (America/New_York) |

## Checks passed

1. **Exact binary binding.** Local SHA-256 of `release-candidate-v1.0.1/fitbaus-bikebridge-lite-1.0.1.apk` matched `artifacts.bridgeApk.sha256` from `release-candidate.json` for inspection run `43664785729`.
2. **Console connectivity.** ADB listed the bike as `device` (`product:byt_t_crv2_64`, `model:byt_t_crv2`).
3. **Production install.** `adb -s 192.168.1.226:5555 install -r` of that exact APK completed with `Success`.
4. **Identity.** Candidate metadata confirms production application ID `com.fitbaus.bikebridge`, minSdk 22, and the Bridge production cert SHA-256 recorded above.

## Registry

Qualification binding is recorded in `.github/release/physical-qualification.json` for version `1.0.1`, pointing at this evidence file.
