# Maintainability initiative: closeout

Date: 2026-11-26
Reviewed main: `96737a1fb00b18836dd6fb4585c53d6341d7d30e`
Source tree: `ad3f1adeecb10441382ccbf4bc3cdb5b4f4b0057`

## Decision

Close the planned architectural consolidation and corrective implementation sequence. Automated qualification passes on the final implementation tree. Do not open another general refactoring phase. This is a bounded source/CI closeout, not an assertion that every possible runtime interleaving is safe or that a signed release or physical console has been qualified.

## Traceability

| Scope | Merged PRs | Outcome |
|---|---|---|
| Original consolidation | #117–#130 | Explicit ownership of native UI/media, USB, phone projection, ingestion and coordination boundaries |
| 6A audit | #131 | Six findings documented |
| 6A.1 | #132 | Confirmed save, frozen ordinary/VO2 finalization, single-flight end |
| 6A.2 | #133 | Lifecycle-aware admission, strict HR and bike evidence paths |
| 6A.3 | #134 | Shared start admission, SISU message correction |
| 6B | #135 | Conditional qualification and four residual findings |
| 6B.1 | #136 | Per-session telemetry drain ownership, guarded cleanup |
| 6B.2 | #137 | Saved summary readback, completed projection, explicit recovery |

Retain the original [6A audit](maintainability-audit-phase-6a.md) and [6B qualification](maintainability-qualification-phase-6b.md) as historical pinned-source reports, not descriptions of unresolved implementation work on current main.

## Automated evidence

- [#136 CI 45833975857](https://github.com/markrai/fitbaus-trainer/actions/runs/45833975857): success.
- [#137 CI 45840734754](https://github.com/markrai/fitbaus-trainer/actions/runs/45840734754): success. Trainer 1,623 tests, 1,623 passed, zero failures, skips, cancellations or todos. Build, type/contract checks, version checks and clean generated-output diff passed. Native protocol, bridge, USB probe and arcade unit-test tasks, resolved versions, version consistency and unlock qualification gates passed.
- #137 head `e3013be4bef0279edb664dfc75bc073cb427ba67` and merged main have the identical Git tree above.
- [Merged-main CI 45843045853](https://github.com/markrai/fitbaus-trainer/actions/runs/45843045853): Trainer passed; Native Bike Bridge still running at observation.
- Thirteen additional Trainer tests since the 1,610-test Phase 6B snapshot. No independent local or physical execution performed in this closeout.

## Residual finding disposition

| Finding | Bounded implementation result |
|---|---|
| Q01 (A04) | #136 gives HR and ordinary bike drains one promise and retry owner per session; retry work is serialized with the write tail. Explicit deletion seals admission and joins the drain. Overlapping failed/retried drains and deletion are covered by regression tests. |
| Q02 (A02) | #136 removes presentation-owned completion wake-lock release; global cleanup checks owner and binding identity. Repeated emitted renders, stale-selector cleanup and different live binding have regression coverage. |
| Q03 | #137 persists completed elapsed duration, projects emitted records as completed, prevents emitted VO2 ticks, and strictly reads back a matching committed summary before retrying emission. Retry Save is separate from restart. |
| Q04 | #137 selects unresolved ordinary records, protects incomplete/pending evidence from cleanup, exposes confirmed discard, and atomically deletes only unsaved evidence for the selected identity. Conflicts are handled one record at a time. |

The specific source defects and planned remediation scope have implementation changes and passing CI. Do not equate this with exhaustive fault injection or device acceptance.

## Boundaries to retain

- Runtime ownership and IndexedDB/localStorage are not cross-tab atomic or crash-atomic. In-memory writes can be lost at process termination. Drains may extend for actual newly admitted writes; a shared drain does not impose a timeout on storage.
- Readback avoids replay of post-save learning/promotion, but a crash between commit and those effects can omit them. The optional learning paths still use compatibility HR reads; no exactly-once scientific-state claim. Historical emitted records without completed-elapsed metadata show zero elapsed.
- The pre-existing 24-hour stale ordinary session policy remains for complete, unfinalized markers; incomplete or frozen records are not automatically discarded under that policy. Ordinary restart retains its existing raw-evidence cleanup behavior after a confirmed save. The explicit recovery discard route protects a persisted summary and its evidence.
- Recovery deliberately refuses contradictory identities rather than guessing. It addresses supported selectors and parseable finalization records, not arbitrary corrupted storage or duplicate IDs across all possible storage namespaces. Malformed records outside the supported parser and cross-runtime replacement during recovery are not exhaustively qualified.
- Direct native SISU HTTP rejection and intentional trusted-LAN bridge HTTP remain unchanged. HTTPS redirect behavior, native USB lifetime, credentials, camera/PiP, controller input, PWA offline use and physical exercise/VO2 acceptance remain device or transport qualification items.
- No signed APK assembly or release certification was performed. No change to thresholds, pairing token, SECURITY_BLOCK, edition policy or database schema was made as part of this closeout.

## Maintenance policy

Prefer concrete feature/defect PRs with focused tests and ownership contracts over speculative file splitting. Require green CI and preserve generated-output parity. If a device or user reproduces a remaining issue, reopen that specific defect, not the entire architecture initiative. Physical/release testing is a separate activity with explicitly recorded scope.
