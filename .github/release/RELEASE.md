# FitBaus release engineering

This document is for maintainers. End users only need the public GitHub Release
assets for their edition.

## Editions and the version contract

FitBaus has one numeric version namespace and two editions. The edition is not
part of `versionName` or `versionCode`; it is a maintenance track, a release
title, and a Bike Bridge filename.

| Edition | Versions | Branch | Release title | Bike Bridge asset | Scope |
| --- | --- | --- | --- | --- | --- |
| **Lite** | `1.x.x` | `lite/1.x` | `FitBaus Lite X.Y.Z` | `fitbaus-bikebridge-lite-X.Y.Z.apk` | Compact maintenance edition for storage-constrained consoles; no external UVC webcam |
| **Full** | `2.x.x` | `main` | `FitBaus Full X.Y.Z` | `fitbaus-bikebridge-full-X.Y.Z.apk` | Ongoing feature edition: external USB (UVC) webcam, native YouTube playback |

`versionCode = major * 10000 + minor * 100 + patch` (see [VERSIONING.md](../../VERSIONING.md)).
Full 2.1.0 is `versionName 2.1.0`, `versionCode 20100`, tag `v2.1.0`.

The rules live in one place, `scripts/release/edition.cjs`:

- only `lite` and `full` are accepted (exact, lowercase);
- Lite requires major version 1 and Full requires major version 2;
- a tag must be `v` plus the same version;
- canonical artifact names, the release title and package identities derive
  from the edition and version.

Artifact naming (`common.cjs`), `ARTIFACTS.md`, the release candidate writer and
validator, the tag/source guard and the workflow's publish step all use it.
An invalid combination fails before builds, signing or any GitHub Release call.

```bash
node scripts/release/edition.cjs --edition full --tag v2.1.0
node scripts/release/edition.cjs --edition full --tag v2.1.0 --field title    # FitBaus Full 2.1.0
node scripts/release/edition.cjs --edition full --tag v2.1.0 --field assets   # the six public files
```

## Shared identities and upgrade continuity

Both editions ship the same application identities and certificates:

| Component | Package | Min SDK | Certificate SHA-256 (pinned in `.github/release/signing-policy.json`) |
| --- | --- | --- | --- |
| Trainer | `com.markrai.fitbaus.trainer` | 24 | `38A830D320081E59BBDA44CD52BFEF10D6CD7473E31281A27C0D010CF4FE8DAA` |
| Bike Bridge (production) | `com.fitbaus.bikebridge` | 22 (x86, v1 signature) | `5B2C6916536EBA269F9F47C925CC2B16A455CD80340A4F95C3E3CBBBFC42AF0C` |

`com.fitbaus.bikebridge.native` is the staging Bridge identity and is never a
public installer. Because the package and certificate are shared and Full
version codes are higher, Full installs over Lite with `adb install -r` without
uninstalling and keeps Bike Bridge pairing.

## Trust boundary

`.github/workflows/release.yml` is the only publication path
(`release-artifacts.yml` remains inspection-only and never publishes).

- The workflow runs only from the repository **default branch**
  (`GITHUB_REF` must equal `refs/heads/<default branch>`).
- Signing and publication secrets live in the protected GitHub Environment
  `release`. Restrict its **Deployment branches** to `main` only; this is the
  primary control that keeps signing secrets off other refs.
- Application source comes from an **existing, immutable tag** that the
  workflow never creates or moves. Tooling (`tooling/`) and source (`source/`)
  are separate checkouts.
- `expected_commit` is required on every run and must equal the peeled tag.
- In `mode=inspect`, the tag must equal `v` + the source `version.js`, and that
  version must belong to the chosen edition, before npm/Gradle builds or signing.
- Public APKs are release-signed and verified (`aapt`/`apksigner`), and their
  certificates must match the pins. There is no debug-signing fallback; missing
  secrets fail closed.
- `mode=publish` never rebuilds. It downloads the candidate from a prior
  successful inspect run of this workflow on the default branch, revalidates
  it, checks physical qualification of the exact Bridge APK, creates a **draft**
  Release, uploads, verifies remote hashes, and only then publishes.

## Workflow inputs

| Input | Required | Notes |
| --- | --- | --- |
| `tag` | yes | Existing tag, e.g. `v2.1.0`. Never created by the workflow. |
| `expected_commit` | yes | 40-hex peeled commit of `tag`. |
| `edition` | yes (default `lite`) | `lite` or `full`; must match the tag's major version. |
| `mode` | yes (default `inspect`) | `inspect` builds the signed candidate; `publish` attaches and publishes it. |
| `candidate_run_id` | publish only | Run ID of the inspect run whose candidate was qualified. |

