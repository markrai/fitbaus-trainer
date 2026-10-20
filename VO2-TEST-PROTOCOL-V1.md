# SISU Bike Submax Protocol v1

Standalone submaximal bike test used by the **VO2 Max Estimation** workout.

This document is the tracked protocol contract. `docs/` may contain an optional gitignored mirror; this root file is authoritative.

This is **not** a clinical CPET and is **not** an official YMCA or Astrand-Ryhming implementation.

Protocol v1 records versioned evidence. A separate versioned estimator may produce a **VO₂ max estimate** from that evidence. Protocol completion and estimator eligibility are independent.

## Purpose

Run a reproducible, versioned submaximal staged bike test inside the existing SISU workout runtime, persist protocol-specific evidence, and (when evidence and profile inputs are sufficient) attach a local `vo2_assessment` produced by the versioned submax cycle estimator.

The workout may complete even if the estimator reports `insufficient_evidence`.
The estimator may produce an estimate even if the user ended the test before the scheduled upper-bound duration.

Thirty minutes is an **upper bound** of the plan composition (5 min warmup + up to 20 min work + 5 min cooldown), not an eligibility requirement.

## Protocol identity

```text
protocol_id: bike-submax-70rpm
protocol_version: 1
```

These constants are centralized in application code. The protocol version is **not** derived from the app version.

A future change to stage timing, workload-selection rules, acceptance rules, or cadence assumptions must become protocol version 2. Version-1 workouts must not be reinterpreted.

Selector identity:

```text
selector: VO2MaxEstimation
label: VO2 Max Estimation
activity: bike
intent: vo2_estimation
```

This is a dedicated workout definition, not a Monday/Friday weekly-plan day.

## Why 70 RPM

The current ProForm SMART Power 10.0 workload calibration is trustworthy at 70 RPM. Protocol v1 therefore **prescribes** 70 RPM.

## Cadence and watts: prescription vs measurement

70 RPM in protocol evidence is a coaching/prescription target. Prescribing 70 RPM is **not** proof the rider held 70 RPM.

Bike Bridge already polls observed RPM, observed watts, and observed resistance at 1 Hz. The VO₂ path reuses that existing poll; it does not run a second telemetry recorder. Requested/commanded resistance is never treated as observed resistance.

Estimator v1 workload sources, in order:

```text
measured_watts
  reliable observed watts in the stage steady-state window
  → estimator uses the median measured watts

calibrated_at_verified_cadence
  watts must come from the 70-RPM calibration table
  → only when observed cadence has enough coverage and stays within ±5 RPM of 70 for at least 75% of window samples, and the median is also in-band

prescribed_only
  prescribed resistance + prescribed 70 RPM + calibrated 70-RPM watts
  → not estimator-eligible
```

Without Bike Bridge telemetry (manual/PWA resistance coaching still works), performed workload cannot be validated. Estimator v1 then reports `insufficient_evidence` with `unverified_performed_workload`. That is policy A: do not treat a prescribed 70 RPM / calibrated table row as laboratory-grade performed work.

Compact per-stage `workload` provenance is persisted on protocol evidence so a historical estimate can still name its watts, cadence coverage, and source after raw telemetry is cleared.

## Architecture

The existing workout runtime remains authoritative:

```text
selector
  ->
preflight
  ->
beginWorkout / startSession
  ->
existing active clock
  ->
VO2 protocol runtime (feeds getPhase / machine hold)
  ->
existing machine guidance
  ->
Bike Bridge automatically, when enabled
  ->
manual resistance coaching otherwise
  ->
existing completion / cancel / limit-reached
  ->
vo2_evidence.protocol
  ->
sufficiency evaluator + versioned estimator
  ->
vo2_assessment on WorkoutSummary
  ->
IndexedDB (local). Stripped from SISU ingest.
```

The protocol module does not own the workout clock, HR recorder, machine controller, BLE stack, Bike Bridge client, or persistence system.

## Preflight

Before the workout clock starts, verify:

1. Bike activity / calibrated 70-RPM machine profile is selected
2. Live BLE HR is present and recent (existing 3-second freshness policy)
3. At least three distinct increasing calibrated 70-RPM workloads can be resolved

Bike Bridge automatic control is **not** required. The test is runnable with manual resistance changes.

If preflight fails, the session does not start. The UI shows a specific reason, for example:

- Heart-rate strap required
- No calibrated 70 RPM bike profile selected
- Not enough calibrated workload levels for this test

## Warmup

- Duration: 5 active minutes
- Cadence: 70 RPM prescribed
- Intensity: easiest calibrated 70-RPM workload from the selected machine profile

Warmup is not estimator-grade workload evidence.

## Work stages

Each primary test stage:

