# FitBaus equipment bridge for ProForm Smart Power 10.0

Trusted-LAN Android bridge for **one** machine: the **ProForm Smart Power 10.0**
console. Native Kotlin claims the bike USB interface while stock iFIT is
stopped, authenticates when the board requires unlock, exposes Resistance /
RPM / Watts telemetry, and serves a small HTTP API on the local network.

This is an **equipment bridge**, not a stand-alone flagship product. FitBaus
Trainer is the product. This tree is intended to live under:

```text
equipment-bridges/proform-smart-power-10/
```

## Target hardware (exact)

| Item | Value |
| --- | --- |
| Console | ProForm Smart Power 10.0 only |
| Android | 5.1.1 / API 22 |
| ABI | x86 (`byt_t_crv2`) |
| Stock packages | `com.ifit.standalone` (Wolf), `com.ifit.eru`, `com.ifit.launcher` |
| Brainboard USB | VID `8508`, normal PID `2`, bootloader PID `153`, interface `0` |
| Production package | `com.fitbaus.bikebridge` (product version from repo-root `version.js`, currently `1.0.0`) |

**Not claimed:** generic ProForm, generic exercise bikes, other iFIT equipment,
or modern 64-bit Android consoles.

## USB ownership

Do not run this bridge and Wolf at the same time. They cannot share the USB
interface.

- **Stock mode:** `com.ifit.standalone` owns USB.
- **FitBaus mode:** stop Wolf (and ERU), then launch this app. Do not uninstall Wolf.

This app does **not** kill, disable, or uninstall stock packages. Isolation is
an operator/adb step.

## Current capabilities

Kotlin sources and Native unit tests define behavior. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/PROTOCOL.md](docs/PROTOCOL.md).

