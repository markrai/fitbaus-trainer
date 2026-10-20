# Changelog

## [0.10.13] - 2026-10-05

### Changed

- **Bike Bridge metric colors.** Machine-guidance and Bike Bridge status RPM,
  resistance, and watts values now use the same colors as FitBaus Bike Bridge:
  magenta (`#FF00FF`) for RPM, orange (`#FF8C00`) for resistance, and blue
  (`#0096FF`) for watts, when a live measurement is present.

## [0.10.12] - 2026-08-31

### Added

- **VO2 submax estimator.** The standalone VO2 Max Estimation workout now
  evaluates protocol evidence at finalization and persists a local
  `vo2_assessment` (`bike-submax-linear-hr-workload` / version 1). Estimator v1
  consumes only `bike-submax-70rpm` / version 1, requires an explicit saved
  age and weight, and uses performed workload (`measured_watts` or cadence-
  verified calibration) plus a 110 bpm / <85% predicted-HRmax envelope.
  Regression R² is stored as `fit_quality`, not overall confidence.
  `limit_reached` is a distinct protocol termination from cancel / Early
  Cooldown. Historical assessments snapshot inputs and workload provenance so
  later profile edits do not rewrite them. Assessment and evidence remain
  stripped from SISU ingest. New VO2 runtime modules are included in the PWA
  precache list.

## [0.10.11] - 2026-08-28

### Added

- **Standalone VO2 test protocol added.** Workout selector includes
  `VO2 Max Estimation`, a versioned SISU Bike Submax Protocol v1
  (`bike-submax-70rpm` / version 1). The test records protocol evidence on
  local `vo2_evidence.protocol`. Protocol-v1 workloads resolve only within
  commandable resistance 1–10 so current automatic Bike Bridge transport
  cannot silently rewrite a prescribed stage. Machine calibration remains
  1–15. **VO2 estimation is not yet calculated.**
  See `VO2-TEST-PROTOCOL-V1.md`.

## [0.10.10] - 2026-08-28

### Added

- **VO2 evidence foundation** - Completed workouts can persist local
  `vo2_evidence`: pause-safe active duration, phase boundaries, work-end /
  cooldown markers (including Early Cooldown), HR acquisition facts, and
  machine provenance. Evidence only; no VO2 calculation, workout, or UI.
  Historical workouts without evidence remain unchanged. Evidence is stripped
  from SISU server ingest. See `VO2-EVIDENCE-FOUNDATION.md`.

## [0.10.9] - 2026-08-28

### Added

- **FitBaus Bike Bridge client** - Settings -> Equipment can store a LAN bridge
  URL and optional automatic resistance control. Native Capacitor HTTP polls
  `/api/v1/status` and `/api/v1/telemetry` once per second and posts absolute
  `/api/v1/resistance` targets from existing machine guidance. Observed bike
  resistance, RPM, and watts stay independent of requested/desired values.

### Fixed

- **Bike bridge resistance range** - ProForm physical levels 1-15 are posted
  unchanged. The client no longer clamps 11-15 down to 10. Android cleartext
  documentation no longer claims Network Security Config is limited to the
  FitBaus host; SISU ingest remains HTTPS-only in application code.

## [0.10.8] - 2026-08-27

### Added

- **Controller decision audit** - Local workout summaries can include a bounded
  `machine_decision_audit` of work-phase scheduling, HOLD/increase/decrease
  evaluations, and insufficient-HR deferrals without changing live guidance.

### Fixed

- **In-workout portrait height** - Pause, phase, machine card, and ring no
  longer push the heart and machine icons below the viewport on short phones.
  Leftover portrait height is distributed between those blocks so the stack is
  not packed at the top on taller phones. The ring sits above the heart and
  activity icons instead of overlapping them. The gray workout card fills the
  phone height and sits just above the warm-up / workout duration line. The
  start / pause row sits halfway between the day dropdown and the phase bar.

## [0.10.7] - 2026-08-27

### Added

