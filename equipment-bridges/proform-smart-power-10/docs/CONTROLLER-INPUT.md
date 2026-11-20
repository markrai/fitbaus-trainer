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

The controller's directional keys are intercepted only when Bricks is active,
not on the Dashboard, YouTube, or the settings screen. Key-up and mode change
clear held inputs to prevent phantom motion.

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
5. Confirm settings focus navigation, camera-based games, USB resistance control,
   and external webcam functionality still work.
6. Test multiple connected gamepads; auto-select should not guess between them.

Future game-specific action mappings (firing, jumps, gestures, pause/restart) and
multi-controller gameplay should follow real input-capability observations
from the console. The first phase intentionally does not replace exercise
cadence requirements or simulate pedal effort.