### Trusted-LAN HTTP (`0.0.0.0:8765`)

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/health` | Listener health + connection flags |
| `GET` | `/api/v1/status` | Bridge / machine status |
| `GET` | `/api/v1/telemetry` | Observed resistance / RPM / watts |
| `POST` | `/api/v1/resistance` | Absolute integer resistance request (pairing token) |
| `POST` | `/api/v1/heartrate` | Display-only HR ingest (pairing token) |
| `POST` | `/api/v1/brightness` | Console **window** brightness (pairing token) |

Control POSTs require header `X-Fitbaus-Token` matching the 8-character token
shown on the pairing screen (`XXXX XXXX`). GET routes do not. Bind is on all
interfaces for LAN reachability. **Trusted local network only. Do not expose
to the public Internet.** Resistance control moves physical machine load.

The surface does **not** expose arbitrary USB, incline, calibration, firmware,
bootloader, relative ± resistance, ramping, or workout-control APIs.

### Resistance control

- Accepted body: absolute integer **1–15** (`ResistanceLimits`).
- Board `maxResistanceLevel` is observed **22** on this bike and is the codec
  denominator, not the HTTP window.
- Production identity uses AuthOnly: one VerifySecurity when DeviceInfo
  requires unlock. Writes are allowed only after the controller is Unlocked.
  Staging AuthOnly was qualified on two cold boots (including R3). The
  production APK has been verified on a warm controller (authentication and
  advertised control), not as production R3 or a production cold start.
- Staging WarmState (`unlockQualification=off`) skips VerifySecurity. It is a
  diagnostic / limited fallback and does not reliably write resistance from a
  cold controller.
- A transmitted write that returns `SECURITY_BLOCK` fails closed.
- HTTP 200 means the bike accepted that write (Done). It is **not** proof the
  physical bike has reached that resistance. Observed resistance comes only
  from telemetry field 2.

### Heart rate and brightness

- HR: display ingest only (30–250 BPM); never initializes USB or changes resistance.
- Brightness: Activity window percent 0–100; never bike control. Last accepted
  value is persisted and reapplied when the Bridge Activity becomes visible.

## Security boundary

| Fact | |
| --- | --- |
| Control POST auth | Pairing token (`X-Fitbaus-Token`) |
| GET telemetry/status | Unauthenticated on the trusted LAN |
| Intended network | Trusted LAN only |
| Public Internet | **Must not** be exposed |
| Resistance POST | Physical-machine action |

## Repository layout

- `native/` — production Kotlin Bike Bridge (protocol, host, USB probe)
- `docs/` — architecture, protocol, Freestyle diagnostic, retired-host note
- `scripts/` — operator helpers (APK identity, bounded resistance actuation)

Arcade lives in `equipment-bridges/shared/arcade/` and is linked from Native.
It does not own USB or resistance.

## Arcade games

The console title bar has a DASHBOARD tab and five game tabs: BRICKS, MATH,
FLAK RUN, TRAIL RIDE and BIKETRIS. The game tabs sit in a horizontal scroller
that only uses the space between the FITBAUS title and the settings gear, so
the gear always stays visible. The exercise HUD (RPM, watts, resistance, HR)
stays above every game. Games only **read** cadence telemetry. They never send
resistance, change workouts or bike modes, or touch the USB session, and
switching games never restarts the bridge service. Only one camera pipeline
runs at a time.

### TRAIL RIDE

A first-person mountain-bike ride through an endless forest. The trail
winds procedurally and gets gradually harder (sharper bends, then tree
gates and slaloms).

- **Steer with your head.** Look at the screen and hold still for about a
  second while it centers, then lean your head slightly left or right. The
  bike moves toward that side at a limited speed. Holding your head still
  does **not** follow the bends: you steer through every curve.
- **Pedal to ride.** The world only moves while fresh RPM shows you
  pedaling (20 RPM or more). Speed varies modestly with cadence (about
  40-100 RPM); a faster baseline is never required. If you stop, the game
  shows `PEDAL TO RIDE` and waits.
- **Stay on the trail and miss the trees.** Riding past the trail edge for
  about 0.3 s, hitting a trunk or rock, or falling into a ditch is a crash:
  a short pause, a slow restart and two seconds of protection, then the ride
  carries on. There is no game over; the HUD counts your crashes.
  Orange edges and `STEER LEFT` / `STEER RIGHT` warn you near the edge.
- **Jump ditches with a pedal surge.** Ditches span the whole trail, marked
  by orange flags; steering cannot avoid them. When `SURGE NOW!` appears
  (about 1.7 s before the ditch), pedal clearly faster: by default 12 RPM
  above your current steady pace. The game keeps re-learning that pace
  whenever you hold a cadence steady (within about ±3 RPM for 2 s), faster
  or slower than before. The surge must climb there within about 2 s (a slow
  drift in cadence is not a surge) and be confirmed by fresh samples (about
  0.5-0.75 s), and the jump only counts if it is confirmed between 1.25 s and
  0.12 s before the ditch. A surge that is too early or too late fails.
  Each jump needs a new surge: after one, hold any steady pace for about 2 s
  to rearm (`STABILIZE PACE` on the meter). You never have to slow down, and
  holding a fast cadence never jumps again by itself.
- **Holds.** Starting the camera, a lost face, missing or stale bike data,
  stopping pedaling, and the first ~3 s while it learns your pace all
  freeze the game; nothing advances and no life is lost while held. After
  the face returns it waits about 0.6 s for a stable view.
- **Score.** Points for distance, each obstacle passed, each ditch cleared
  (+150) and each new level. The ride is endless; scores are session-only.
  `Restart ride now` in the developer options starts a fresh ride.

**Developer options** (long-press the TRAIL RIDE tab):

| Option | Effect |
| --- | --- |
| Face 10 Hz / 15 Hz | Face tracker preset. TRAIL RIDE keeps its own preference, separate from FLAK RUN. Default 10 Hz, 1 thread. |
| Head sensitivity | Low / Medium / High / Very high steering gain. |
| Jump surge threshold | +8 to +18 RPM above the current steady-pace baseline (default +12). |
| Recenter head now | Re-learns the neutral head position. |
| Ditch timing guide | Draws the takeoff window on the trail. |
| World seed | Random each ride, or a fixed seed for reproducible layouts (restarts). |
| Simulated cadence | Developer-only fake RPM with an on-screen `SIMULATED SURGE` button. The HUD is labeled `SIMULATED`, and simulated input never reaches the bike. |
| Restart ride now | Starts a new ride. |
| Diagnostics overlay | Shared with the other games. Shows face age and x, steering target vs rider x, trail center and lateral error, RPM age, detector state, armed, baseline/threshold, current pace and spread, steady progress, pending confirmations, time since the last near-baseline sample and boost, jump state and time to the next ditch, last crash reason, frame/update/draw timings, sprite count, memory and world sizes. |

TRAIL RIDE has not yet been qualified on the physical console. Use the
diagnostics overlay (frame, update and draw p50/p90) with face tracking
active to confirm it holds about 30 FPS on the Atom Z3735G.

### BIKETRIS

A falling-block puzzle on a 10x20 board (two hidden rows above it). Your
cadence sets how fast pieces fall (read-only RPM; nothing is sent to the
bike), and pieces keep falling whether or not you pedal.

- **Move with your head.** The same mirrored face x as BRICKS (camera
  columns 30-70 % span the whole board) maps to the piece's leftmost
  occupied column across `0 .. 10 - width`, so the piece always stays on the
  board. A column change needs the head to pass the midpoint between columns
  by 0.2 columns (hysteresis), and the piece slides one column at a time at
  most every 60 ms, stopping at walls and settled blocks.
- **Wave to rotate.** One deliberate sideways wave, in either direction,
  rotates the piece 90° clockwise once (`ROTATE` with a check mark confirms
  it). Wave beside the face, at shoulder height or across the chest, with
  either hand, while pedaling. Waving continuously rotates only once; pause
  the arm briefly (about 0.2 s) after the cooldown (default 650 ms) to wave
  again. Pedaling and the rest of the scene do not need to be still.
- **Pieces and rules.** All seven pieces, a seeded seven-piece bag, a next
  piece preview and a ghost outline of the landing position. Rotation follows the standard
  rotation-system states and wall-kick tables (five tests per turn; O does
  not kick). Gravity starts at 720 ms per row at neutral cadence and gets
  12 % faster per level (minimum 150 ms before the cadence multiplier); a
  level is 10 lines. A landed piece locks after 0.5 s;
  moving or rotating resets that delay at most 12 times. Full rows clear
  together. Score: 100 / 300 / 500 / 800 for 1-4 lines, times the level.
  The game ends when a new piece cannot spawn.
- **Holds.** A lost face keeps the piece falling (without sideways moves) for
  0.6 s, then everything pauses until the face has been stable again for
  0.6 s.
- **Cadence modes.** The selector in the right-hand panel switches between
  `PEDAL TO SLOW` (default) and `PEDAL TO SPEED UP`. The choice is saved, can
  change mid-game without touching the board or score, works on the game-over
  screen, and eases in over about half a second. Below it the panel shows
  your smoothed `RPM`, the current `FALL` interval and a hint.
- **Touch fallback.** Drag across the board to move. There is no touch
  rotation; pieces rotate only with a wave. When the face is not being
  tracked (camera unavailable or starting, or no face found), any drag or
  board tap starts touch play: the game keeps running with no finger down
  until it ends, you leave BIKETRIS, the game restarts, or a face has been
  tracked steadily for 0.6 s, which hands control back to the head without a
  pause. While the face is tracked, a finger only overrides the head while
  it is down. `PLAY AGAIN` appears only after game over and keeps touch play
  going in the new game.

**Cadence mapping.** With `t = clamp((rpm - 40) / 60, 0, 1)`, the fall
interval is the level interval times `0.75 + 0.5 t` in `PEDAL TO SLOW` and
`1.25 - 0.5 t` in `PEDAL TO SPEED UP`, never below 100 ms:

| RPM | PEDAL TO SLOW | PEDAL TO SPEED UP |
| --- | --- | --- |
| 40 or less (including 0) | 540 ms | 900 ms |
| 70 | 720 ms | 720 ms |
| 100 or more | 900 ms | 540 ms |

(Level 1 values; higher levels scale the same way.) An RPM sample counts only
when its timestamp changes, it is current and the bike is connected and
initialized, the same rules FLAK RUN and TRAIL RIDE use. Cadence is smoothed
over about a second; one sample can pull the smoothed value at most 30 RPM,
so a single spike barely moves the fall speed. With no new sample for 2 s, or
with the bike disconnected or not initialized, the panel shows
`RPM UNAVAILABLE` and the fall speed eases back to neutral (720 ms at level
1) over a few seconds; it never freezes and never keeps the benefit of an old
fast reading. Changing speed keeps the piece's progress toward the next row,
so it never jumps or drops early, and the lock delay does not depend on
cadence. All calibration values live in `CadenceGravityConfig`.

The wave detector uses no model. It reuses the Face session's NV21 frames on
the camera thread, about 15 observations per second:

1. The Y plane is sampled into a 64x48 grid (four pixels per cell) in player
   space and compared with the previous observation after correcting for a
   global gain change.
2. A compact box around the tracked head (face box plus margins, widened by
   the head's recent sideways travel) is ignored. Everything beside, above
   and below it is analysed, including the shoulders and chest.
3. Changed cells are joined into regions. Each region is block-matched
   against the previous grid over its changed cells only, so static
   background never votes; large regions are matched in 8x8-cell blocks and
   regrouped by similar motion, so a waving hand is separated from a torso
   moving with the head.
4. Each region's sideways shift is taken relative to the head: motion along
   with the head is discounted, motion against it is not.
5. A wave is one region moving one way, mostly sideways, until it has
   travelled 14 % of the frame width (Medium) within 650 ms over at least two
   observations. One weaker opposite reading inside a wave is ignored.
6. After a wave the detector rearms only when sideways motion has stayed
   below a release level for 180 ms and the cooldown has passed. That level
   follows a slow baseline of background sideways motion, so pedaling,
   clothing and flicker do not hold it unarmed; a continuously waving arm
   does. Whole-frame changes and camera gaps also wait for that release.

It recognises motion, not hands. Thresholds come from synthetic tests and have
not been tuned on the console. Very fast flicks (a quarter-turn of the forearm
in under about 200 ms) are not reliably detected in those tests.

**Developer options** (long-press the BIKETRIS tab):

| Option | Effect |
| --- | --- |
| Face 10 Hz / 15 Hz | Face tracker preset. BIKETRIS keeps its own preference. Default 10 Hz, 1 thread. |
| Head sensitivity | Low / Medium / High / Very high gain around the centre. |
| Wave rotation | On / off, to compare with touch-only rotation. |
| Wave sensitivity | Low / Medium / High: minimum sideways travel 16 / 14 / 11 % of the frame width and onset speed; Low also ignores smaller brightness changes. |
| Wave cooldown | 500 / 650 / 800 / 1000 ms. |
| Simulate one wave rotation event | Publishes a labeled simulated event through the same one-shot channel. |
| Restart game now | Starts a new game. |
| Diagnostics overlay | Shared with the other games. Text: camera state, face rate, age and x, mapped target column; wave state, what the last observation saw (`None` no eligible motion, `Unexplained`, `Lateral`, `WithHead`, `Vertical`, `Broad`, `Global`, `Stale`), sideways speed against the onset / release levels and baseline, direction and travel against the threshold, head speed; the event pipeline (detected, rejected with the last reason, ignored while rearming, published / refused, consumed, discarded, rotated, blocked by a collision); motion p50/p90 ms and frame/update/draw timings; and a cadence line (mode, status, raw and smoothed RPM, target and applied multiplier, level and effective fall interval, fall progress, sample age). A 64x48 heatmap in the lower left shows changed cells, the ignored head box (blue), moving regions (orange), the tracked region (green box) and an arrow for its direction and travel. |

BIKETRIS has not yet been qualified on the physical console.

**Wave acceptance on the console** (diagnostics overlay on, pedaling at a
normal cadence, head free to move):

| # | Trial | Pass |
| --- | --- | --- |
| 1 | Five deliberate waves beside the face | at least 4 rotations |
| 2 | Five waves at shoulder height | at least 4 |
| 3 | Five waves across the upper chest | at least 4 |
| 4 | Five waves with the opposite hand | at least 4 |
| 5 | One minute of pedaling without waving | no rotation |
| 6 | Head-only steering left and right, no waving | no rotation |
| 7 | Two separate waves with a normal pause between them | two rotations |
| 8 | One continuous back-and-forth wave for 3 s | exactly one rotation |

**Cadence acceptance on the console:** in each mode, hold about 40, 70 and
100 RPM for 10 s each and confirm the panel's `FALL` reads roughly the table
values (level 1); stop pedaling and confirm pieces keep falling; unplug the
bike USB briefly and confirm `RPM UNAVAILABLE` appears and the speed eases to
neutral, then recovers smoothly; switch modes mid-game and confirm the board,
score and current piece are kept; confirm the selector is fully visible and
both segments respond on the console screen.

For each wave trial, record from the overlay: `detected` (the detector accepted a
wave), `published`, `consumed`, `rotated` and `blocked`. A wave that never
reaches `detected` is a detection miss: note the `signal` and `last reject`
shown during the attempt and whether the green region box followed the hand.
`ignored while rearming` rising means the detector had not released. A
`discarded` count means the game was not live (face lost too long) or the
wave predated the current piece. `blocked` means the piece could not rotate
there and is not a detection failure. Targets: at least 80 % detection (goal
90 % after tuning), no unintended rotations, no repeated rotation from one
continuous wave, no visible change to head steering or frame rate (frame p90
in the overlay).

## Build and test

JDK **21**, Android SDK Platform **34**, NDK **26.1.10909125**, CMake **3.22.1**.
A local Android SDK is required (`native/local.properties` `sdk.dir=...`).

```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot"
cd native
.\gradlew.bat :equipment-protocol:test :bridge-app:testReleaseUnitTest :equipment-usb-probe:testDebugUnitTest :arcade:testDebugUnitTest
.\gradlew.bat :bridge-app:assembleRelease -PbridgeIdentity=production
```

Production assemble refuses `-PunlockQualification=auth` or `lockout`. Staging:

```powershell
.\gradlew.bat :bridge-app:assembleDebug
```

produces `com.fitbaus.bikebridge.native` (WarmState when unlockQualification=off:
skips VerifySecurity; not a reliable cold-controller control path).

`versionName` / `versionCode` and HTTP `bridgeVersion` come from repository-root
`version.js`. Independent Gradle builds read that file via
`rootProject.file("../../../version.js")`; they do not need npm first. The USB
probe keeps a separate tooling version. See [VERSIONING.md](../../VERSIONING.md).

Staging **release** APKs are unsigned and not normally installable. Staging
**debug** APKs are debug-signed. Production assemble still requires
`bikebridge.signing.*` and refuses staging qualification flags. A CI-packaged
production APK is not physical-device qualification. `adb install -r` needs the
same certificate as the installed app.

CI runs the same Native unit tests. It does not sign, deploy, or talk to a bike.

### Operator isolation (not in-app)

```text
adb -s <console>:5555 shell "am force-stop com.ifit.standalone; am force-stop com.ifit.eru"
adb -s <console>:5555 shell monkey -p com.fitbaus.bikebridge -c android.intent.category.LAUNCHER 1
```

Install with `adb install -r` so pairing data is preserved. Signing must match
the already-installed production certificate. Keystores are not in Git.

## License

FitBaus-owned source in this component is intended to be distributed under the
parent FitBaus Trainer repository’s **AGPL-3.0-only** license. STRIDE
Apache-2.0 attribution is in `native/equipment-protocol/NOTICE`. Do not commit
proprietary vendor runtimes or signing keys.