### Obtaining the immutable source commit

```bash
git fetch origin --tags
git rev-parse 'v2.1.0^{commit}'                 # peeled commit
git ls-remote origin 'refs/tags/v2.1.0^{}'      # same commit as seen on GitHub
git show 'v2.1.0:version.js' | grep APP_VERSION # must declare 2.1.0
```

Use the peeled commit (not the annotated tag object) as `expected_commit`.

### Finding the inspect run ID

The run ID is the number in the run URL
`https://github.com/markrai/fitbaus-trainer/actions/runs/<run id>`, or:

```bash
gh run list --workflow release.yml --limit 5
```

The candidate's `release-candidate.json` records the same value as
`workflowRunId`; publish fails if they differ.

## Public artifacts

| File | Lite 1.0.1 | Full 2.1.0 |
| --- | --- | --- |
| Trainer APK | `fitbaus-trainer-android-1.0.1.apk` | `fitbaus-trainer-android-2.1.0.apk` |
| Bike Bridge APK | `fitbaus-bikebridge-lite-1.0.1.apk` | `fitbaus-bikebridge-full-2.1.0.apk` |
| Web/PWA bundle | `fitbaus-trainer-web-1.0.1.zip` | `fitbaus-trainer-web-2.1.0.zip` |
| Checksums | `SHA256SUMS.txt` | `SHA256SUMS.txt` |
| Release notes | `ARTIFACTS.md` | `ARTIFACTS.md` |
| Provenance | `release-candidate.json` | `release-candidate.json` |

`release-candidate.json` (schema 1) records edition, version name and code,
source tag and commit, tooling revision, workflow run ID, and for each file its
canonical name and SHA-256, plus package ID, minimum SDK and certificate for the
APKs. Publish rejects a candidate whose names, package identities, version code,
hashes or `SHA256SUMS.txt` entries disagree with the edition and version, even
if the caller supplies matching but invalid inputs.

Unsigned, staging and debug APKs appear only in the separate inspection dump.

## Full 2.1.0: inspect, qualify, publish

1. **Tag.** A maintainer creates the annotated tag `v2.1.0` on the `main`
   commit whose `version.js` declares `2.1.0`, and pushes it. Note the peeled
   commit (see above).
2. **Inspect.** Actions → **Release** on `main` with `tag=v2.1.0`,
   `expected_commit=<peeled commit>`, `edition=full`, `mode=inspect`. The run
   builds, signs, verifies, and uploads `fitbaus-release-candidate`.
3. **Collect the candidate.** Download `fitbaus-release-candidate`. From
   `release-candidate.json` record `artifacts.bridgeApk.sha256`, the
   certificates, `sourceCommit` and `workflowRunId`, and check the files against
   `SHA256SUMS.txt`.
4. **Physically qualify the exact APK.** Install
   `fitbaus-bikebridge-full-2.1.0.apk` from that candidate on the ProForm Smart
   Power 10.0 over the existing installation (`adb install -r`), confirm pairing
   survives, and run the console acceptance checks (USB connection and
   telemetry, resistance control, games, webcam, YouTube playback, sustained
   use). Write the evidence to `.github/release/evidence/full-v2.1.0.md`.
5. **Record qualification.** Add a record for that exact binary to
   `.github/release/physical-qualification.json` and merge it to `main`:

   ```json
   {
     "versionName": "2.1.0",
     "applicationId": "com.fitbaus.bikebridge",
     "status": "qualified",
     "certSha256": "5B2C6916536EBA269F9F47C925CC2B16A455CD80340A4F95C3E3CBBBFC42AF0C",
     "apkSha256": "<artifacts.bridgeApk.sha256 from the inspect candidate>",
     "sourceCommit": "<peeled v2.1.0 commit>",
     "evidenceRef": ".github/release/evidence/full-v2.1.0.md",
     "console": "ProForm Smart Power 10.0",
     "notes": "<date and acceptance summary>"
   }
   ```

   A record matches only when version, package, certificate, APK hash and
   source commit are all identical. Lite 1.0.1's record cannot qualify a Full
   build, and a rebuilt APK with the same version needs its own record.
6. **Publish.** Re-run **Release** on `main` with the same `tag`,
   `expected_commit` and `edition=full`, `mode=publish`, and
   `candidate_run_id=<inspect run ID>`. The title is `FitBaus Full 2.1.0`.
7. **Confirm** the Release is published (not a draft) and its assets match
   `SHA256SUMS.txt` and `release-candidate.json`.

