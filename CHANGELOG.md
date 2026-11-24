# Changelog

All notable changes to FitBaus are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version
numbers follow [VERSIONING.md](VERSIONING.md).

FitBaus Full is developed on `main`. FitBaus Lite, a compact edition for
storage-constrained ProForm Smart Power 10.0 consoles without external webcam
support, is maintained on `lite/1.x`.

## [Unreleased]

### Fixed

- **IT HEARS YOU webcam steering.** Use the same 3% horizontal dead zone,
  180 ms camera-X smoothing and 2.4 steering gain as TRAILS' Medium preset.
  Small head movements no longer select a turn as readily; sustained leans
  still select junction directions. Controller thresholds and button behavior
  are unchanged.

## [2.2.0]

Full 2.2.0 (`versionCode 20200`) brings together the Full 2.1.1–2.1.3
development changes since 2.1.0: richer arcade graphics and controls,
integrated offline YouTube voice search, publication ages on video previews,
and improved YouTube playback and navigation.

### Changed

- **Arcade game selection names.** Rename the three game-selection tabs from
  FLAK RUN to **MAVERICK**, TRAIL RIDE to **TRAILS**, and GHOUL RUN to
  **IT HEARS YOU**. Existing game identifiers, controller mappings, saved
  preferences, and gameplay behavior are unchanged.

- **Trail Ride HUD refinement.** Remove the flashing “STEER LEFT” and
  “STEER RIGHT” guidance banners. Existing trail-edge visuals, off-trail
  speed reduction and other gameplay prompts remain unchanged.

- **Trail Ride visual fidelity upgrade.** Keep the existing first-person
  steering, terrain projection, face-tracking jumps, hazard collision,
  ditch timing and RPM-driven simulation, but replace the nearest-neighbor
  256×144 presentation with a 512×288 antialiased composition. Cache original
  four-times-resolution shaded art for conifers, broadleaf trees, hazard
  trunks, shrubs, flowers, rocks and ditch flags. Add layered atmospheric
  sky, softer distant mountain/forest silhouettes, subtle path texture,
  scenery shadows and a new shaded cockpit with curved handlebars, grips,
  levers and bike computer. Use Android Canvas without external assets,
  dependencies or GLES requirements, and retain the existing readable
  warning and timing indicators.

### Fixed

- **TRAILS edge flashing.** Remove the orange warning blink on the left or
  right path edge when riding near the boundary. Both edges retain their
  ordinary terrain-blended colors. Off-trail detection, speed reduction,
  steering, and collision handling are unchanged.

- **Android 5.1 YouTube video-surface rendering.** Route video through a
  `TextureView` on Android versions below 7.0 instead of relying on a separately
  composited `SurfaceView` that can appear clipped during direct playback or
  preview restoration. Keep `SurfaceView` on newer Android and preserve the
  same player instance across floating-preview transitions. Physical-console
  validation remains a release gate.

- **Trail Ride horizontal steering sway.** Widen the horizontal face-tracking
  neutral dead zone from 1.2% to 3% of the camera frame, apply a modest
  180 ms time-based smoothing filter only to camera X, and reduce all four
  user-selectable head steering gains by roughly 40%. Existing saved
  sensitivity selections remain valid; the default Medium preset is
  gentler without requiring a settings reset. Timestamped smoothing avoids
  dependence on render FPS and resets cleanly after tracking loss or manual
  recentering. Camera Y and stand-to-jump recognition remain untouched, as
  do RPM, speed, obstacles, and other games.

- **Trail Ride crash recovery and cockpit.** Halve obstacle/ditch crash
  recovery from 1.2 to 0.6 seconds without altering post-crash
  invulnerability. Remove the visible hands from the first-person bike
  handlebars while keeping the shaded grips, brake levers and bike computer.

- **Trail Ride jump recognition and visibility.** The native face tracker now
  reports actual loss of the tracked face immediately to Trail Ride, instead
  of holding an outdated face position until the camera cache expires.
  Other face-controlled games retain their existing smoothing behavior.
  The first-person airborne lift is stronger, including on ordinary hops,
  with an explicit HOP! banner. Add a developer-only jump animation test
  that bypasses camera gesture recognition, plus tracked face Y diagnostics
  and end-to-end face-detection loss tests.

- **Trail Ride continuous off-trail riding.** Leaving the path no longer
  triggers a crash animation, freezes game progression, or increments crash
  counts. Instead, the current RPM-based target speed is gently reduced by
  6% while off the trail and recovers naturally after returning. Off-trail
  excursion statistics still count once per sustained departure.
- **Trail Ride standing jump reliability.** Recognize a simple upward
  displacement of the tracked face followed by face disappearance, including
  normal camera tracking-loss latency. Remove the prior strict final-sample
  movement, sample-gap and extended rearming requirements. Repeated camera
  samples, downward reversal, stale loss and missing bike telemetry still
  cannot create a jump; ordinary face loss never pauses the ride.

