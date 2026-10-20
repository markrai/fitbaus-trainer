# VO2 Evidence Foundation

Internal contract for pause-safe, stage-aware physiological evidence recorded from ordinary workouts.

This is **evidence**, not a VO2 result. The standalone VO2 Max Estimation workout attaches a separate `vo2_assessment` produced by the versioned estimator. See `VO2-TEST-PROTOCOL-V1.md`.

Also mirrored under `docs/vo2-evidence-foundation.md` (that folder is gitignored for LLM prompt drafts).

## Purpose

Completed workouts must retain enough local facts for a future VO2 estimator to answer:

1. How much **active** workout time elapsed?
2. Where each phase/stage began and ended on that active clock
3. Which raw HR samples belong to each phase
4. Whether the workout was paused, and for how long
5. Where meaningful work ended
6. Whether cooldown was normal or Early Cooldown
7. Which workout / activity / machine / profile produced the evidence
8. Whether the session is usable without reconstructing ambiguous runtime state

## Active-clock semantics

The authoritative active workout clock is `actualElapsedSeconds` / `activeElapsedSeconds`:

| State | Behavior |
| --- | --- |
| running | active elapsed increases with wall time since the adjusted start reference |
| paused | active elapsed freezes at `pausedElapsed` |
| resumed | start reference is rewritten so active elapsed continues from the freeze point |
| completed | final active elapsed is captured into `vo2_evidence.active_duration_sec` |

Invariants:

- Active elapsed never decreases across resume
- Paused wall time does not count as exercise duration
- Resume must not rewind or reuse earlier active HR timing keys

## Wall time vs active time

Both are retained:

- **Wall time**: `WorkoutSummary.startedAt` / `endedAt` (and session wall start)
- **Active time**: `vo2_evidence.active_duration_sec` and phase `active_start_sec` / `active_end_sec`
- **Paused time**: `vo2_evidence.paused_duration_sec` (sum of completed pauses; open pause included at finalize)

Existing `duration_minutes` remains wall-span based for summary compatibility.

## Pause semantics

On pause:

- Active clock freezes
- Wall pause start is recorded
- Workout-relative HR samples are **not** persisted (`workoutRelativeHrSample` returns `null`)

On resume:

- Accumulated pause duration increases by the pause wall span
- Active clock continues from the pre-pause value
- Next HR sample uses the next unused active second (no overwrite of the freeze-point sample)

Pause-era BLE HR may still update the live UI, but it is not active-workout evidence and cannot masquerade as work-stage HR.

## Phase-boundary semantics

At workout start, the session stores a **phase plan snapshot**:

- `blocks` from `getPlan()[day]` after `adjustedBlockLengths(...)`
- `hrTargets` for that day (interval structure / main-set kind)

Live runtime and completion-time evidence both prefer that snapshot when present, then call the same `getPhase` planner and `hrTargetText` helper. Snapshot `hrTargets` distinguishes:

- `undefined`: no snapshot override; live plan fallback is allowed (legacy sessions)
- `null`: frozen absence of HR targets; must not acquire later live intervals or targets
- object: frozen HR targets for phase kind, interval structure, and prescribed HR

This matters because plan modules are reloaded on app start and week-based variants can change; `adjustedBlockLengths` is currently an identity function but is not a permanent guarantee without the snapshot.

Each phase records at minimum:

- `phase_id`, `kind`
- `active_start_sec`, `active_end_sec`
- optional prescribed **HR** targets from the workout plan (`prescribed.*`)

Adjacent transitions share the same authoritative active second as previous end / next start.

Machine guidance resistance/cadence are **not** collapsed into phase-wide prescriptions. Guidance can change within a phase; `machine_guidance_trace` on the local summary remains the authoritative time-series provenance. A phase may have no cadence or resistance prescription fields.

## HR evidence semantics

Raw HR remains in the existing IndexedDB `hr_samples` store keyed by `(session_id, timestamp_sec)` where `timestamp_sec` is **active elapsed**.

`vo2_evidence.hr` does **not** duplicate the raw trace. It records:

- `source`: `ble_chest_strap` or `absent`
- `sample_count`
- optional first/last active elapsed

Missing HR stays missing. No interpolation. No fabricated pause samples.

## Cooldown / work-end markers

| Field | Meaning |
| --- | --- |
| `work_end_active_sec` | Active elapsed when meaningful work ended; `null` if it never ended |
| `cooldown_start_active_sec` | Active elapsed when cooldown began; `null` if it never began |
| `early_cooldown` | `true` when Early Cooldown was requested |

Unknown concepts use `null` / absence - never `0` as a sentinel for "unknown".

## Machine provenance

When available, evidence includes:

- `machine.machine_id`
- `machine.machine_profile_version`
- `machine.guidance_trace_entry_count`

Full `machine_guidance_trace` remains on the local workout summary. It is still stripped from SISU server ingest. VO2 evidence does not require FitBaus Bike Bridge or automatic resistance control.

## Persistence compatibility

- `vo2_evidence` is an optional field on `WorkoutSummary`
- Historical workouts without the field load unchanged (`vo2_evidence` absent)
- No fabricated evidence is synthesized for old sessions
- Existing workout history is neither deleted nor rewritten

`vo2_evidence` is local-only for SISU ingest: `buildSisuWorkoutPayload` deletes it before upload.

IndexedDB round-trip is covered by tests that call `storeWorkoutSummary` then `getAllWorkoutSummaries`.

## Runtime architecture

```text
existing workout runtime
        |
        v
canonical active workout clock
        |
        v
phase plan snapshot at start
        |
        v
existing phase transitions + HR samples
        |
        v
buildVo2Evidence at completion (uses snapshot + getPhase)
        |
        v
immutable vo2_evidence on WorkoutSummary
        |
        v
existing IndexedDB workout persistence
```

The evidence builder observes / finalizes from canonical runtime state. It is not a second controller, clock, HR recorder, or persistence system.

## Standalone VO2 test identity

The dedicated workout uses `protocol_id: bike-submax-70rpm` / `protocol_version: 1`. See `VO2-TEST-PROTOCOL-V1.md`.

Ordinary workouts may still have `vo2_evidence` without `protocol` and without `vo2_assessment`.