A green inspect run is **not** physical-console acceptance. CI proves the build
is signed, versioned and internally consistent; only step 4 proves the exact
Bridge binary works on the console. Publish refuses to run until step 5 exists.

## Lite maintenance releases

Lite releases follow the same sequence from `lite/1.x` with `edition=lite` and a
`v1.x.y` tag. Lite 1.0.1 was published this way: `tag=v1.0.1`,
`expected_commit=cf91c7d32fe54315cb5e1ec5488e8f477abe9a50`, evidence in
`.github/release/evidence/lite-v1.0.1.md`. Its asset names and `ARTIFACTS.md`
wording are unchanged by Full support.

## Rollback and upgrades

- **Lite → Full:** supported in place (higher version code, same package and
  certificate). Pairing is preserved.
- **Full → Lite:** Android refuses an in-place downgrade (for example `20100`
  over `10001`). Returning to Lite requires uninstalling the Bike Bridge, which
  clears pairing; pair the Trainer again afterwards.
- **Full → earlier Full:** also a downgrade; prefer shipping a fixed `2.x.y`
  with a higher version code over rolling back.
- Before upgrading a console, keep the currently installed APK
  (`adb shell pm path com.fitbaus.bikebridge` then `adb pull`) as a rollback copy.
- A published Release is never modified. A broken release is replaced by a new
  tag and Release.

## Signing responsibilities

### Trainer

1. Use the persistent release keystore; back it up offline (encrypted). Losing
   it prevents `adb install -r` upgrades.
2. GitHub Environment `release` secrets (never commit the keystore):
   `TRAINER_SIGNING_STORE_BASE64`, `TRAINER_SIGNING_STORE_PASSWORD`,
   `TRAINER_SIGNING_KEY_ALIAS`, `TRAINER_SIGNING_KEY_PASSWORD`.
3. The certificate pin under `com.markrai.fitbaus.trainer` must match.

### Bike Bridge production

1. Use the **existing** production keystore already used on consoles. Never
   create a replacement certificate.
2. Secrets: `BIKEBRIDGE_SIGNING_STORE_BASE64`, `BIKEBRIDGE_SIGNING_STORE_PASSWORD`,
   `BIKEBRIDGE_SIGNING_KEY_ALIAS`, `BIKEBRIDGE_SIGNING_KEY_PASSWORD`.
3. The certificate pin under `com.fitbaus.bikebridge` must match.

Bike Bridge signing uses a temporary `local.properties` so passwords never appear
on the Gradle command line. Post-sign verification is API-aware: the Trainer
(min SDK 24) requires a verified v2 signature; the Bike Bridge (min SDK 22,
Android 5.1.1) requires a verified v1 signature, x86 native code and no non-x86
libraries.

```bash
keytool -list -v -keystore bikebridge-release.jks
# SHA-256, uppercase hex without colons, as in signing-policy.json
```

## Safe retries

- Draft release, missing asset → uploaded
- Existing asset with identical SHA-256 → skipped
- Existing asset with different content → **fails closed**
- Already **published** release with missing or different assets → **fails closed**, nothing is edited
- A failed upload leaves a newly created release as a **draft** (publish happens last)

## CI event policy

`.github/workflows/ci.yml` runs on pushes to `main` or `lite/1.x`, pushes of
version tags matching `v*`, and pull requests (open / synchronize / reopen).
Ordinary feature-branch pushes do not start a push run, so the same commit is not
tested twice.

## Local validation vs GitHub Actions

| Step | Local without production secrets | Needs GitHub Actions + secrets |
| --- | --- | --- |
| Tag/commit resolution (fixture repos) | yes | yes |
| Edition/version contract, names, candidate integrity | yes (`tests/releasePipeline.test.mjs`) | yes |
| Missing-secret / wrong-pin / unqualified gates | yes (fixtures) | yes |
| Draft-first publication logic | yes (mocked `gh`) | yes |
| Real `apksigner` / production Bridge assemble | only with local keystores | yes |
| GitHub Release creation | no | yes |
| Physical console acceptance | no | hardware |

Do not simulate successful signing, qualification or publication when
credentials or hardware are absent.

## End-user download guidance

1. Open the published GitHub Release for your edition (**FitBaus Lite 1.x** or
   **FitBaus Full 2.x**).
2. Download the Trainer APK and the Bike Bridge APK for your console, plus the
   web zip if self-hosting.
3. Verify downloads with `SHA256SUMS.txt`.
4. Install with `adb install -r`. Full installs over Lite; Lite cannot be
   installed over Full without uninstalling first.