- **Machine diagnostics export** - Settings -> Equipment can export an on-device
  machine-learning diagnostics snapshot, including timing evidence without
  inventing concrete evaluation times from phase duration alone.

### Fixed

- **Workout JSON download** - Download JSON from the workout list and summary
  modal uses in-memory summary data so the browser keeps the user gesture.
- **Modal overlay stacking** - Dialog overlays use a higher z-index so they sit
  above the hamburger / chrome UI.
- **Native system bars** - System bars stay hidden after app resume on native
  builds.

## [0.10.6] - 2026-08-26

### Added

- **Shadow resistance prediction** - Shadow-only resistance / HR predictions for
  machine guidance (no live resistance control changes).
- **Shadow prediction validation** - High-confidence validation of frozen ±1
  shadow predictions with a processed-session ledger.

### Fixed

- **Shadow HR levels** - Shadow HR estimates use effective / achievable
  resistance levels for hypothetical steps.

## [0.10.5] - 2026-08-26

### Added

- **HR response reliability** - Track observable response windows versus
  detected onsets (lifetime and recent bounded opportunity history).
- **Trusted earlier timing** - Medium / long evaluation waits may shorten when
  recent high-confidence opportunity history allows; short-interval timing
  defaults are unchanged.

## [0.10.4] - 2026-08-26

### Added

- **Machine HR dynamics learning** - Learn heart-rate response delay and delta
  after work starts and after ±1 resistance steps.
- **Personalized evaluation timing** - Medium / long evaluation waits use
  trusted delay medians from learned dynamics.

## [0.10.3] - 2026-08-26

### Added

- **Learned starting resistance** - Learn starting resistance per
  machine / activity / intent / duration class from qualifying completed
  sessions.

### Fixed

- **Late-work HR gate** - Learned starts train only when late-work HR is within
  target (±3 bpm).

## [0.10.2] - 2026-08-26

### Added

- **Machine-aware workout guidance** - Resistance / cadence guidance semantics
  for profiled machines (rolling-median HR gates, short-interval finalize,
  recovery cadence at 63 RPM).
- **Runtime activity selection** - Choose workout activity at start when a plan
  allows more than one.

### Changed

- **Short-interval adaptation** - Evaluate only with usable HR near the end of
  the repetition; finalize next-rep adaptation at the work-phase boundary when
  the last in-phase tick is missed.

## [0.10.1] - 2026-08-25

### Added

- **Machine profiling** - Equipment profiles and ProForm SMART Power 10
  resistance / cadence guidance with equipment selection and voice prompts.
- **Short-interval adaptation** - Adapt short-interval reps from evaluable HR
  near the end of the work phase.

## [0.10.0] - 2026-08-25

### Added

- **Capacitor 8 native apps** - Android and iOS shells with community plugins
  for Bluetooth LE, Keep Awake, and text-to-speech. Native builds use
  `CapacitorHttp` for SISU `/health` and `/workout/ingest`; the hosted PWA path
  (Web Bluetooth, browser speech, Screen Wake Lock, service worker) is
  unchanged. See [NATIVE-DEVELOPMENT.md](NATIVE-DEVELOPMENT.md).

## [0.9.41] - 2026-02-22

> Formerly labeled `APP_VERSION` **0.9.9** after the post-0.9.34 reset.

### Added

- **Open Graph / social meta** - Share-oriented meta tags for the hosted app.
- **Facebook share interstitial** - Interstitial UI for Facebook sharing.

## [0.9.40] - 2026-02-19

> Formerly labeled `APP_VERSION` **0.9.8** after the post-0.9.34 reset.

### Changed

- **Release readiness** - Manifest, service worker, and packaging polish ahead
  of release.

## [0.9.39] - 2026-02-17

> Formerly labeled `APP_VERSION` **0.9.7** after the post-0.9.34 reset.

### Added

- **Downregulation graph** - Heart-rate graph visualization for downregulation
  sessions.

### Changed

- **Custom HR target visibility** - Custom downregulation HR target is shown
  only in the noise visualization.