- Nominal duration: 3 active minutes
- Maximum duration: 5 active minutes (at most two 1-minute extensions)
- Cadence prescription: 70 RPM
- Resistance: fixed for that stage
- Estimated workload: the resolved calibrated watts at 70 RPM for that resistance

Ordinary machine guidance may adapt resistance during a weekly-plan phase. Protocol stages must not. The protocol supplies a hold resistance; existing machine guidance is still the only command source.

A stage's workload stays stable so a later estimator can associate HR response with one known workload.

The normal test targets three usable work stages. A fourth stage may run when fewer than three stages have been accepted and another **commandable** resolved workload remains, without exceeding the protocol-v1 resistance ceiling or the calibrated table.

## Workload resolution

Warmup uses the easiest valid calibrated 70-RPM workload.

Work-stage targets then step from that resolved floor:

```text
stage 1 target = warmup calibrated watts + 25 W
stage N target = previous resolved stage watts + 25 W
```

Each target is resolved through the canonical calibrated 70-RPM accessor:

```text
target watts
  ->
nearest valid calibrated 70-RPM pair strictly above the previous resolved workload
  ->
prescribed resistance
  ->
calibrated watts at 70 RPM
```

`requested_watts` is that actual target fed to the resolver, not a global 25/50/75/100 sequence from zero.

Requirements:

- The first work stage is a greater workload than warmup
- Resolved workloads strictly increase
- Duplicate resistance levels are not emitted twice
- No extrapolation beyond the calibrated table
- No fabricated power
- No unsupported resistance

The protocol records the **resolved** workload together with the requested target that produced it.

Protocol v1 is bound to the ProForm SMART Power 10.0 calibration (`proform-smart-power-10` / `getEstimatedWattsAt70Rpm`). Another bike profile cannot pass preflight and silently inherit that table.

## Commandable resistance range

Machine calibration exists through resistance **1..15**. Ordinary weekly-workout machine guidance still uses that full range.

Protocol v1 currently restricts resolved workloads to resistance **1..10**. That is the current end-to-end commandable ceiling (`VO2_PROTOCOL_MAX_RESISTANCE`), not a claim that the ProForm itself only has levels 1–10.

This restriction exists so protocol evidence remains truthful in both manual operation and current automatic Bike Bridge control. SISU must not record a prescribed resistance that the existing automatic-control transport would silently change.

A future validated Bike Bridge range expansion may permit a later protocol version, or an explicitly reviewed protocol-v1 change, to use resistances 11–15. Until then, protocol v1 does not fabricate a fourth stage merely to fill a four-stage target if the commandable table cannot support it.

The estimator requires three `accepted` stages. That is an estimator rule, not a requirement to ride all 30 plan minutes.

## Steady-state HR

HR is collected on the existing active workout clock from raw ~1 Hz samples.

At the end of nominal minute 3:

- minute-2 HR = mean valid HR from active seconds 60..119 of that stage
- minute-3 HR = mean valid HR from active seconds 120..179 of that stage

A stage is HR-steady when `abs(mean_minute_3 - mean_minute_2) <= 5 bpm`.

Missing samples are not interpolated. Each evaluated 60-second window needs at least 45 valid samples.

If either window lacks coverage, the stage is not yet steady/usable.

## Extension behavior

If the stage is not steady after minute 3, extend the same workload for one additional active minute and re-evaluate the latest two complete 60-second windows.

At most two extension minutes are allowed (maximum stage duration 5 active minutes).

If HR is still not steady after five minutes:

- mark the stage `unstable_hr` when both final windows had coverage
- mark the stage `insufficient_hr` when a final window lacked coverage
- do not fabricate a steady-state value
- keep the stage in evidence and continue according to remaining-stage rules

## Termination reasons

```text
protocol_complete
submax_hr_ceiling
early_cooldown
limit_reached
user_cancelled
hr_lost
insufficient_calibrated_workloads
other
```

These describe **why the protocol stopped**. They are not the VO₂ assessment outcome.

Protocol completion and estimator eligibility are separate. Counts of `accepted`, `unstable_hr`, and `insufficient_hr` stages are recorded so the estimator can require three accepted increasing workloads.

`limit_reached` means the user indicated they physically could not continue. It is not itself a VO₂ value. Open stages close as `incomplete`. The session moves into cooldown when the lifecycle allows it. Later ending the cooldown must **not** overwrite this reason with `user_cancelled`.

`early_cooldown` remains a distinct user choice to skip remaining work and cool down. It is not synonymous with `limit_reached`.

`user_cancelled` is an ordinary End test / cancel-and-save while work is still in progress and no prior protocol termination was recorded. The estimator still runs on whatever accepted evidence exists.

## Physiological ceiling

SISU currently has **no authoritative HRmax**. Profile stores weight/height/age/sex, not HRmax. HR zones are absolute BPM bands, not %HRmax.