- **Ghoul Run mouth animation pacing.** Slow close-range jaw opening
  from 0.28 to 0.65 seconds and closing from 0.24 to 0.40 seconds,
  making the toothless aperture grow visibly over more frames.
  Preserve the 0.95-cell activation distance, 0.45-cell full-open
  target distance, mutual-facing and line-of-sight checks, creature
  speed, and catch distance. Add timing tests for varying simulation
  frame sizes.

- **Ghoul Run progressively growing mouth.** Replace the faint, opacity-driven
  mouth appearance with a small dark circular opening that smoothly expands
  into the full jaw shape. Scale the aperture itself rather than fading in
  its darkness, and use linear distance progression within the existing
  0.95-to-0.45-cell attack window. Keep the toothless cavity, red eyes,
  independent Ghoul states, and both GLES2 and Canvas renderer paths.

- **Ghoul Run attack-mouth timing and appearance.** Start the head-on hunting
  jaw animation only inside 0.95 maze cells and reach full openness at
  0.45 cells, just before the 0.35-cell catch threshold. Remove teeth
  from both GLES2 and the Canvas fallback, preserving the dark mouth
  cavity, gum rim, and independent red-eye glow. Cover new distance
  thresholds and blocked line of sight in regression tests.

- **Ghoul Run overlay resize ceiling.** Let the translucent map grow to the
  full width and height of the first-person playable viewport, including the
  area behind the bottom RPM meter. The top/right inset shrinks smoothly as
  each axis approaches full size; the existing minimum map dimensions,
  HUD layering and saved preferences are unchanged. The resize handle
  snaps to the viewport edge when dragged within 24dp, ensuring the complete
  overlay is reachable on a touch display. Remove redundant controller
  "left/right to choose" prompts and the map's north indicator without
  affecting steering, turn choices, or map orientation.

- **Ghoul Run red eyes in darkness.** Restore two emissive red eye glows
  that remain visible when pedaling stops, independently of lamp lighting
  and industrial distance fog. Make the background and fog return to black
  at zero lamp radius, keep stunned creatures from glowing red, and preserve
  depth-tested wall occlusion. The CPU renderer now shows the same two-eye
  cue when OpenGL falls back, without allocating objects every frame.

- **Ghoul Run industrial fog and smoke visibility.** Bring the cool-gray distance
  fog closer to the rider and lift its contrast in both GLES2 and CPU fallback
  views. On the GLES2 path, add deterministic vents, grates, and low-mist smoke
  emitters with a small procedural alpha texture, gentle drift and rise,
  wall-depth occlusion, and a strict eight-billboard-per-frame draw cap.
  Smoke uses the existing GL surface and pauses with the game. Renderer
  diagnostics expose smoke draw counts for on-console verification.

- **Ghoul Run unexpected controller turns.** Controller button and stick turns
  now arm only the immediate choice junction and expire after 2.5 seconds.
  Rapid double inputs can still queue the following junction when choices
  are directly adjacent. Neutral or expired commands cannot retain an old
  precommitted turn; controller presses during warm-up or GO are ignored.
  Continuous webcam lean and automatic single-path corners are unchanged.

- **Ghoul Run controller startup.** Controller-only steering now skips the
  left/right/center lean verification after the normal cadence warm-up and
  proceeds through the existing one-second GO countdown. Webcam and Both modes
  retain directional verification; switching back from Controller before GO
  restores it. Later mazes continue to avoid repeating the first-run check.

- **Arcade game lifecycle on tab switches.** Leaving a game for Dashboard, YouTube,
  or another game now ends the outgoing session and hides every inactive game
  view. Ghoul Run's GPU surface respects ancestor visibility and releases its
  EGL context while paused, avoiding ghost frames over YouTube and conserving
  GPU memory. Temporary Android activity pauses still suspend rather than
  restart games; YouTube's floating player and the Bike Bridge remain unchanged.

- **Bike console Settings brightness.** The gear-icon Settings activity now applies
  the dashboard's persisted window brightness before its first frame and again on
  resume, so switching screens no longer falls back to a dimmer system level.

- **Ghoul Run successive steering inputs.** Webcam lean remains active across consecutive optional turns without forcing a full recenter; rapid controller button presses queue separate turns, while analog stick re-entries register distinct gestures. Precommitted junction directions can be corrected until arrival, and D-pad key/hat events share one press edge so a physical press cannot be double-counted.

- **Bricks controller steering regression.** Controller mode now strictly
  excludes face-tracking input from paddle steering; it reports unavailable
  controller input instead of silently falling back to the webcam.
  Automatic exclusive USB HID claiming waits until left/right raw mappings
  are calibrated to the active controller and report endpoints. Uncalibrated
  controllers continue to steer through Android's intercepted gamepad
  events instead of losing all input when their kernel driver is detached.

### Added

- **YouTube preview publication ages.** Append an optional relative age to
  the channel and view-count metadata in video cards. Use NewPipe's existing
  upload dates or the Google subscription feed's video publication date,
  rather than the date a video was added to a playlist. Hide unknown,
  future-dated or live-stream ages. No additional YouTube API requests.

