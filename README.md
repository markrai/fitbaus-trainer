# FitBaus Trainer

Heart-rate workout trainer with BLE HR support, optional bike/equipment
integration, formal bike VO₂ assessment, and Capacitor Android/iOS shells.

The npm package is `fitbaus-trainer`. The native app ID is
`com.markrai.fitbaus.trainer`. Optional **SISU** sync names an external service,
not this product.

---

## What this is

FitBaus Trainer includes:

- Structured workout definitions (`data.json` and related prescription code)
- HR-guided workout execution
- BLE heart-rate capture (Web Bluetooth on PWA; Capacitor BLE on native)
- Optional equipment-bridge integration (LAN HTTP)
- Formal bike VO₂ assessment that can update athlete calibration
- Athlete state (`FitnessState`) and **shadow / research** personalization
- Machine-specific guidance and local equipment modeling
- Capacitor Android and iOS app shells

Live ordinary workouts are driven by **resolved HR targets**. Athlete-relative
watt personalization (E1 and related research) is **shadow**: it records advice
and evidence; it does **not** currently authorize resistance control.

For the full personalization authority model, see
[docs/personalization-architecture.md](docs/personalization-architecture.md).

---

## Current status

### Production / active paths

- Workout definitions → resolved HR prescription → live execution
- Live machine guidance from authoritative HR targets
- HR / BLE capture and workout history (IndexedDB)
- Formal VO₂ assessment and FitnessState formal calibration persistence
- Optional SISU HTTPS sync (personalization fields stripped before upload)
- Optional equipment-bridge LAN telemetry / resistance (when configured)

### Shadow / research paths

- **E1** athlete-relative watt candidates (does not control resistance)
- **E2** completed-workout characterization
- **Phase D** passive descriptive FitnessState (not prescription authority)
- **E4A** scientific / prospective validation (diagnostics only)
- Steady-state / Threshold settled-workload contracts (design / shadow; not
  normal product recommendation flow)

Do not assume Phase D, E4A, or settled-workload aggregates drive live
prescription. Details:
[docs/personalization-architecture.md](docs/personalization-architecture.md).

---

## Prerequisites

| Area | Requirement |
| --- | --- |
| Node.js | **≥ 22** (`package.json` `engines`) |
| Package manager | **npm** (lockfile: `package-lock.json`; prefer `npm ci` for a clean tree) |
| Android | See [NATIVE-DEVELOPMENT.md](NATIVE-DEVELOPMENT.md) (Android Studio, API 24+, Cap sync) |
| iOS | macOS + Xcode — see [NATIVE-DEVELOPMENT.md](NATIVE-DEVELOPMENT.md) |
| BLE testing | **Physical device**; iOS Simulator does not support BLE |

Native toolchain details (Studio/Xcode versions, API targets, cleartext/LAN
notes) live in [NATIVE-DEVELOPMENT.md](NATIVE-DEVELOPMENT.md). Do not duplicate
them here.

---

## Web / TypeScript workflow

From the repository root:

```text
npm ci
# or: npm install

npm run build    # TypeScript → dist/
npm run check    # tsc --noEmit
npm test         # build, then node --test allowlist

npm run serve    # static serve of the repo root (PWA loads ./dist/main.js)
```

Canonical contributor validation:

```text
npm run build
npm run check
npm test
```

There is no separate ESLint/Prettier gate in this repository today.

### Generated `dist/` policy

- `npm run build` runs `tsc` and emits modular JS under **`dist/`**.
- The hosted PWA loads **`./dist/main.js`** (`index.html`).
- Tests import from **`../dist/...`**, so `npm test` always builds first.
- **`dist/` is intentionally committed.** Edit **`src/`**, rebuild, and keep
  source + `dist/` changes together.
- Do not hand-edit `dist/` as the source of truth.

Native packaging uses a separate path: `npm run build:native` stages assets into
generated **`www/`** (gitignored). That output is for Capacitor `webDir`, not
the committed `dist/` tree.

---

## Native / Capacitor (overview)

Tracked `android/` and `ios/` projects are Capacitor shells. Typical flow:

```text
npm run build:native
npm run cap:sync          # or :android / :ios
npm run android           # sync Android + open Android Studio
npm run ios               # sync iOS + open Xcode (macOS)
```

iOS sync also runs `scripts/normalize-ios-spm.mjs`. Prefer the npm scripts over
ad-hoc Capacitor CLI use until you know the project conventions.

Full requirements, runtime boundaries (PWA vs native plugins, SISU HTTPS vs Bike
Bridge LAN HTTP), and device checklist:
[NATIVE-DEVELOPMENT.md](NATIVE-DEVELOPMENT.md).

---

## Where to start reading

| Topic | Path |
| --- | --- |
| Personalization authority | [docs/personalization-architecture.md](docs/personalization-architecture.md) |
| Native / Capacitor | [NATIVE-DEVELOPMENT.md](NATIVE-DEVELOPMENT.md) |
| Workout start / phase plan | `src/workoutLogic.ts` |
| Workout finalization | `src/workoutSummary.ts` |
| E1 shadow prescription | `src/personalizedPrescription.ts` |
| VO₂ protocol / estimate | `src/vo2Protocol.ts`, `src/vo2Estimator.ts` |
| Bike Bridge | `src/platform/bikeBridgeRuntime.ts` |
| Machine guidance / models | `src/machines/` |
| Local workout storage | `src/workoutStorage.ts` |
| Workout definitions | `data.json` |

---

## Equipment bridges

FitBaus Trainer can optionally integrate with model-specific equipment bridges
over a trusted LAN. Bridges are **not** required for normal Trainer use (HR
workouts, VO₂ assessment, history, and shadow personalization all work without
them).

Currently included:

| Equipment | Source |
| --- | --- |
| ProForm Smart Power 10.0 only | [equipment-bridges/proform-smart-power-10/](equipment-bridges/proform-smart-power-10/) |

That bridge has its own classic Xamarin.Android toolchain, hardware assumptions,
third-party runtime policy, and LAN security notes — see its
[README](equipment-bridges/proform-smart-power-10/README.md). Overview of the
organization: [equipment-bridges/README.md](equipment-bridges/README.md).

Do not assume generic ProForm or multi-machine support beyond what those docs
state.

---

## Data and privacy (short)

Workout history, HR samples, athlete profile / FitnessState, and related local
artifacts live on the device (IndexedDB / localStorage). A cloud backend is
**not** required to run the app. Optional SISU upload strips personalization
and related research fields before sync. See the personalization architecture
doc for what is local-only vs stripped.

---

## Contributing

1. Edit canonical TypeScript under `src/`.
2. Run:

   ```text
   npm run build
   npm run check
   npm test
   ```

3. Review generated `dist/`.
4. Commit the relevant `src/` changes together with corresponding generated
   `dist/` output.
5. Do not hand-edit `dist/` as source of truth.
6. Do not casually change persisted schema/version/resolver/policy identities;
   treat them as compatibility contracts.
7. Personalization changes must preserve the authority boundaries documented in
   [docs/personalization-architecture.md](docs/personalization-architecture.md).
8. Native changes should use the repository's documented Capacitor scripts and
   [NATIVE-DEVELOPMENT.md](NATIVE-DEVELOPMENT.md).

---

## License

FitBaus Trainer is licensed under the [GNU Affero General Public License
v3.0](LICENSE) only (`AGPL-3.0-only`). The package remains `"private": true` and
is not published to npm.
