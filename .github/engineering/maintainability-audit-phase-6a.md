# Phase 6A: Final maintainability audit

Audit date: 2026-11-26
Audited main: `92d21175813e2f215f3b2b4310fe264f9658f1c9`
Pre-consolidation baseline: `bd28bbbbdfa8aa6e51e4675cb248cb51398fbe5a` (Phase 0A PR base)

## Decision

The 14 original consolidation slices (PRs #117–#130) are merged. The architecture is materially easier to reason about. Do not pursue blanket file splitting. The original consolidation work is complete, but two P1 findings prevent unconditional closure of the initiative. Address these and the closely related telemetry/start-admission findings in bounded follow-up work before final qualification.

This is a source audit, not a new implementation or physical qualification. Findings were assessed against the pinned commit. The existing main CI run [45816934848](https://github.com/markrai/fitbaus-trainer/actions/runs/45816934848) reports success for Trainer and Native Bike Bridge, including compilation, test suites, generated output consistency, version checks and unlock qualification gates. No local checkout, independently executed test suite or hardware test was available for this audit.

## Consolidation outcomes

| Boundary | Result |
|---|---|
| Phase 0A | Canonical VO2 checkpoint evaluation uses intent, checkpoint identity and current-session revalidation; live ceiling evaluation is not gated on a slow HR read. |
| Phase 0B | Native USB admission uses process-scoped live-thread ownership rather than trusting bounded shutdown completion. The service retries ownership-blocked starts. |
| Phases 1A/1B | Summary provider request admission and completion are owned by the workflow state; the dialog projects controls and rejects stale form callbacks. |
| Phase 2 | Shared native management dialog primitives replace duplicated style/layout policies without forcing unrelated UI into a global theme. |
| Phase 3 | Shared RSA key creation and credential-envelope primitives retain existing aliases and wire/storage formats. |
| Phases 4A–4E | Dashboard, navigation, tracker configuration, arcade lifecycle and media lifecycle have explicit owners; ArcadeModeController remains the mode authority. |
| Phases 5A–5C | Display projection, telemetry ingestion and presentation-side session coordination are separated. Session mutations remain with the existing domain and persistence modules. |

Source sizes (bytes from Git trees; not a measure of total code reduction):

| File | Before | After |
|---|---:|---:|
| NativeBridgeActivity.kt | 53,842 | 32,335 |
| src/uiControls.ts | 110,602 | 97,401 |
| src/main.ts | 7,094 | 5,094 |
| SummaryProviderDialog.kt | 33,579 | 34,492 |
| TranscriberManagementDialog.kt | 16,548 | 15,629 |

The summary provider dialog is slightly larger despite extracting state; its improved ownership is more important than byte count. The phone UI remains sizeable (history, diagnostics and presentation), but splitting those areas solely by size is not a release gate.

A sampled graph of direct static relative imports among 16 core phone modules (main, uiControls, workoutLogic, workoutLifecycle, workoutSummary, workoutStorage, sessionStore, freestyleRide, workoutSessionCoordinator, workoutTelemetryIngestion, workoutDisplayState, machines/runtime, platform/bikeBridgeRuntime, profile, fitnessState, workoutData) showed no direct two-node cycles. This is not an exhaustive dependency graph, nor proof against indirect cycles, dynamic imports or coupling through browser globals. The coordinator, ingestion and display modules do not introduce imports back to uiControls. Window-based summary/persistence/wake-lock hooks remain an explicit legacy seam.

## Findings

### A01 · P1 — Unconfirmed ordinary/VO2 summary saves permit irreversible cleanup

Evidence:
- [workoutLifecycle.ts:162–198](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutLifecycle.ts#L162-L198): completion ignores the boolean from emitWorkoutSummary, marks summary emitted and releases telemetry.
- [workoutLifecycle.ts:200–239](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutLifecycle.ts#L200-L239): cancellation also ignores the return value and catches exceptions without reporting failure to its caller.
- [workoutLogic.ts:721–747](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutLogic.ts#L721-L747): restart clears the session and raw evidence after cancellation returns, regardless of the durable outcome.
- [workoutSummary.ts:577–632](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutSummary.ts#L577-L632): emission returns saved; learning calls are outside the saved branch.
- [workoutStorage.ts:383–390](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutStorage.ts#L383-L390): storage failure is represented by false.

Consequence: a failed IndexedDB save can be presented as a completed workout, and evidence needed to reconstruct the workout or assessment can be lost. Learning may be attempted despite failed persistence. The Freestyle path already checks the confirmed save result (workoutLifecycle.ts:452–473). This defect predates consolidation.

Required: make completion/cancellation outcomes explicit; preserve recoverable evidence on false/rejection; only mark emitted and perform destructive cleanup after confirmed persistence or an explicit user-authorized discard. Separate immediate safe control shutdown from evidence cleanup. Ensure learning is gated by successful persistence. Do not change Freestyle's existing failure/ownership semantics or scientific eligibility policies.

Regression: inject false and rejection at actual persistence boundary; verify no emitted marker, no raw evidence deletion, retry succeeds and produces one summary; test completion and cancellation for ordinary and VO2. Verify failed saves cannot drive learning.

### A02 · P1 — Completion/restart are not single-flight or fully session-scoped

Evidence: [workoutLifecycle.ts:162–239](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutLifecycle.ts#L162-L239), [workoutLogic.ts:698–748](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutLogic.ts#L698-L748), [sessionStore.ts:377–426](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/sessionStore.ts#L377-L426); the completed screen invokes coordinator.complete during periodic refresh, and markSummaryEmitted(day) and clearSession(day) mutate selector-keyed state. No ordinary finalization admission latch exists comparable to Freestyle's finish-in-flight owner.

Consequence: multiple refreshes can begin duplicate summary work before the emitted marker changes; overlapping restart/completion or a late callback after replacement can mark/clear the wrong selector's session or disarm/reset a newer session. This is a source-level interleaving, not a claim of reproduced incidents or duplicate database rows. This defect predates consolidation.

Required: a single admission/identity contract for ordinary and VO2 end actions, with post-await revalidation before all selector/global side effects (including bridge binding, wake lock, stale cleanup and runtime reset). Capture the ending session and freeze the end time once; scope deletion to its identity; handle reentrant end/restart and competing finish intents deterministically. Use the existing domain lifecycle owner rather than a second state machine in uiControls. Preserve immediate safety disarm and Phase 0A/0B invariants.

Regression: deferred-promise tests for repeated completion ticks, completion vs restart, simultaneous restart, replacement of same selector, another selector starting, and late failure. Assert current-session state/binding/evidence is not touched by old work, and successful repeated requests do not duplicate side effects.

### A03 · P2 — Telemetry remains admissible after completion

Evidence: [workoutTelemetryIngestion.ts:69–136](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutTelemetryIngestion.ts#L69-L136), [workoutLogic.ts:179–205](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutLogic.ts#L179-L205), [bikeTelemetryTrace.ts:44–85](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/bikeTelemetryTrace.ts#L44-L85). The completed session retains startTime and sessionId. The HR and bike ingestion guards do not reject summaryEmitted=true; after transient trace release a fresh valid metric can recreate it. With an ending ordinary session, admission/flush also needs to distinguish accepted evidence from late events.

Required: share a lifecycle-aware admission predicate and freeze capture during finalization, with a post-await HR check and an explicit policy for pending writes. Preserve paused/freshness/provenance semantics and legitimate recovery. Live HUD updates must remain independent of durable evidence capture.

Regression: drive sensor events before, during and after completion, failed save/retry, discard and replacement; assert no post-end records or recreated VO2 trace and no loss of pre-end accepted evidence.

### A04 · P2 — HR persistence errors are indistinguishable from empty/successful results

Evidence: [workoutStorage.ts:366–381](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutStorage.ts#L366-L381) maps read failures to [] and swallows write errors; [workoutTelemetryIngestion.ts:43–83](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutTelemetryIngestion.ts#L43-L83) hydrates from that facade and advances the in-memory elapsed cursor before storage is confirmed. Raw HR repository has transaction-level completion and first-write-wins, but facade hides failures.

Required: provide a strict evidence read/write contract to ingestion and finalization without casually changing all compatibility consumers; failed hydration must be retryable and write failures observable; do not turn storage failure into measured zero/absence or bypass the live HR ceiling. Decide and test how pending HR writes are drained at end. Review ordinary telemetry flush outcomes as part of this work (workoutSummary.ts:470 currently ignores the result); do not silently claim complete evidence on failure.

Regression: injected DB read/write errors; retry and dedup behavior; missing evidence vs read failure; finalization with pending HR and bike writes. No new physiological thresholds.

### A05 · P2 — VO2 direct start has weaker admission than normal start

Evidence: [workoutLogic.ts:359–383](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutLogic.ts#L359-L383) guards normal start; [workoutLogic.ts:607–655](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/workoutLogic.ts#L607-L655) branches into VO2 preflight/start before the ordinary competing-session check. The subsequent claim result is not checked. This is an entry-point contract gap, not a demonstrated normal-UI reproduction.

Required: enforce identity/ownership at the underlying start boundary before mutating session, releasing previous evidence or binding/resetting hardware; no conflicting start may change the active session. Preserve existing preflight and Freestyle guards.

Regression: invoke direct begin with competing live ordinary/Freestyle/VO2 owner and pending finalization; verify no mutation or control binding. Valid starts still pass preflight and bind appropriately.

### A06 · P3 — SISU error text overstates platform cleartext restriction

Evidence: [sisuHttp.ts](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/src/platform/sisuHttp.ts) rejects explicit native HTTP SISU requests but claims no broad cleartext exception; [network_security_config.xml](https://github.com/markrai/fitbaus-trainer/blob/92d21175813e2f215f3b2b4310fe264f9658f1c9/android/app/src/main/res/xml/network_security_config.xml) explicitly permits app-wide cleartext for the LAN bridge. The XML correctly documents this.

Required: correct the SISU-specific message. Separately verify transport redirects and document the intentional trusted-LAN assumption; do not remove the bridge's HTTP capability without a separate migration design. No redirect bypass is asserted in this audit.

## Design decisions and deferred items

- Controller events are consumed even outside active games (NativeBridgeActivity.kt:271–336). Earlier product requirements requested controller interception; changing this policy without an explicit UX decision is not recommended.
- Floating YouTube playback can coexist with an arcade camera by design (media/MediaLifecycle.kt and arcade/ArcadeLifecycle.kt). Resource pressure on the API 22 console is a physical performance qualification item, not a proven regression. Do not remove PiP as cleanup.
- Large presentation/algorithm modules remain. Split a cohesive feature only when there is a concrete change, independently testable owner or actual dependency problem. Do not count relocated lines as a goal.
- Existing native credential upgrade, hardware USB shutdown/restart, controller, media/PiP and camera lifecycle require physical testing; source review and green CI are not proof of device compatibility.
- Retain exact safety and scientific boundaries, release edition policy and schema compatibility. No new libraries, platform upgrades or wholesale persistence migration are proposed.

## Proposed closeout sequence

1. **6A.1 — Confirmed end-of-workout persistence and single-flight lifecycle**: A01/A02. One bounded design/implementation effort; if necessary split the identity/admission work from persistence outcomes into reviewable commits. Test failure recovery and late callbacks before merge.
2. **6A.2 — Evidence admission and persistence integrity**: A03/A04. Use the lifecycle contract from 6A.1; add strict persistence outcomes and end-of-session draining without changing scientific computations.
3. **6A.3 — Start admission and security-text cleanup**: A05/A06. Verify no conflicting start mutates evidence/authority; correct the native SISU message and test the relevant policy.
4. **6B — Final qualification**: run full Trainer/native CI, check generated outputs and packages, review safety/architecture guards, test offline PWA and targeted real hardware paths. Document any physical tests not performed as outstanding rather than passing them.

These are proposed follow-up slices, not previously approved scope. No application code, tests or release versions are changed by this report.