Protocol v1 therefore does **not** invent `220 - age` or any other HRmax formula.

Automatic 85% HRmax enforcement is unavailable. Completion evidence sets `automatic_submax_hr_ceiling_available: false`. Early Cooldown and Cancel remain the user safety exits. This is not medical test safety validation.

If an authoritative HRmax is added later, protocol v1's `submax_hr_ceiling` reason exists for that future policy and must not be back-applied by guessing.

## Early Cooldown

Early Cooldown remains available. The current work stage ends as `incomplete` unless already closed, protocol termination is `early_cooldown`, and the existing Early Cooldown transition starts cooldown. Evidence remains valid as an attempted test. The estimator still runs; it may return `estimated` or `insufficient_evidence`.

## Limit reached

VO₂-specific stop action. Termination reason is `limit_reached`. Open stages close as `incomplete`. Cooldown starts. The workout is not treated as a VO₂-assessment failure merely because work ended here. The estimator still uses only `accepted` stages.

## Cancel

Existing cancellation remains authoritative for **workout lifecycle** (`summary.cancelled`). If the protocol has not already recorded a termination reason, that reason is `user_cancelled`. Open stages close as `incomplete`. If the protocol already recorded `limit_reached` or `early_cooldown` (for example the user ends cooldown early), that protocol reason is preserved. No phantom accepted stage continues beyond cancellation. The estimator still runs.

## Manual vs automatic resistance

Existing machine guidance remains the only resistance policy/command source. The protocol supplies the desired fixed resistance for the current stage/warmup/cooldown. When Bike Bridge automatic control is enabled, that guidance is forwarded by the existing Bike Bridge session. Otherwise SISU issues the normal manual resistance instruction.

The protocol module does not POST to Bike Bridge.

## Evidence contract

Protocol evidence is an optional field on the existing local `vo2_evidence` object. Schema version remains **1**; the addition is backward compatible.

Ordinary workouts may have `vo2_evidence` without `protocol`. Historical workouts without evidence still load. Historical evidence is not rewritten. SISU server ingest still strips `vo2_evidence` entirely.

Shape (application field names):

```text
protocol?: {
  protocol_id: "bike-submax-70rpm"
  protocol_version: 1
  prescribed_cadence_rpm: 70
  stages: [{
    stage_id
    active_start_sec
    active_end_sec
    requested_watts?
    prescribed_resistance
    calibrated_watts_at_70rpm
    status: accepted | unstable_hr | insufficient_hr | incomplete
    nominal_duration_sec
    actual_duration_sec
    hr?: { sample_count, minute_2_mean_bpm?, minute_3_mean_bpm?, final_two_window_delta_bpm?, steady_state_bpm? }
    workload?: {
      source: measured_watts | calibrated_at_verified_cadence | prescribed_only
      estimator_watts?
      calibrated_watts_at_70rpm
      measured_watts_median?
      measured_watts_sample_count
      measured_cadence_median_rpm?
      measured_cadence_sample_count
      cadence_in_band_ratio?
      cadence_measured
      watts_measured
    }
  }]
  termination: { reason }
  automatic_submax_hr_ceiling_available: boolean
}
```

Invariants:

- `calibrated_watts_at_70rpm` is a calibration estimate, not measured power
- `prescribed_resistance` is a command/prescription, not necessarily observed resistance
- 70 RPM is prescribed cadence, not measured cadence unless `cadence_measured` is true
- cadence coaching is not an HR prescription
- raw HR remains in `hr_samples`; protocol evidence does not duplicate the full HR trace
- compact stage `workload` may include measured RPM/watts summaries from the existing Bike Bridge poll; raw 1 Hz telemetry is not retained indefinitely
- no measured cadence or measured watts are invented from prescription alone
- prescribed resistance is never above the protocol-v1 commandable ceiling of 10

## Reproducibility / snapshot behavior

When the test begins, the resolved protocol plan is frozen on `vo2ProtocolRuntime.plan`. That object is the single authority for this attempt.

- protocol_id / protocol_version
- prescribed cadence
- warmup resistance and calibrated watts
- resolved stage resistances and calibrated watts
- requested watts for each resolved stage (the +25 W target actually fed to the resolver)

A later machine-profile change must not rewrite what this workout prescribed. The entire global machine profile is not snapshotted.

Stage HR evaluation reads the canonical IndexedDB `hr_samples` store. The protocol does not keep a second raw HR trace.

## Limitations

