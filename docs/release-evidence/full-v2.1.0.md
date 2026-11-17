# Full v2.1.0 — Bike Bridge physical acceptance

## Candidate

| Field | Value |
| --- | --- |
| Edition | full |
| Version | 2.1.0 (versionCode 20100) |
| Application ID | `com.fitbaus.bikebridge` |
| Artifact | `fitbaus-bikebridge-full-2.1.0.apk` |
| APK SHA-256 | `7b065bd91736adabc56b753dbc8301a9e54bb3a8c3f262d23fd990b1c906a7a7` |
| Signing cert SHA-256 | `5B2C6916536EBA269F9F47C925CC2B16A455CD80340A4F95C3E3CBBBFC42AF0C` |
| Source commit | `76bfbd482d7c3043c39a3e20e72ed074a6db4dd3` |
| Source tag | `v2.1.0` |
| Tooling ref | `dd6422212b0e23c9ed3073198c7375c3398bd406` |
| Inspection workflow run | [43996945131](https://github.com/markrai/fitbaus-trainer/actions/runs/43996945131) |
| Provenance | `fitbaus-release-candidate` artifact → `release-candidate.json` (createdAt `2026-11-17T01:41:58.711Z`) |

Hashes above are taken from `release-candidate.json` → `artifacts.bridgeApk`.

## Console

| Field | Value |
| --- | --- |
| Hardware | ProForm Smart Power 10.0 |
| Platform | Android 5.1.1 / API 22 (`byt_t_crv2`) |
| Acceptance date | 2026-11-16 (America/New_York) |

## Candidate verification

1. **Run artifact.** The `fitbaus-release-candidate` artifact from inspection run `43996945131` contains `release-candidate.json` with edition `full`, version `2.1.0`, versionCode `20100`, source tag `v2.1.0`, source commit `76bfbd482d7c3043c39a3e20e72ed074a6db4dd3`, and workflow run ID `43996945131`.
2. **Tag binding.** Annotated tag `v2.1.0` peels to `76bfbd482d7c3043c39a3e20e72ed074a6db4dd3`.
3. **Exact binary binding.** Local SHA-256 of the downloaded `fitbaus-bikebridge-full-2.1.0.apk` matched `artifacts.bridgeApk.sha256` and the `SHA256SUMS.txt` entry.
4. **Candidate validation.** `scripts/release/validate-release-candidate.cjs --tag v2.1.0 --commit 76bfbd482d7c3043c39a3e20e72ed074a6db4dd3 --edition full --workflow-run-id 43996945131` passed against the downloaded artifact.
5. **Identity.** `apksigner verify --print-certs` reported signer SHA-256 `5b2c6916536eba269f9f47c925cc2b16a455cd80340a4f95c3e3cbbbfc42af0c`; `aapt dump badging` reported package `com.fitbaus.bikebridge`, versionCode `20100`, versionName `2.1.0`.

## Physical checks passed

Results confirmed by the operator on the console listed above:

1. **Upgrade install.** `adb install -r` of the exact APK succeeded; the installed package reported versionName `2.1.0` and versionCode `20100`.
2. **Pairing continuity.** The existing Bike Bridge pairing was retained without re-pairing.
3. **Telemetry.** Cadence, watts and telemetry passed.
4. **Resistance.** Controlled resistance passed.
5. **Face-tracking games.** BIKETRIS and another face-tracking game passed.
6. **External webcam.** External USB webcam preview and game input passed.
7. **YouTube.** Playback, audio, seeking, brightness and volume passed.
8. **Endurance.** Ten-minute playback with Bridge telemetry healthy passed.

No telemetry measurements or device logs are recorded in this file.

## Registry

Qualification binding is recorded in `.github/release/physical-qualification.json` for version `2.1.0`, pointing at this evidence file.
