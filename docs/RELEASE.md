# FitBaus release engineering

This document is for maintainers. End users only need the public GitHub Release
assets for their edition.

## Editions

| Edition | Branch | Webcam | Audience |
| --- | --- | --- | --- |
| **FitBaus Lite 1.x** | `lite/1.x` (starts at `v1.0.0`) | No external UVC | Storage-constrained ProForm Smart Power 10.0 consoles; limited maintenance |
| **FitBaus Full 2.x** | developed toward `main` (currently `feature/external-webcam`) | Optional USB webcam | Ongoing feature development |

Default GitHub branch remains `main`. Do not merge webcam work into Lite.

Package IDs stay unified across editions:

- Trainer: `com.markrai.fitbaus.trainer`
- Bike Bridge production: `com.fitbaus.bikebridge`
- Bike Bridge staging: `com.fitbaus.bikebridge.native` (engineering only)

Lite versus Full is a **filename / maintenance-track** distinction, not a package-ID fork.

## Why the old pipeline stopped at inspection

`.github/workflows/release-artifacts.yml` was intentionally inspection-only:

1. Trainer release APKs were assembled **unsigned** (no Trainer signing config).
2. Production Bike Bridge packaging was opt-in and still did not publish.
3. `dry_run=false` failed closed; the workflow never created a GitHub Release.
4. Maintainer had to download Actions artifacts, sign/arrange files, and attach them manually.

Point A replaces that with `.github/workflows/release.yml`.

**Trust boundary:** the workflow runs only from the repository **default branch**,
uses the protected GitHub Environment `release` for signing/publication secrets,
and never accepts arbitrary feature-branch workflow code with production credentials.
Historical application source may still come from an immutable tag.

**Required Environment setting:** configure GitHub Environment `release` with
**Deployment branches** restricted to the default branch (`main`) only. Do not allow
`chore/*`, `feature/*`, or other refs. The workflow also fails closed unless
`GITHUB_REF` equals `refs/heads/${{ github.event.repository.default_branch }}`, but
Environment branch filters are the primary control that keeps signing secrets off
non-default branches.

## Architecture: tooling vs source

| Tree | Role |
| --- | --- |
| Workflow checkout (`tooling/`) | Scripts, workflows, signing policy, physical-qualification registry |
| Tag checkout (`source/`) | Exact application revision for `vX.Y.Z` (inspect only) |

The annotated tag `v1.0.0` remains immutable and peels to
`9847e9f5dd828cf28f1a85320b2142ec4d3f5126`. Newer release tooling must not rewrite
that tag or its source. `expected_commit` is **required** on every run (no hardcoded
default for future versions).

Trainer APKs from historical source may still be unsigned from Gradle; the release
workflow aligns + signs them with `apksigner` (`env:` password refs, v1 enabled).
Bike Bridge production signing uses temporary `local.properties` for historical
`bikebridge.signing.*` support (API 22 / x86) without putting passwords on `-P`.

## Build → qualify → publish sequence

1. **inspect** (default branch): build/sign/verify; upload artifact
   `fitbaus-release-candidate` containing public files + `release-candidate.json`.
2. **Physical qualify** the exact Bridge APK from that candidate (console acceptance).
3. Record the exact binding in `.github/release/physical-qualification.json` and
   fill certificate pins.
4. **publish**: download that candidate by `candidate_run_id`; verify pins +
   exact apkSha256/sourceCommit/cert; draft Release → upload → verify remote
   hashes → only then undraft/publish.

Rebuild-on-publish is intentionally avoided so the public Bridge binary is the
qualified candidate.

## Public artifacts (Lite 1.0.0)

- `fitbaus-trainer-android-1.0.0.apk`
- `fitbaus-bikebridge-lite-1.0.0.apk`
- `fitbaus-trainer-web-1.0.0.zip`
- `SHA256SUMS.txt`
- `ARTIFACTS.md`
- `release-candidate.json` (provenance)

Unsigned, staging, and debug APKs may appear under Actions inspection output only.

## Signing responsibilities

### Trainer

1. Create a **persistent** release keystore (one-time).
2. Back it up offline (encrypted). Losing it prevents `adb install -r` upgrades.
3. Store GitHub Actions secrets (never commit the keystore):
   - `TRAINER_SIGNING_STORE_BASE64`
   - `TRAINER_SIGNING_STORE_PASSWORD`
   - `TRAINER_SIGNING_KEY_ALIAS`
   - `TRAINER_SIGNING_KEY_PASSWORD`
