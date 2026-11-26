# Phase 6B: Bounded architectural qualification

Date: 2026-11-26
Pinned main: `c15bc42386a096fd928bf03b8e0be700ea46d5ad`
Git tree: `716ad7697e3ab2bd3efda1586ce05b6da4eebaaf`
Scope: static review and existing CI evidence, not release or physical device certification.

## Decision

The consolidation and three corrective slices are merged. The architecture is substantially more maintainable than the pre-consolidation baseline; do not resume blanket module splitting. Automated qualification passed on the identical final tree in PR #134. Full lifecycle correctness is not qualified: the review identified a drain liveness defect and residual session-side-effect/recovery gaps. Close the bounded qualification pass with an explicit **conditional result**, not an unconditional release sign-off. Prioritize Q01 and Q02 before claiming the original lifecycle defects are fully resolved. No runtime code or version changes in this report.

## Evidence

| Check | Result |
|---|---|
| Consolidation PRs #117–#130 | Merged |
| Audit #131 and remediation #132–#134 | Merged |
| PR #132 CI [45820228562](https://github.com/markrai/fitbaus-trainer/actions/runs/45820228562) | Success |
| PR #133 CI [45823482974](https://github.com/markrai/fitbaus-trainer/actions/runs/45823482974) | Success |
| PR #134 CI [45825835082](https://github.com/markrai/fitbaus-trainer/actions/runs/45825835082) | Success; 1,610/1,610 Trainer tests, zero skipped |
| PR #134 Trainer build/type check/version check/generated output parity | Passed |
| PR #134 native unit tests, resolved versions, version consistency, unlock qualification Gradle gates | Passed |
| Merged main CI [45828246464](https://github.com/markrai/fitbaus-trainer/actions/runs/45828246464) | Trainer passed; native job still running at observation |
| Signed APK/release package, offline PWA device checks, API 22 USB/camera/PiP/controller, physical exercise and SISU HTTPS redirect tests | Not performed |

The PR head `e0d813e2161751241535ae597041cb12758e8fc6` and merged main share the same tree. CI builds TypeScript and checks a clean generated-output diff; no local compilation or independent test execution was available. Native CI runs the four specified Gradle unit-test tasks and build-policy gates, not a physical console or full release assembly.

## Original findings: verification

| ID | Status | Evidence |
|---|---|---|
| A01 | Improved; ordinary false/rejected save cleanup guarded | [src/workoutLifecycle.ts:237–265](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutLifecycle.ts#L237-L265); [src/workoutLogic.ts:716–750](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutLogic.ts#L716-L750); [src/workoutSummary.ts:577–630](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutSummary.ts#L577-L630). Learning is gated on confirmed save. |
| A02 | Partial | [src/workoutLifecycle.ts:193–271](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutLifecycle.ts#L193-L271): single-flight and identity checks after awaits; Q02/Q03 remain. |
| A03 | Improved; admitted-vs-late capture distinguished | [src/workoutTelemetryIngestion.ts:67–93](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutTelemetryIngestion.ts#L67-L93): rechecks after hydration and rejects ending/emitted sessions. No guarantee of crash-durable pending samples. |
| A04 | Partial | [src/workoutStorage.ts:418–445](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutStorage.ts#L418-L445) and [src/workoutSummary.ts:330–338](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutSummary.ts#L330-L338): strict read and retryable write paths; Q01 remains. Live ceiling bypass and checkpoint failure cooldown remain separate from scientific evaluation. |
| A05 | Main entry-point gap addressed | [src/workoutLogic.ts:343–406](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutLogic.ts#L343-L406): shared admission, identity and claim before state changes, checks ownership refresh. Q04 documents conservative recovery limitations. |
| A06 | Corrected | [SISU guard](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/platform/sisuHttp.ts) matches [Android config](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/android/app/src/main/res/xml/network_security_config.xml). Explicit native HTTP still rejected; app-wide cleartext is not host restricted. Redirect behavior not qualified. |

## Residual findings from combined source review

These are source-level interleavings and boundary gaps, not reproduced field incidents. Priorities are relative to the audited lifecycle contracts.

### Q01 · P1: overlapping HR drains can keep appending each other's barriers

[src/workoutStorage.ts:418–435](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutStorage.ts#L418-L435) appends a retry task to the per-session tail and, when the tail changed while awaiting, recursively invokes the same drain function. Two overlapping drains can each see the other's new tail and append another task before the other returns, including after all actual evidence writes succeeded. [src/workoutLogic.ts:991–1005](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutLogic.ts#L991-L1005) permits distinct VO2 checkpoints to have outstanding reads; finalization can also overlap a checkpoint read. This is not the same as legitimate waiting for new sensor writes. Potential outcome: a checkpoint or save does not settle. The immediate fresh live-HR ceiling still bypasses checkpoint reads; this finding does not establish a ceiling bypass.

Required: one drain owner per session (or a stable generation/settlement barrier that never treats another drain as new evidence). Test two overlapping drain calls with an initially gated write, permanent/transient failure, and a later admitted sample; both must settle, with first-sample preservation and no unbounded retry. Exercise a checkpoint and finalization overlapping the same queued HR write. Also serialize ordinary bike flush retry ownership: [src/workoutStorage.ts:157–237](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutStorage.ts#L157-L237) splices failures while asynchronous retries are in flight, without a shared flush promise, so a second flush can observe an empty retry queue and report success before the first retry settles.

### Q02 · P1: global lifecycle effects are not completely session-scoped

[src/workoutSessionCoordinator.ts:148–151](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutSessionCoordinator.ts#L148-L151) releases the wake lock unconditionally before invoking the session-scoped completion owner. [src/workoutLifecycle.ts:149–159](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutLifecycle.ts#L149-L159) clears session state and globally disarms/resets machine guidance even when the discarded selector is not the live owner. [src/workoutSessionCoordinator.ts:210–231](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutSessionCoordinator.ts#L210-L231) invokes this path for stale selectors. [src/uiControls.ts:957–963](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/uiControls.ts#L957-L963) also clears guidance and invokes completion on an already-emitted completed render. The ordinary end path itself revalidates identity after summary awaits, which is a substantial improvement; these separate side-effect owners remain outside that contract. Bootstrap order limits the normal stale-cleanup exposure, but direct invocation and stale selector state still lack an identity guard.

Required: make cleanup of non-owning selectors evidence-specific; move completion-related wake-lock release to the admitted lifecycle task, guard bridge/guidance effects against the active owner/binding, and avoid repeated completion calls for an already-emitted record except explicit interrupted-cleanup recovery. Test stale cleanup while another selector owns control and a late completion against a replacement. Do not change safe disarm for the actual ending session.

### Q03 · P2: interrupted ordinary cancellation cleanup can render an ended ride as active

[src/workoutLifecycle.ts:247–250](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutLifecycle.ts#L247-L250) marks summary emitted and removes the frozen record before restart clears selector state ([src/workoutLogic.ts:717–736](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutLogic.ts#L717-L736)). If interrupted between these operations, [src/workoutDisplayState.ts:112–129](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutDisplayState.ts#L112-L129) only uses the frozen record or elapsed phase completion to project the completed screen, not the emitted marker. An early-ended ordinary ride can therefore render as active after reload even though its summary exists. Binding restore rejects emitted sessions, and ingestion rejects new evidence, but presentation and session recovery are inconsistent. Require completed/recovery projection for confirmed emitted sessions, and distinguish retry-save from destructive restart; add a reload test for cancellation with an emitted marker and no finalization record. Review readback of a summary committed before the emitted marker and idempotence of learning, rather than assuming exactly-once across storage boundaries.

### Q04 · P2: conservative start admission can strand ownerless/incomplete session records

[src/workoutLogic.ts:343–398](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutLogic.ts#L343-L398) blocks on pending records and un-emitted ownerless live selectors across the week. Bootstrap recovery ([src/workoutSessionCoordinator.ts:234–273](https://github.com/markrai/fitbaus-trainer/blob/c15bc42386a096fd928bf03b8e0be700ea46d5ad/src/workoutSessionCoordinator.ts#L234-L273)) selects an ownerless ordinary finalization only when its session and start time match; mismatched or incomplete ordinary markers are not given an explicit recovery UI. Admission is safer than overwriting evidence, but may require manual navigation/recovery. A permanent ordinary bike parse rejection also blocks save (unlike the existing explicit Freestyle incomplete-evidence policy). Preserve evidence and provide an identity-scoped, explicit recovery/discard route rather than loosening admission.

## Accepted boundaries and deferred qualification

- LocalStorage ownership and IDB persistence are separate boundaries; same-process admission is not a cross-tab atomic lock or exactly-once transaction. Pending or failed in-memory samples may be lost on abrupt termination. Do not claim crash-proof evidence.
- Existing compatibility HR read APIs still return empty arrays on failure, including optional post-save learning consumers. Canonical summary/checkpoint paths are strict. Avoid broad API churn; review learning idempotence and strict read usage with Q03.
- No device testing: API 22 resource pressure with floating YouTube + camera, native USB permission/stop/restart, credential migration, controller interception, physical workout/VO2, offline PWA, app process recreation, SISU redirects and signed package qualification remain outstanding.
- Existing trusted-LAN bridge HTTP and controller interception are deliberate product decisions. No changes to safety thresholds, pairing tokens, SECURITY_BLOCK, platform network policy, release editions or schema.

## Closeout recommendation

No more general refactoring phases. Resolve Q01/Q02 in one focused lifecycle/persistence hardening PR if feasible; Q03/Q04 as a bounded recovery follow-up if needed. Run the same CI and targeted injected-failure regressions. Keep physical qualification explicitly outstanding until tested; do not block a documentation-only qualification report on a lengthy device matrix. A green CI run alone is not proof of these untested interleavings.