- **Self-contained YouTube voice search.** Keep separate microphone and clear
  touch controls but replace the external recognition activity with bundled,
  offline English transcription using Vosk. The build downloads and verifies
  the pinned English model, then packages it inside the Full Bike Bridge APK.
  Listening status stays inside the YouTube search screen, and a red circular
  indicator replaces the mic only while audio is actually being captured.
  Recognition runs
  only when requested in a dedicated process, which exits after completion or
  cancellation; active video playback, game modes and bike telemetry do not
  share its native memory. No extra app, Google service or user setup is needed.
  Physical-console microphone, latency, memory and accuracy tests are required
  before a signed public release.

- **YouTube channel video browsing.** The player header shows the current
  channel avatar beside the quality selector when a verified channel URL is
  available. Tapping it opens the channel's actual Videos tab with pagination,
  and BACK restores the previous list without requiring additional Google
  API quota.

- **Trail Ride walking tortoise hazards.** Replace occasional green turtle
  shells with original shaded tortoises, complete with heads, eyes, feet and
  two walking animation poses. Each tortoise crosses the path from left to
  right or right to left, in a seed-stable direction. Renderer and obstacle
  physics share the same continuously changing lateral position, tied to
  forward travel to avoid timing drift or motion during pauses. Existing
  hazard spacing and ditch-clearance zones remain unchanged; steer around
  or jump over the animal, while trees and rocks remain impassable.

- **Trail Ride stand-to-jump.** Replace pedal-surge jump activation with a
  distinct upward face movement followed by tracking loss, allowing riders
  to initiate jumps by standing on the pedals. A 650 ms movement window,
  minimum rise and final upward step, camera freshness, and a rearm
  requirement after face reacquisition help prevent false positives.
  **Face tracking loss never pauses the ride**, whether or not a jump
  triggers: steering retains its last valid direction and fresh bike RPM
  continues to control forward speed. Only stopped or stale/missing bike
  telemetry pauses progress. Preserve ditch takeoff windows, airtime
  scaling, collision rules and timing, with prompts that now say when to
  stand. Remove the jump-specific surge threshold setting and replace
  the old surge gauge with a straightforward RPM meter. Include tests
  for standing, ordinary face loss, rearming, camera failures, pedaling
  holds and timing at ditch approaches.

- **Flak Run webcam/controller selector.** Add an in-game two-way
  WEBCAM/CONTROLLER selector immediately before the score with no combined
  mode. Controller becomes the default when a recognized gamepad is connected
  unless Webcam has been selected explicitly. Retain each rider's selection
  and fall back safely to webcam when a controller disconnects.
  Support analog-stick or per-game remappable D-pad steering for both jet
  axes with deadzone, frame-time caps and neutral-position hold. Controller
  flight no longer requires camera tracking or face calibration; live bike
  telemetry and pedaling safeguards still apply. Leave cadence-based dash,
  enemy behavior, score and collision physics unchanged.

- **Flak Run visual fidelity refresh.** Keep the same 256×144 gameplay
  coordinates and all existing jet, missile, shell, bomber, turret and bomb
  mechanics, but draw the scene into a cached 512×288 antialiased framebuffer.
  Replace hardcoded character-grid pixel sprites with original, code-generated
  shaded aircraft and emplacement art, add atmospheric desert sky, layered
  parallax ridges and subdued terrain detail, and render continuous exhaust,
  shell glow, smoke trails and soft explosions. Filter the final bitmap and
  round existing life/dash HUD elements for a more natural presentation.
  Use no downloaded image assets or new dependencies; include renderer
  geometry and effect-decay regression tests.

- **Ghoul Run immediate start and background pace calibration.** Replace
  the compulsory 25-second pedaling baseline warm-up with a three-second
  start countdown. Seed a conservative 70 RPM baseline on a first run,
  learn a stable median unobtrusively from live pedaling, and transition
  toward the learned value at a bounded rate to avoid sudden difficulty
  changes. Save validated baseline RPM with a 30-day expiry for reuse
  on subsequent launches. The manual Relearn Pace action resets the
  saved baseline and samples again without interrupting gameplay.
  Controller-only starts skip webcam directional verification; the
  webcam check and all missing-telemetry safety holds remain. Subsequent
  levels use their existing countdown rather than repeating the initial
  start countdown.

- **Ghoul Run close-range attack expression.** A hunting Ghoul opens its
  mouth progressively only when the rider looks toward it, the creature
  faces the rider, their path is unobstructed, and they are within close
  encounter range. The mouth closes smoothly when any condition breaks.
  Each Ghoul owns its own animation pose for multi-enemy levels, while
  wandering, inspecting, stunned and retreating creatures never initiate
  the attack expression. GLES2 deforms the lower face and draws a dark
  mouth cavity and gum rim over the existing character texture.
  The software fallback draws a matching animated facial expression
  without asset downloads, new GL extensions or per-frame bitmap
  allocations. The red-eye emissive effect remains independent.