## [0.9.38] - 2026-02-17

> Formerly labeled `APP_VERSION` **0.9.6** after the post-0.9.34 reset.

### Added

- **Whale & none visualizations** - Additional downregulation visualization
  options.

## [0.9.37] - 2026-02-17

> Formerly labeled `APP_VERSION` **0.9.4** after the post-0.9.34 reset.

### Enhancements

- **Downregulation play control** - Play button available for all
  downregulation visualizations.

## [0.9.36] - 2026-02-17

> Formerly labeled `APP_VERSION` **0.9.2** after the post-0.9.34 reset.

### Enhancements

- **Downregulation viz polish** - Improvements across downregulation
  visualizations.

## [0.9.35] - 2026-02-14

> Formerly labeled `APP_VERSION` **0.9.1** after an accidental reset from
> **0.9.34**.

### Enhancements

- **Noise visualization** - Downregulation noise viz enhancements.

## [0.9.34] - 2026-02-14

### Changed

- **Goo credits** - Credit attribution for the Goo downregulation animation.

## [0.9.33] - 2026-02-14

### Added

- **HR-controlled dots** - Downregulation dots driven by heart rate.
- **Goo visualization** - Goo animation option, constrained so it cannot drift
  too far off the bottom of the screen.
- **Starfield restored** - Starfield available again as a second downregulation
  option.

## [0.9.30] - 2026-02-13

### Fixed

- **Downregulation play after summary** - Play button reappears after the
  downregulation summary.

## [0.9.27] - 2026-02-13

### Fixed

- **Battery + HR on mobile** - Chest-strap battery polling and HR monitoring no
  longer conflict on mobile.

## [0.9.26] - 2026-02-13

### Changed

- **Version bump** - Patch release marker (no separate feature commit).

## [0.9.25] - 2026-02-13

### Fixed

- **Mobile HR display** - Heart rate shows correctly on mobile again.

## [0.9.22] - 2026-02-13

### Added

- **NAS auto-deploy** - Development deploy path to NAS.

## [0.9.21] - 2026-02-12

### Enhancements

- **Faster starfield** - Increased downregulation starfield speed.
- **Downregulation SISU sync** - Downregulation sessions can sync with SISU.

## [0.9.20] - 2026-02-12

### Enhancements

- **Downregulation performance** - Optimizations for downregulation rendering
  and session handling.

## [0.9.17] - 2026-02-11

### Changed

- **Live HR only** - Removed simulated HR from downregulation.
- **Starfield + HR** - Fundamental starfield movement change synchronized with
  heart rate.

## [0.9.16] - 2026-02-11

### Added

- **Downregulation mode** - Guided downregulation sessions with orb viz and
  current HR in the bottom-left.

### Fixed

- **Stop downregulation** - Correct teardown when stopping a downregulation
  session.
- **Strap disconnect** - Clear HR when the chest strap disconnects.

## [0.9.15] - 2026-02-11

### Changed

- **Architectural modularization** - Phases 1–3 of the TypeScript module
  refactor, including splitting `updateDisplay`.

### Fixed

- **Strap battery indicator** - Re-implement indicator, remove extra dot, and
  poll battery level.
- **HR animation fidget** - Stabilize the heart fidget animation.

## [0.9.14] - 2026-02-11

### Added

- **Battery indicator UI** - Chest-strap battery level indicator.

## [0.9.12] - 2026-02-11

### Added

- **HR strap connection indicator** - Visual connection state for the chest
  strap.
- **Strap battery level** - Show chest-strap battery level.

## [0.9.11] - 2026-02-10

### Added

- **Deploy script + folder** - Dedicated deploy path for releases.
- **Single-source version sync** - `version.js` is the source of truth; sync
  script updates `src/version.ts` and `package.json`.

## [0.9.9] - 2026-01-28

### Added

- **TypeScript migration** - App source moved to TypeScript with `package.json`
  tooling.