- Not a clinical CPET
- Not an official YMCA, Astrand-Ryhming, ACSM, or clinical exercise test
- Protocol cadence is prescribed; measured cadence is used only when Bike Bridge RPM is present
- 70 RPM is coaching text and machine-guidance cadence, not an HR target
- Calibrated 70-RPM watts are table estimates; estimator v1 uses them only after cadence is verified, or uses measured watts when those are available
- Predicted HRmax uses Tanaka 2001 (`208 − 0.7 × age`), not a measured HRmax
- Automatic 85% HRmax protocol termination remains unavailable (`automatic_submax_hr_ceiling_available: false`)
- Estimator v1 still applies its own HR operating envelope: ≥ 110 bpm and strictly below 85% of predicted HRmax. That envelope is a submaximal validity constraint, not a claim that this workout is an official YMCA test.
- Automatic Bike Bridge control is optional
- Manual resistance remains supported
- Without measured watts or verified cadence, estimator v1 does not produce a number
- The displayed VO₂ value is a **submaximal cycling estimate**, not gas-analysis VO₂ max
- Pause-safe timing uses the existing active workout clock; resistance-command time is not proof the bike physically reached that resistance
- machine calibration: resistance 1..15
- current VO2 protocol v1 commandable range: resistance 1..10

## Estimator

```text
VO₂ Protocol v1
        ↓
accepted steady-state stages
        ↓
evidence sufficiency
        ↓
versioned submax cycle estimator (`bike-submax-linear-hr-workload` / version 1)
        ↓
Vo2AssessmentResult (`vo2_assessment`)
```

Independent concepts:

```text
workout lifecycle     (completed vs cancelled)
protocol termination  (protocol_complete, limit_reached, early_cooldown, user_cancelled, ...)
VO₂ assessment        (estimated vs insufficient_evidence)
```

These combinations are all valid:

```text
protocol completed + estimate produced
protocol completed + insufficient evidence
limit reached + estimate produced
limit reached + insufficient evidence
early end + estimate produced
early end + insufficient evidence
```

### Sufficiency

An estimate requires all of:

1. valid protocol evidence: `protocol_id` `bike-submax-70rpm` **and** `protocol_version` 1 (a future v2 must not flow through estimator v1)
2. explicit stored profile **age** and **body weight** (weight is entered in pounds and snapshotted as kilograms; form placeholders/defaults are not inferred)
3. at least 3 `accepted` work stages
4. at least 3 of those stages estimator-eligible
5. valid steady-state HR on every stage used
6. valid **performed** workload on every stage used (`measured_watts` or `calibrated_at_verified_cadence`)
7. each used HR in the estimator-v1 envelope: ≥ 110 bpm and < 85% of predicted HRmax
8. strictly increasing workloads
9. strictly increasing HR with workload
10. a stable linear HR-vs-watts fit with slope > 0 and R² ≥ 0.70 (`fit_quality` classifies that R² as high / moderate / low; it is not overall VO₂ confidence)
11. a finite extrapolation to predicted HRmax that yields a VO₂ inside 10–100 ml/kg/min

`incomplete`, `unstable_hr`, and `insufficient_hr` stages are never estimator points. Protocol-accepted stages that fail the HR envelope or lack performed-workload evidence remain in diagnostics as ineligible; they are not silently dropped to manufacture an estimate from leftovers unless at least three other stages are independently eligible.

Thirty-minute plan completion is **not** a sufficiency rule. Cooldown completion is **not** required. `limit_reached` is **not** itself sufficient evidence.

Unsupported protocol version is `unsupported_protocol_version`, not `missing_protocol_evidence`. Diagnostics persist `expected_protocol_id`, `expected_protocol_version`, `observed_protocol_id`, and `observed_protocol_version`.

### Formulas (estimator version 1)

Predicted HRmax (Tanaka 2001):

```text
HRmax = 208 − (0.7 × age_years)
```

HR / workload fit on accepted stages:

```text
HR = slope × watts + intercept
predicted_max_watts = (HRmax − intercept) / slope
```

ACSM leg-cycle conversion:

```text
VO2 ml/kg/min = (10.8 × predicted_max_watts / weight_kg) + 7
```

Absurd or non-finite results are rejected as `insufficient_evidence` with an explicit reason code. They are never clamped into a plausible range.

### Assessment statuses

- `estimated` — a VO₂ max estimate was produced from accepted evidence
- `insufficient_evidence` — the test was recorded, but the estimator could not produce a reliable value

### Versioning

A change to the HR/workload model, HRmax formula, ACSM constants, sufficiency rules, HR envelope, workload-source policy, or R² threshold must increment `estimator_version` (or introduce a new `estimator_id`). Historical `vo2_assessment` rows keep the snapshot of protocol id/version, estimator id/version, accepted vs eligible stages, per-point workload source, HR, watts, cadence measured vs prescribed, age/weight/HRmax, and regression diagnostics used at finalization. Later profile edits do not rewrite old estimates.

`vo2_assessment` and `vo2_evidence` remain local. SISU ingest strips both.
