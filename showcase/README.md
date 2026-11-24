# Temporary FitBaus showcase — DO NOT MERGE

This branch is a disposable capture build, not a product feature or release. It changes the application ID to `com.fitbaus.bikebridge.showcase`, rejects production signing, and removes the USB attach handler, boot receiver and bridge service from the manifest. Telemetry and camera input are synthetic. Never describe the resulting recording as a live fitness measurement.

## Build and configure

From `equipment-bridges/proform-smart-power-10/native`, run `gradlew.bat :bridge-app:assembleDebug` on Windows. Install the debug APK with ADB. Do not uninstall the normal Bike Bridge. Force-stop it before recording to reduce contention. The showcase has separate preferences; connect a non-private Audiobookshelf demo library and optional Transcriber through its normal UI. Prepare a public-domain audiobook transcript in advance. Select a video you have permission to record.

The Math preview uses a low-resolution shaded synthetic figure by default. For a real-looking result, supply a consistent consenting adult's 4:3 photos with both hands visible (first hand showing up to five fingers, second showing the remainder). Push `rest.jpg` and `0.jpg` through `10.jpg` to `/sdcard/Android/data/com.fitbaus.bikebridge.showcase/files/showcase-math/`. No personal photo belongs in Git. Preview is grayscale and 160×120. Answers are replayed into the real game state machine; this is not live computer vision validation.

## Capture

From the repository root, run `powershell -ExecutionPolicy Bypass -File showcase/record.ps1 -Bike YOUR_ADB_SERIAL -VideoTitle "EXACT VIDEO TITLE" -BookTitle "EXACT BOOK TITLE"`. The script starts one 180-second screen recording and triggers a 170-second timeline. Verify the output visually before publication. Media search uses the real providers; title matches must be exact (case-insensitive). The branch stages a near-complete Biketris row, a ghoul in the rider's forward corridor, and triggers Trails jumps in the real timing window. These are simulated inputs and staged game states, not evidence of live play. The initial pass has no physical-console qualification; verify that each event is visible and tune if necessary. The screenrecord output is silent.

Close this PR without merging, then delete the branch and uninstall only the showcase package.