- **Ghoul Run escalating levels.** Each successful maze escape increases the
  level and adds one independently wandering Ghoul; Level 1 keeps its original
  single-creature behavior. Spawn locations are deterministic and dispersed
  across the maze. Each creature retains its own pursuit, search, inspection,
  retreat, stun, and collision state. Shrines affect only creatures in range,
  and the existing invulnerability period prevents stacked catches.
  GLES2 and software renderers display multiple Ghoul sprites and glowing
  eyes, and the map and RPM gauge report the active threats. Results,
  countdowns, and navigation now identify the level and Ghoul count.
  Manual restarts begin again at Level 1.

- **Ghoul Run split/overlay map layouts.** Keep the existing side-by-side
  first-person and isometric map view, or switch to a full-width first-person
  scene with a translucent upper-right navigation map. The overlay begins at
  38% of screen width and has a draggable lower-left resize handle with
  minimum 36% width and 48% of the playable height. Resize is bounded to
  leave HUD space, and holds map tile scale steady until the drag ends to
  avoid rebuilding cached tiles on every touch move. The mode, overlay size,
  and adjustable 20–80% opacity persist across sessions. Important map
  entities, objectives, and threat indicators remain legible and fog of war
  is unchanged. Both GLES2 and software fallback use the same layout.

- **Ghoul Run industrial horror atmosphere.** Replace warm brick corridors
  with cold riveted steel panels, vents, reinforcing ribs and weathered floor
  surfaces. Four lightweight procedural variants per wall, floor and ceiling
  section are selected deterministically from the maze seed. The existing
  OpenGL ES 2.0 renderer retains its three maze draw calls and uses cool
  distance/low-lying fog; ghoul and objective sprites fade into that haze.
  The CPU fallback replaces brick bands with steel seams and matching fog,
  while the isometric map adopts a colder steel palette. No new binary art
  assets or heavyweight effects are required.

- **Ghoul Run quiet near-miss encounters.** After the rider settles into a stop,
  an unalerted ghoul can approach to just outside contact distance, pause for a
  tense inspection, then turn away and search elsewhere. Resuming pedaling
  immediately restores detection and pursuit. Stopping too late, an active
  close-range hunt, or an existing collision still costs a heart; the HUD
  marks the inspection with DON'T MOVE.

- **Native bike Analytics.** Settings now includes a lightweight Monday-to-Sunday
  cycling chart with separate axes for spinning minutes and average RPM,
  previous/next week navigation, lifetime spinning time, estimated pedal
  revolutions, average moving RPM, active days, and first tracked date.
  Valid fresh RPM samples accumulate in the native USB service even during
  games and video playback. Daily aggregates persist in a small transactional
  SQLite table with batched background writes and no raw telemetry logs.

- **Ghoul Run heading-following 3D isometric map.** The map's viewpoint now
  follows the eased first-person heading through corners and U-turns, keeping
  travel in the upper-right isometric direction while preserving upright wall
  geometry. It retains an incrementally cached, fog-of-war map at each settled
  cardinal heading, and uses depth-sorted projected walls while rotating.
  The rider indicator faces forward and a north arrow preserves world bearings.

- **Ghoul Run controller U-turn.** D-pad Down reverses direction with one press in
  Controller or Both mode. The new Reverse direction action can be remapped
  per controller without changing Biketris's Down/Soft drop behavior. Android
  controllers that report the D-pad as a hat axis also trigger the action.

- **GHOUL RUN arcade mode (playable prototype).** A seeded 11×11 maze ride,
  shown as a split screen: a GPU-rendered first-person view on the left
  (the steering view, native-resolution OpenGL ES 2.0 geometry with procedural
  floor, ceiling and brick textures, per-pixel dynamo and objective lighting,
  depth-tested billboards, a 70° field of view, and an automatic software-raycaster
  fallback if GL setup fails; walls fade to black at the dynamo lamp's radius so harder
  pedaling visibly lights further; the Ghoul is a gaunt red figure with a
  swaying halo of thorny branches and glowing eyes, grey while stunned) and the fixed isometric map on the right
  with fog of war, a rider view cone and a faint noise-radius tint. Leaning
  selects the rider's own left/center/right (enter a side at 35% steer, return
  below 20%); turn slots and an always-visible lean bar show the choice, and a
  white compass gives the exit bearing and distance. The game never picks a
  turn for the rider: with no lean it goes straight, and where straight is
  blocked it stops at the junction until the rider leans left or right (a
  lean already held from the previous turn counts there straight away)
  (corners and dead ends still follow the corridor). There are no guide arrows. A bike-computer gauge
  shows live RPM, a filtered-RPM needle, and two markers derived from the
  tuning config: "IT HEARS YOU" (the RPM whose noise radius reaches the Ghoul's
  current path gap) and "YOU OUTRUN IT" (the RPM matching the Ghoul's hunt
  speed). Catches flash red, show CAUGHT! with hearts left, pop the lost heart
  and shake the camera; running out of hearts fades to black before returning
  to the checkpoint. A red vignette warns when the Ghoul is within three tiles.
  The 25-second pace warm-up keeps the rider still while teaching cards
  rotate, then a lean check (left, right, center, GO) runs before the Ghoul
  wakes; it runs once per session, and later mazes start straight after the
  new-maze countdown. Absolute filtered cadence controls speed and light/noise without
  re-baselining; the Ghoul wanders, hunts by maze-path sound or line of
  sight, searches last-known positions, and can be escaped by sprinting.
  Knockback, stun, invulnerability, ride-through shrines, controller support,
  read-only bike telemetry and deterministic playability simulations are
  unchanged from the grey-box pass. Playtest fixes: a firm lean no longer
  U-turns the rider (the hard-lean reverse is removed; dead ends still turn
  around automatically), steering is rider-relative instead of
  screen-relative, a turn taken at a junction uses up the lean or button
  press (re-center to arm the next one, so a held lean no longer chains
  turns; buttons arm, cancel or switch the next turn), and riding pace is halved (creep/cruise/sprint 0.5/1.25/2
  cells per second; Ghoul speeds follow as ratios of cruise).

