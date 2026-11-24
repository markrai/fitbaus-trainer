# Full v2.2.0 — Bike Bridge physical acceptance

## Candidate

| Field | Value |
| --- | --- |
| Edition | full |
| Version | 2.2.0 (versionCode 20200) |
| Application ID | `com.fitbaus.bikebridge` |
| Artifact | `fitbaus-bikebridge-full-2.2.0.apk` |
| APK SHA-256 | `252d8c0f32f0ad185089f0c2a45f9085a7f1c32f68a6c3a1b4014372d3bed751` |
| Signing cert SHA-256 | `5B2C6916536EBA269F9F47C925CC2B16A455CD80340A4F95C3E3CBBBFC42AF0C` |
| Source commit | `5b1dc8e78d5123fc5c9432cde6b53092eeb09b7d` |
| Source tag | `v2.2.0` |
| Tooling ref | `5b1dc8e78d5123fc5c9432cde6b53092eeb09b7d` |
| Inspection workflow run | [45295031342](https://github.com/markrai/fitbaus-trainer/actions/runs/45295031342) |
| Provenance | `fitbaus-release-candidate` artifact → `release-candidate.json` (createdAt `2026-11-24T00:23:43.946Z`) |

The APK SHA-256 above was verified against both `release-candidate.json` and `SHA256SUMS.txt` from the successful inspect candidate.

## Console

| Field | Value |
| --- | --- |
| Hardware | ProForm Smart Power 10.0 |
| Platform | Android 5.1.1 / API 22, x86 |
| Acceptance date | 2026-11-23 (America/New_York) |

## Acceptance

The exact signed candidate from inspection run `45295031342` was installed in place with `adb install -r` on the production console. Installation succeeded and the operator reported **PASS** for the candidate and approved it for release.

No alternate APK, local rebuild, or substituted binary was used for this qualification record.

## Registry

Qualification binding is recorded in `.github/release/physical-qualification.json` for version `2.2.0`, pointing at this evidence file.