4. Record the certificate SHA-256 in `.github/release/signing-policy.json`
   under `com.markrai.fitbaus.trainer` before **publish**.

There was no prior public Trainer release installer; certificate continuity with
field devices must still be checked if any sideloaded Trainer builds exist.

### Bike Bridge production

1. Use the **existing** production keystore already used on consoles.
2. Never create a replacement production certificate silently.
3. Secrets:
   - `BIKEBRIDGE_SIGNING_STORE_BASE64`
   - `BIKEBRIDGE_SIGNING_STORE_PASSWORD`
   - `BIKEBRIDGE_SIGNING_KEY_ALIAS`
   - `BIKEBRIDGE_SIGNING_KEY_PASSWORD`
4. Pin the certificate SHA-256 in `.github/release/signing-policy.json`
   under `com.fitbaus.bikebridge` before **publish**.

Release builds **fail closed** when signing secrets are missing. There is no
debug-signing fallback for public installers.

### Fingerprint helper

```bash
keytool -list -v -keystore bikebridge-release.jks
# use SHA-256, uppercase hex without colons, in signing-policy.json
```

## Physical qualification gate

CI packaging is **not** physical-device qualification.

Before `mode=publish`, add a record binding the **exact** Bridge candidate:

```json
{
  "versionName": "1.0.0",
  "applicationId": "com.fitbaus.bikebridge",
  "status": "qualified",
  "certSha256": "<PINNED_CERT_SHA256>",
  "apkSha256": "<BRIDGE_APK_SHA256_FROM_release-candidate.json>",
  "sourceCommit": "9847e9f5dd828cf28f1a85320b2142ec4d3f5126",
  "evidenceRef": "<path or URL to acceptance evidence>",
  "console": "ProForm Smart Power 10.0",
  "notes": "Date and acceptance summary"
}
```

Supported Bridge hardware for Lite: **ProForm Smart Power 10.0** (Android 5.1.1 /
API 22 / 32-bit x86) only.

## Maintainer: install tooling on main, then Lite 1.0.0

1. Review `chore/release-pipeline` locally (do not publish yet).
2. Create GitHub Environment `release`; add the eight signing secrets there.
3. Restrict Environment **Deployment branches** to `main` only; required reviewers optional but recommended.
4. Merge release tooling to `main` when approved (**without** moving `v1.0.0`).
5. Create/backup Trainer keystore; confirm Bridge production keystore continuity.
6. Fill certificate pins in `.github/release/signing-policy.json` (follow-up commit).

Inspect / qualify / publish:

1. On **main**, Actions → **Release** → `tag=v1.0.0`,
   `expected_commit=9847e9f5dd828cf28f1a85320b2142ec4d3f5126`,
   `edition=lite`, `mode=inspect`.
2. Download `fitbaus-release-candidate`; note Bridge `apkSha256` + certs from
   `release-candidate.json`.
3. Install/qualify that exact Bridge APK on the console; store evidence.
4. Commit the physical-qualification record + cert pins.
5. Re-run **Release** with `mode=publish` and `candidate_run_id=<inspect run id>`.
6. Confirm the GitHub Release is **published** (not draft) and assets match
   `SHA256SUMS.txt` / `release-candidate.json`.

## Safe retries

- Draft release, missing asset → uploaded
- Existing asset with identical SHA-256 → skipped
- Existing asset with different content → **fails closed**
- Already **published** release missing/different assets → **fails closed**
- Failed upload leaves a newly created release as **draft** (publish happens last)

## Local validation vs GitHub Actions

| Step | Local without production secrets | Needs GitHub Actions + secrets |
| --- | --- | --- |
| Tag/commit resolve | yes | yes |
| Unit tests / version checks | yes | yes |
| Missing-secret / wrong-pin / unsigned gates | yes (fixtures) | yes |
| Real `apksigner` / production Bridge assemble | only with local keystores | yes |
| GitHub Release attach | no (dry-run only) | yes |
| Physical console acceptance | no | hardware |

Do not simulate successful signing or publication when credentials are absent.

## End-user download guidance

1. Open the GitHub Release for the version you want.
2. Download the Trainer APK and/or Bike Bridge Lite APK for your console, plus the web zip if self-hosting.
3. Verify checksums with `SHA256SUMS.txt` when possible.
4. Install APKs with a file manager or `adb install -r` **using the same certificates** as any already-installed FitBaus apps.