- **Biketris difficulty and cadence toggle.** Initial falling speed is now
  420 ms per row rather than 720 ms, leaving less idle time between pieces.
  The old Pedal to Slow / Pedal to Speed Up selector is replaced by a single
  **Pedal to Slow Mode** toggle, green when enabled and neutral when disabled.
  Enabled preserves the existing RPM-dependent slowdown reward; disabled
  uses normal gravity independent of RPM. The choice persists, with existing
  Slow users kept enabled and old Speed users migrated to disabled.
  Level progression, webcam/controller inputs, soft drop, and read-only bike
  telemetry remain unchanged.


- **Biketris controller mode and remapping.** Matching Webcam/Controller
  selector in the game panel, with a saved Biketris-only preference and
  automatic Controller default when an eligible gamepad is connected.
  Webcam retains head steering and wave rotation; Controller can move
  left/right, soft-drop pieces by holding Down, and rotate clockwise
  once per button press. All four gamepad buttons are remappable under
  Settings → Controllers and saved independently for each controller.
  Real bike cadence and its gravity effect remain read-only and untouched.


- **Hands-free Bricks restart.** After the last life or a cleared board,
  Bricks displays the final score with a 3-2-1 countdown and automatically
  starts a new round without touchscreen interaction. The Bricks controller
  mapping now offers only left and right steering; the manual Restart game
  binding has been removed.
- **Automatic connected-gamepad USB HID ownership.** Removed the manual
  Claim input, Release, and Choose USB HID controls. Foreground FitBaus
  attempts to claim every safe HID interface of a recognized gamepad,
  requesting Android's USB Host permission only when needed and not
  aggressively retrying a denial. USB interfaces release on pause,
  disconnect, or exit. Mixed-class equipment including bike control and
  external webcams is never claimed, and the normal Android event route
  remains a fallback if exclusive claiming is unavailable.


- **Bricks input source selector.** Matching webcam/controller buttons now
  appear immediately to the left of the existing 1×/2×/3× speed buttons.
  A connected and selected controller is the default unless the player has
  explicitly saved Webcam. Switching is immediate and persists across
  sessions; a disconnected controller falls back to webcam and restores the
  saved controller choice on reconnect. The camera session stays active,
  touchscreen input still overrides steering temporarily, and other games
  keep their existing input behavior.


- **USB controller settings and Bricks steering on the Bike Bridge.**
  A new Controllers tab beside Pairing and External Webcams lists Android
  input devices, distinguishes D-pad/gamepad/joystick from pointer-only
  devices, and shows live key/stick diagnostics. Single-controller auto-select
  and an explicit persistent selection/disable option let D-pad left/right or
  joystick X steer the Bricks paddle. Existing touch takes priority during a
  gesture; controller input stops on game exit, host pause and disconnect.
  Other games' camera and pedaling requirements are unchanged; no raw USB
  access, bike-command changes or Android system pairing is required.

- **Related-video discovery on the Bike Bridge YouTube screen.** Signed-in
  users can open DISCOVER alongside FROM YOUR CHANNELS to see suggestions
  obtained from a bounded sample of their subscription uploads. The existing
  NewPipe extractor supplies related items; results are mixed across seed
  channels, deduplicated and requested only on demand. No extra Google OAuth
  permissions, watch-history access or YouTube Data API search calls are used.
  Discovery has its own cancellable worker, error/retry state and no
  automated crawl during playback.
- **Scan-to-authorize Google device sign-in.** MY YOUTUBE now shows an
  offline-generated QR code alongside the Google verification URL and a
  large, case-sensitive device code. Scan from a phone to open Google's
  approval page; the user can still enter the code manually. When Google
  supplies an optional complete verification URI, use it without modifying
  it to support direct code handoff. No third-party QR service, additional
  OAuth scope or device-code query parameter is introduced.
