# External USB controllers (Android 5.1.1)

The ProForm x86 console can deliver USB controller input through Android's standard
`InputDevice`, `KeyEvent`, and `MotionEvent` APIs. The input-device route is
separate from the USB bike controller and the UVC external-camera stack.

## Settings

Open the gear icon, then **Controllers** beside **Pairing** and **External Webcams**.
The screen lists input devices recognized by Android, their input classes and
vendor/product IDs, and the selected controller. D-pad keys and joystick axes
appear in a live diagnostic field. Normal Android D-pad focus navigation remains
available in Settings.

The **Choose game controller** dialog supports:

- **Auto-select**, which activates a controller automatically only when exactly
  one suitable D-pad/gamepad/joystick is detected.
- **Disable**, which retains the normal camera/touch controls.
- Selecting a specific connected controller, saved using Android's persistent
  input-device descriptor. Disconnecting it clears its live button/axis state;
  reconnecting the same device restores that selection.

Mouse-only devices are listed to aid diagnosis, but are not treated as gamepad
controls. Android recognizing D-pad navigation is useful evidence of key events,
but does not prove the availability of analog axes or gamepad face buttons.

## Supported gameplay

**Bricks** currently accepts left/right D-pad keys and the joystick X or
D-pad HAT_X axis for paddle steering. A deadzone prevents analog drift, and
frame-time clamping prevents an excessive jump after a stall. An explicitly
selected controller takes priority over face tracking while Bricks is running;
touching the screen temporarily overrides it. All other games retain their
camera/cadence controls, and all bike command/USB control paths are unchanged.

While any arcade game is active, the selected controller's delivered
D-pad, face/shoulder, Start/Select, Back, Escape, Menu, and common generic
button events are consumed before Android's default activity key handling.
Only Bricks currently assigns a gameplay action (left/right steering); the
other buttons are reserved for later game-specific mappings. This prevents
a gamepad button mapped to Android Back from accidentally closing FitBaus,
provided Android actually delivers that event to the app. Press and release
events are both consumed. Unselected devices, physical Android navigation
keys, Dashboard, YouTube, and the Settings screen keep normal behavior.
Key-up, mode change, and host pause clear held steering to prevent phantom
motion.

**System-reserved controller buttons are different.** Android normally
handles Home, app switching and some vendor-specific system shortcuts
*before* app key dispatch. FitBaus cannot guarantee intercepting those from
an ordinary Activity. If a button produces no input event in the Controllers
diagnostics but opens Android Home or another app, capturing more keycodes
inside FitBaus will not fix it. Potential system-level solutions include a
properly provisioned device-owner lock-task/kiosk configuration or carefully
verified OS key-layout remapping on a rooted console. Neither is enabled by
this PR; those changes require a separate recovery and access plan.

No extra USB Host permission is requested for Android-input events, no direct
USB endpoints are opened, and no controller-specific vendor protocol is used.

## Acceptance on a physical bike

1. Confirm the controller appears in Controllers and its D-pad left/right
   produce readable DOWN/UP events.
2. Open Bricks; verify that holding left/right moves the paddle smoothly,
   releasing stops it, and changing tabs does not leave it moving.
3. If analog controls are exposed, verify joystick center is still and full
   stick travel moves the paddle in both directions.
4. Unplug during play, reconnect, and confirm old pressed states do not persist.
5. With each game selected, press the controller button that previously
   acted as Back; verify FitBaus remains foreground and the game does not close.
6. Confirm a touchscreen/system Back action, settings focus navigation,
   camera-based games, USB resistance control, and external webcam functionality
   still work.
7. Test multiple connected gamepads; auto-select should not guess between them.
8. If a controller's Home/shortcut button still leaves FitBaus, test its
   input code in Controllers diagnostics. Document it as system-reserved if
   the Activity receives no event; do not claim in-app capture.

Future game-specific action mappings (firing, jumps, gestures, pause/restart) and
multi-controller gameplay should follow real input-capability observations
from the console. The first phase intentionally does not replace exercise
cadence requirements or simulate pedal effort.