- **Cancelled workouts** - Explicit cancelled-workout concept in session data.
- **Ring elapsed / remaining toggle** - Toggle total remaining versus total
  elapsed on the progress ring.

### Changed

- **Decrementing ring** - Ring decrements by default with phase-appropriate
  colors.
- **Pre-workout HR on white heart** - HR value uses black text on the white
  heart before a workout starts.
- **SISU port placeholder** - Default / placeholder port updated to 443.

### Fixed

- **`updateDisplay` safety** - Try/catch around `updateDisplay()`.
- **Low BPM heart color** - Heart turns yellow when BPM is too low.

## [0.9.8] - 2026-01-28

### Changed

- **Workouts tab swipe colors** - Swapped swipe action colors on the workouts
  tab.

## [0.9.7] - 2026-01-28

### Added

- **Workout dropdown + pause** - Dropdown for workouts and a pause control.

### Fixed

- **Promise error** - Fix promise handling error in UI flow.

## [0.9.6] - 2026-01-28

### Fixed

- **Heart pulsating** - Correct heart pulse animation.
- **No-HR heart color** - Heart icon is white when no HR is detected.

## [0.9.5] - 2026-01-28

### Enhancements

- **Already installed** - Clearer indication when the PWA is already installed.

## [0.8.5] - 2026-01-20

### Added

- **Preferences tab** - Preferences UI, including optional seconds display in
  total workout time.

### Fixed

- **SISU host URL cleanup** - `cleanHostForUrl` and removal of a stray colon
  before the port.
- **Stale sessions** - Prevent sessions longer than 24 hours.
- **Day workout summary** - Remove today fallback; respect the day workout
  summary.

### Changed

- **Summary wording** - Rename “sustain” to “workout” in the summary block.

## [0.8.4] - 2026-01-14

### Added

- **Delete confirmation** - Confirmation dialog before deleting workout data.
- **SISU workout sync** - Sync completed workouts to SISU.
- **HTTPS for SISU** - Enforce HTTPS when connecting to SISU.

### Fixed

- **HR range heart color** - Heart color honors the configured BPM range.
- **VO2 interval countdown** - VO2 interval phases show the correct phase
  countdown instead of a sustain countdown.

### Changed

- **Zone 2 long machine** - Zone 2 long machine workouts are explicitly
  elliptical.

## [0.8.3] - 2026-01-14

### Changed

- **Version bump** - Patch release marker (no separate feature commit).

## [0.8.2] - 2026-01-14

### Added

- **Swipe to delete** - Swipe gesture to delete workout data.

## [0.8.1] - 2026-01-12

### Added

- **Variant days** - Variant-day workout capability.
- **SISU-aligned intents** - Intents aligned with SISU values (not opaque IDs).

### Fixed

- **Cardio range wrapping** - No-wrap on cardio range labels.

## [0.8.0] - 2026-01-12

### Added

- **Centralized versioning** - `version.js` as the app version source with an
  auto-updating service worker.

### Fixed

- **New-version popup loop** - Stop infinite “new version available” popup
  loops.

## [0.0.5] - 2026-01-12

### Enhancements

- **BPM layout** - BPM and BPM range aligned with the heart.

## [0.0.4] - 2026-01-11

### Added

- **PWA support** - Installable progressive web app (initial pass).
- **Workout JSON export** - Export JSON at end of workout.
- **Logo + data JSON** - Branding logo and corrected workout JSON.

### Enhancements

- **Mobile aesthetics** - Mobile layout polish.

## [0.0.3] - 2026-01-09

### Added

- **BLE / ANT+ HR** - Rudimentary chest-strap heart-rate capability.

### Enhancements

- **Sizing consistency** - More consistent control and layout sizing.

## [0.0.2] - 2025-12-12

### Enhancements

- **4×4 grid + emojis** - Expanded workout grid presentation.

## [0.0.1] - 2025-12-11

### Added

- **Initial trainer** - First workout trainer UI with profile, workout data,
  workout logic, and basic controls.