- **Local Google OAuth JSON import for Bike Bridge.** A root-level
  `push_youtube_auth.bat` detects a Google TV client JSON file in a
  Git-ignored `secrets/youtube/` directory, transfers it over ADB, and
  triggers encrypted credential storage and the existing Google device-code
  flow. Temporary files are cleaned up without exposing the secret in shell
  arguments, APKs, logs or Bridge APIs.
- **Google account connection and account-first discovery for Bike Bridge
  YouTube.** Authorize a Google account from a phone using Google's
  limited-input device OAuth flow. Browse your subscriptions, recent channel
  uploads, and personal playlists with pagination, and open videos in the
  existing native player. When connected, the default home grid combines
  recent uploads from subscribed channels; MY YOUTUBE provides separate
  subscriptions and playlists. Global Search remains available. Credentials
  and refresh tokens are protected by Android
  Keystore; sign-out clears local authorization and requests revocation.
  Google's personalized Home recommendations are not available through the
  official YouTube Data API.
- **YouTube captions on the Bike Bridge.** Available subtitles appear over
  the video with a CC toggle. The player prefers English and human-authored
  captions when available and supports WebVTT, TTML, and SRT. Caption loading
  is bounded and failures are nonfatal to video playback.

### Changed

- **Clearer YouTube CC toggle.** The full-player button always reads CC;
  it uses a green outline when captions are active, a muted gray style when
  turned off, and a disabled gray state when captions are unavailable.
  The button also announces on/off/unavailable state for accessibility.
- **More compact floating YouTube player.** Removed the separate top bar
  from the mini-player. Video now occupies the full 16:9 preview; its close
  button sits directly over the upper-right corner, with a 48 dp touch
  target and dark background for legibility. Floating captions now use a
  smaller 12 sp font, tighter padding and an eight-line limit so more text
  fits in the preview, while the normal player's caption styling is unchanged.
  Tapping the video still restores the full YouTube player.

- **On-demand Google TV code renewal.** Once a TV OAuth JSON client has
  been imported, returning to MY YOUTUBE automatically requests a device
  code if no account is connected. Codes remain valid only for Google's
  returned `expires_in` lifetime, not a hardcoded day or a permanent
  QR. Existing unexpired codes are reused; expired codes and QR images are
  hidden promptly. GET NEW CODE renews on user request without reimporting
  credentials. No code generation on app startup, periodic regeneration,
  Google scope changes, or Keystore rotation.
- **Simplified YouTube navigation.** The YouTube tab always opens the default
  thumbnail feed, showing subscribed-channel uploads for signed-in users and
  Trending for guests. Removed the redundant SEARCH and MY FEED buttons;
  searching uses the keyboard Search action and clearing search restores home.
  MY YOUTUBE replaces its title and BROWSE button with a top-left arrow to
  return home, while preserving the in-list BACK control for channel and
  playlist navigation.
- **Subscribed-channel YouTube home feed.** When signed in, the console's
  thumbnail home grid merges recent uploads from subscribed channels instead
  of showing unrelated Trending videos. Channels are fetched in bounded
  batches, sorted by upload time within each batch, and extended as the user
  scrolls. Explicit Search remains global; MY YOUTUBE retains the separate
  subscriptions and playlists browser. When signed out, Trending remains
  the default. This is a composite subscription feed, not Google's private
  personalized Home algorithm.
- **YouTube play/pause feedback.** Tapping a video or its playback control
  briefly shows a centered play or pause icon.
- **YouTube search clear.** An × inside the search field clears entered text
  and returns to the default video feed without submitting a search.

### Fixed

- **Opt-in exclusive USB HID experiment for bike gamepads.** The Controllers
  settings tab can request USB Host permission, claim a single safe HID
  interface with kernel-driver detachment if supported, display raw interrupt
  reports, and learn Bricks left/right buttons. Approved sessions reopen only
  during games and release on exit/pause; ambiguous/composite, bike and webcam
  devices are excluded. Android Home capture remains unverified until physical
  console testing, and released interfaces may require USB reconnection.

- **Controller Back/menu keys leaving FitBaus during games.** In active games,
  recognized buttons delivered from the selected controller are consumed by
  FitBaus before Android's default Activity navigation handler. This includes
  D-pad, face/shoulder buttons, Start/Select, Back, Escape and Menu; existing
  Bricks steering remains the only mapped gameplay action. Dashboard,
  YouTube, settings, other input devices and system-owned Home handling
  are unchanged. No system-wide key interception or kiosk privileges.


- **YouTube tab continuity on the bike console.** Switching to Dashboard
  or a game while a video is playing now keeps playback in a small in-app
  floating player at the upper right. Tapping the video or its header
  restores the original full player, preserving playback position and
  controls. The X closes and releases it. Leaving the Activity still
  stops playback; no system PiP APIs or second player are used.

