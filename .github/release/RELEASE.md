# FitBaus release engineering

## Normal release

After merging a version bump and its changelog, tag the intended source commit and push the tag.

```bash
git tag -a v2.6.0 -m "FitBaus Full 2.6.0"
git push origin v2.6.0
```

Tag-triggered CI must succeed. The Release workflow then builds and signs the installers, checks the exact candidate, and publishes the GitHub Release automatically. It derives the edition, version and peeled commit from the tag. No commit hash, mode, candidate run ID, or qualification registry change is needed from the maintainer.

## Editions and identity

| Edition | Version tags | Source branch | Bridge APK |
| --- | --- | --- | --- |
| Lite | v1.x.y | lite/1.x | fitbaus-bikebridge-lite-X.Y.Z.apk |
| Full | v2.x.y | main | fitbaus-bikebridge-full-X.Y.Z.apk |

The version in the tagged source's `version.js` must match the tag. The release source must be an ancestor of its edition branch. See [VERSIONING.md](../../VERSIONING.md).

Both editions retain the production package `com.fitbaus.bikebridge` (API 22, x86, v1 signature) and Trainer package `com.markrai.fitbaus.trainer` (API 24). Both signing pins are mandatory. Full upgrades Lite in place using the established signing identity; downgrade restrictions still apply.

## Manual recovery

If the tag existed before the automated workflow was introduced, or automatic triggering was missed, dispatch the Release workflow on main using only the tag:

```bash
gh workflow run release.yml --ref main -f tag=v2.6.0
```

The manual path runs the same tests and checks as the automatic path. The workflow never creates or moves a tag.

If building or testing fails, correct the issue before publishing. Do not retarget a released tag. If a source fix is required after tagging, bump the version and create a new tag.

If publication fails after the candidate was uploaded, use **Re-run failed jobs** on the same Release run. The publish job downloads the same-run candidate instead of rebuilding it. Do not dispatch a fresh build to repair a partially uploaded draft: rebuilds may produce different bytes. Existing assets with different content are rejected, not overwritten. If the original artifact expired, a maintainer must inspect and resolve the unpublished draft before attempting another build. Published releases are immutable.

## Trust and verification

- Release runs on default-branch tooling in the protected `release` environment. Keep its deployment branch restricted to main. Protect release tags from unauthorized creation, update and deletion.
- The automatic path accepts successful push-triggered CI from this repository only. It resolves the actual remote tag and checks the triggering commit and edition branch ancestry. No triggering-run artifacts or untrusted PR checkout are used.
- Manual dispatch is permitted only on the default branch. Both paths test the tagged application source before signing. Production signing secrets remain in the protected environment.
- Build and publish are distinct jobs in the same run. Publish has no signing steps and validates candidate identity, run ID, all checksums, APK metadata and both pinned signing certificates again. The source tag is checked again before publication.
- Release notes come from the exact version section of the tagged changelog, plus artifact installation metadata. A missing, duplicate or empty changelog section fails closed.
- Publication creates or reconciles a draft, verifies remote asset hashes, and publishes only when all required assets match. It never overwrites existing assets with different bytes.

## Distribution

The six public assets are the signed Trainer APK, signed production Bike Bridge APK, web bundle, SHA256SUMS.txt, ARTIFACTS.md and release-candidate.json. The candidate manifest binds the source tag, source commit, tooling revision, workflow run ID, artifact names, binary hashes and signing identity. Unsigned and staging APKs are inspection artifacts only.

## Physical acceptance

Physical console testing remains strongly recommended for every release, especially changes to USB transport, resistance control, telemetry, playback and Android 5.1.1 compatibility. It is no longer a mandatory publication gate. A successful automated release does not prove physical hardware acceptance. Existing qualification records and evidence remain historical; maintainers can optionally record exact-binary hardware test results.

## Signing environment

Maintain the existing `TRAINER_SIGNING_STORE_BASE64`, `TRAINER_SIGNING_STORE_PASSWORD`, `TRAINER_SIGNING_KEY_ALIAS`, `TRAINER_SIGNING_KEY_PASSWORD` and corresponding `BIKEBRIDGE_SIGNING_*` environment secrets. Never replace signing keys merely to release a new version. A lost or changed signing identity breaks in-place upgrades. The signing-policy.json fingerprints are authoritative.

