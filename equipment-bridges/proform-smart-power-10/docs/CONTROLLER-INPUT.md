# External USB controllers (Android 5.1.1)

The ProForm x86 console can deliver USB controller input through Android's standard
`InputDevice`, `KeyEvent`, and `MotionEvent` APIs. The input-device route is
separate from the USB bike controller and the UVC external-camera stack.

## Settings

Open the gear icon, then **Controllers** beside **Pairing** and **External Webcams**.
The screen lists input devices recognized by Android, their input classes and
vendor/product IDs, and the selected controller. D-pad keys and joystick axes
appear in a live diagnostic field. Normal Android D-pad focus navigation remains
available in Settings. In the Controllers diagnostic tab only, delivered
Back, Escape, Menu, app-switch, search and Mode button events from recognized
gamepads are shown **without** forwarding them to Android's Activity Back
handler. The touchscreen Done button and non-controller Back still exit settings.

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

The regular Android-input route requires no extra USB Host permission and
still works when exclusive HID mode is disabled.

## Optional exclusive USB HID mode (experimental)

This is an opt-in, device-specific alternative to Android key dispatch. In
**Settings → Controllers**, choose **Choose USB HID**, then **Claim input**.
The user explicitly approves Android's device-level USB Host permission if
needed. FitBaus calls `UsbDeviceConnection.claimInterface(interface, true)`
to request exclusive control of that HID interface, with kernel-driver
disconnection if Android supports it. It then reads the interrupt-IN reports
on a dedicated thread using `UsbRequest` and displays raw hex bytes and
packet numbers. It does **not** use `InputDevice` key events to decode the
raw reports.

The candidate policy is deliberately conservative:

- Only a single-interface, non-boot USB HID device with an interrupt-IN
  endpoint (at most 256 bytes) is eligible. Composite USB devices, UVC
  cameras, known bike-controller VID 213C and CP210x 10C4:EA60 are excluded.
- Identical VID/PID/interface identities are ambiguous; auto-selection
  refuses them rather than claim the wrong device.
- No USB HID interface is claimed during app installation/startup, and
  nothing is requested without a Settings user action.
- A successful claim is **not** proof that Android stopped receiving all
  buttons, or that every button is encoded in that interface. If Android
  still delivers a controller key while the raw interface is claimed,
  FitBaus displays a warning. Verify actual Home/Back behavior on the
  physical console.

For Bricks, keep all controls neutral until a raw report appears, then tap
**Learn LEFT** and hold left for about one second. Repeat for **Learn RIGHT**.
Learning succeeds only when one report byte changes consistently; the
decoder uses a changed-bit mask for digital buttons and full low-nibble
matching for neutral-centered HID hats. If your gamepad uses multi-byte or
vendor-specific reports, learning will refuse or may be insufficient.
Compare the on-screen `PRESSED` flags against the physical buttons before
relying on the mapping. Both the mappings and the explicit enable setting
are stored locally. Returning to a game attempts to reclaim the same
approved interface, with no new USB dialog if Android permission is still
valid; a failed or unavailable claim falls back to the normal Android
controller input path. If raw HID is active without learned mappings,
Bricks retains its camera/touch input rather than guessing the report
format.

**Release** stops reading, cancels the pending request, releases the HID
interface and closes the connection. Switching settings tabs, closing
Settings, leaving a game, pausing the app, or losing the device also
releases the session. The touchscreen remains available for recovery.
Some Android kernels may not automatically reattach the original HID
driver on release: unplug and reconnect the controller if Android D-pad
navigation does not return. Never experiment without touchscreen access.

Exclusive mode does not change system key policies or require root, HID
report writes, firmware modifications, kiosk mode, or bike USB control.
No claim of universal controller support is made until on-device USB
descriptor, raw report and system-dispatch checks pass.

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
8. In Controllers diagnostics, press the controller's formerly dangerous
   Back button. Its keycode should appear without closing the settings tab.
9. In exclusive mode, verify the intended USB HID interface is listed,
   permission is explicitly granted, raw reports actually arrive, and no
   system Back/Home action escapes during a representative button test.
10. Learn raw LEFT/RIGHT, observe both PRESSED flags separately, then verify
    Bricks steering and touch override.
11. Use Release, game exit, backgrounding and physical disconnect to verify
    the reader and interface are freed. Reconnect USB if Android does not
    reattach the original HID driver automatically.
12. If a controller's Home/shortcut button still leaves FitBaus despite a
    successful raw claim, document the result and stop claiming complete
    exclusivity: other interfaces or system-level control may be involved.

Future game-specific action mappings (firing, jumps, gestures, pause/restart) and
multi-controller gameplay should follow real input-capability observations
from the console. The first phase intentionally does not replace exercise
cadence requirements or simulate pedal effort.