- **Android 5.1 Google OAuth credential round-trip.** Select the legacy
  AndroidOpenSSL RSA provider on API 22 and earlier for Keystore-backed
  AES-key wrapping/unwrapping, verify encrypted credentials can be reloaded
  before displaying a Google device code, and use an explicit AES-GCM nonce.
  Preserve existing Keystore aliases and support old encrypted payloads.
  Fail safely with a specific crypto stage when verification fails, without
  clearing pairing or other Bridge settings.
- **Google device authorization diagnostics.** If the first OAuth token poll
  fails, the bike now distinguishes Google's HTTP status and known OAuth
  error (for example `invalid_client (HTTP 401)`) from malformed responses,
  local encrypted-credential failures, and network/TLS errors. Normal
  `authorization_pending` and `slow_down` responses still continue
  polling. No client credentials, device codes, tokens or untrusted Google
  error descriptions are displayed.

## [2.1.0] - 2026-11-16

Published on GitHub as **FitBaus Full 2.1.0**, with the native YouTube
player, BIKETRIS, and external USB webcam support on the bike console.

### Added

- **YouTube tab in the Bike Bridge.** Browse trending videos, search YouTube
  and play public videos inside the console app, with pause, seeking and
  resume from the last position. A maximum quality setting (240p, 360p or
  480p; 360p by default) is never exceeded. The player is released whenever
  you leave the tab or the app pauses, and the tab never starts the arcade
  camera or touches the Bike Bridge's equipment connection or resistance
  control.
- **YouTube player brightness and volume controls.** A brightness slider below
  the video adjusts the console screen through the Bike Bridge's existing
  brightness setting, and a vertical slider beside the video sets the music
  volume (loudest at the top).
- **BIKETRIS arcade game.** A falling-block puzzle steered by moving your head
  left and right; a deliberate sideways hand wave rotates the piece. Dragging
  across the board moves pieces when face tracking is unavailable.
- **Cadence-controlled BIKETRIS speed.** Choose on screen between PEDAL TO SLOW
  (the default; pedaling faster gives you more time) and PEDAL TO SPEED UP
  (pedaling faster makes pieces fall faster). Without live cadence, pieces
  fall at the standard speed.
- **External webcam support.** Arcade games can use an external USB (UVC)
  webcam, and a new External Webcams settings tab shows a live preview with
  zoom controls and remembers settings for each camera.
- **Bike Bridge header settings gear and version label.** The gear opens
  settings with one tap, and the installed version is shown beside the
  FITBAUS title. Also released in Lite 1.0.1.
- **Release workflow.** Signed Trainer and production Bike Bridge artifacts
  are built from an existing tag, verified, and published with SHA-256
  checksums. See the [release engineering guide](.github/release/RELEASE.md).

### Changed

- Arcade game tabs scroll horizontally, so the settings gear stays visible as
  tabs are added.
- `deploy-bike.bat` refuses to install a Bike Bridge build with a lower
  version code or a different signing certificate, and never uninstalls the
  console app, so pairing is preserved.

### Fixed

- The Bike Bridge HTTP server can bind its port again immediately after the
  service restarts. Also released in Lite 1.0.1.

## [1.0.1] - 2026-11-14

Published on GitHub as **FitBaus Lite 1.0.1** from `lite/1.x`, with a signed
Trainer Android APK, a signed Lite production Bike Bridge APK, the web/PWA
bundle, and SHA-256 checksums.

### Added

- **Bike Bridge settings gear.** A gear in the upper-right header opens the
  pairing and settings screen with one tap; long-pressing FITBAUS still works.
- **Bike Bridge version label.** The installed version (for example `v1.0.1`)
  is shown beside the FITBAUS title.

### Fixed

- The Bike Bridge HTTP server can bind its port again immediately after the
  service restarts, instead of failing while the previous socket is closing.

## [1.0.0] - 2026-11-12

First unified FitBaus version: the Trainer web/PWA, Capacitor Android and iOS
apps, Native Bike Bridge and the arcade games inside the Bridge all report
**1.0.0**. The `v1.0.0` tag exists, but its GitHub release was not published.
Platforms: the hosted PWA, Capacitor Android (minimum API 24), Capacitor iOS
(source and Xcode project), and the Native Bike Bridge for the ProForm Smart
Power 10.0 (Android 5.1.1). Historical `0.x` entries below are development
records and are not renumbered.

### Added

- A single authoritative product version in `version.js`, with Node and Gradle
  helpers that reject missing, malformed or out-of-range versions.
- A version-consistency check (`npm run check:version`) in CI, including the
  Bike Bridge's Gradle-resolved metadata.
- Shared web deploy packaging used by `build-deploy.bat` and the release
  artifact zip.
- A manual **Release artifacts** workflow that packages inspection artifacts
  with SHA-256 checksums without tagging or publishing.

### Changed

- **Unified versioning.** Android `versionName`, iOS `MARKETING_VERSION`, Bike
  Bridge `versionName` and the HTTP `bridgeVersion` all derive from
  `version.js`. Numeric codes use `major * 10000 + minor * 100 + patch`
  (`1.0.0` is `10000`).
- **PWA cache identity.** The service worker cache is named after the release
  (`fitbaus-trainer-1.0.0`). Saved workouts and athlete data are unchanged.
- Upgrades keep existing package and bundle IDs, so local workout history,
  profiles, pairing and equipment settings are preserved.

### Removed

- The retired Xamarin/C# Bike Bridge host, its build scaffolding and migration
  scripts. CI now validates the Native Bike Bridge with Gradle unit tests.

## [0.10.14] - 2026-11-10

### Changed

- **Automatic workout resistance is standard.** Removed the Settings → Equipment
  "Automatic resistance control" toggle and the "Leave automatic resistance off"
  instruction. An authorized, active, unpaused structured bike workout now sends
  its recommended resistance to the Native Bike Bridge without an opt-in. A legacy
  persisted `automaticControlEnabled: false` is ignored and dropped on the next
  save; URL, pairing code and console brightness are preserved. Session binding,
  Freestyle policy, pause, disarm, control availability and pairing still gate
  every command.
- **Equipment diagnostics** now show recommended, commanded, Bridge-accepted and
  physically observed resistance separately, plus session authorization, last
  command outcome and a status line (for example "Bridge accepted R3 - awaiting
  physical confirmation" or "Pairing required").
- **Native Bike Bridge cold-start unlock targeting.** Authentication now matches
  the working Legacy console: DeviceInfo(MAIN) still adopts and confirms
  PrimaryDevice (FitnessBike=7); SystemInfo and VersionInfo are collected on
  MAIN; VerifySecurity and resistance writes stay on the bike. The unlock hash
  uses MAIN part/model/library with the DeviceInfo serial, not a second identity
  read from device 7. MAIN SystemInfo/VersionInfo replies that come back
  addressed as FitnessBike=7 are parsed the same way DeviceInfo bootstrap
  already adopts device 7.
- **Production Native initialization authenticates when required.** After two
  independent Native-only cold boots on this Smart Power 10 (controller
  Unlocked, HTTP 200, fresh observed R3, operator-confirmed load), production
  identity uses the qualified AuthOnly sequence as normal startup. Staging
  `unlockQualification=off` remains WarmState for rollback. USB reconnect
  re-authenticates once per new USB session and does not inherit write
  readiness. Production Gradle rejects staging `auth`/`lockout` flags.

### Fixed

- A workout recommendation that arrived before the first successful Bridge status
  poll was never sent until the recommendation changed. It is now sent once when
  control becomes available.
- **Native Bike Bridge qualification evidence.** Production Gradle configuration
  rejects `unlockQualification=auth`/`lockout`. Qualification inspects the exact
  APK's dex identity (not a filename or `BuildConfig.java`), scopes
  authentication logs to the current cold-start session, and requires a
  resistance observation newer than the command. HTTP 200 plus a previously
  existing R3 reading is not a pass. Staging AuthOnly builds remain isolated
  from production.

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
  1–15. This version records protocol evidence only; the estimate itself was
  added in 0.10.12. See `VO2-TEST-PROTOCOL-V1.md`.

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

### Changed

- **Downregulation play control** - Play button available for all
  downregulation visualizations.

## [0.9.36] - 2026-02-17

> Formerly labeled `APP_VERSION` **0.9.2** after the post-0.9.34 reset.

### Changed

- **Downregulation viz polish** - Improvements across downregulation
  visualizations.

## [0.9.35] - 2026-02-14

> Formerly labeled `APP_VERSION` **0.9.1** after an accidental reset from
> **0.9.34**.

### Changed

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

### Changed

- **Faster starfield** - Increased downregulation starfield speed.
- **Downregulation SISU sync** - Downregulation sessions can sync with SISU.

## [0.9.20] - 2026-02-12

### Changed

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

### Changed

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

### Changed

- **BPM layout** - BPM and BPM range aligned with the heart.

## [0.0.4] - 2026-01-11

### Added

- **PWA support** - Installable progressive web app (initial pass).
- **Workout JSON export** - Export JSON at end of workout.
- **Logo + data JSON** - Branding logo and corrected workout JSON.

### Changed

- **Mobile aesthetics** - Mobile layout polish.

## [0.0.3] - 2026-01-09

### Added

- **BLE / ANT+ HR** - Rudimentary chest-strap heart-rate capability.

### Changed

- **Sizing consistency** - More consistent control and layout sizing.

## [0.0.2] - 2025-12-12

### Changed

- **4×4 grid + emojis** - Expanded workout grid presentation.

## [0.0.1] - 2025-12-11

### Added

- **Initial trainer** - First workout trainer UI with profile, workout data,
  workout logic, and basic controls.

[Unreleased]: https://github.com/markrai/fitbaus-trainer/commits/main/
[2.2.0]: https://github.com/markrai/fitbaus-trainer/compare/v2.1.0...v2.2.0
[1.0.1]: https://github.com/markrai/fitbaus-trainer/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/markrai/fitbaus-trainer/tree/v1.0.0
