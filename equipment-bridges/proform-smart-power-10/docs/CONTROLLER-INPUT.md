# External USB controllers (Android 5.1.1)

The ProForm x86 console can deliver USB controller input through Android's standard
`InputDevice`, `KeyEvent`, and `MotionEvent` APIs. The input-device route is
separate from the USB bike controller and the UVC external-camera stack.

## Settings

Open the gear icon, then **Controllers** beside **Pairing** and **External Webcams**.
The screen lists input devices recognized by Android, their input classes and
vendor/product IDs, and the selected controller. D-pad keys and joystick axes
appear in a live diagnostic field. FitBaus now consumes all controller-origin
key, joystick and pointer events delivered to its foreground activities,
including in Settings. The Controllers tab reports their keycodes without
forwarding them to Android's Activity handlers. Controller D-pad navigation
of Settings is intentionally disabled while FitBaus owns its events;
touchscreen Done and non-controller Back still exit settings.

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

## Per-game controller mappings

When Settings is opened from a game, the Controllers tab shows that game's
available gameplay actions and the saved button assignment for each action.
Tap an action and then press any Android-delivered key on the connected
controller to bind it. Assignments persist per game **and per physical
controller descriptor**, with Clear and Restore Defaults operations. Reusing
a button for another action unbinds its previous assignment in that game.
Entering Settings from Dashboard or YouTube provides no game-context extra,
so the entire per-game mapping section is hidden.

- Bricks: move left, move right, restart
- Biketris: move left, move right, restart
- Finger Math: restart
- Flak Run: restart
- Trail Ride: restart

**Head recentering, calibration, camera-tracking sensitivity and other webcam
controls are not controller gameplay actions.** They remain in the existing
tracking/developer settings. Button-based boosts, jumps or answers are not
currently implemented; the app does not spoof bicycle cadence or invent
actions that the game engine does not support. Existing face tracking,
physical pedaling and touch remain unchanged.

Bricks routes left/right button mappings through its controller steering
path, and Biketris uses its touch-steering fallback. The joystick X
remains supported for Bricks; per-axis remapping is not part of the current
keycode binding format. Mapping controls require Android to deliver the
button as a keycode. Raw HID report learning is a separate experimental
path described below.

## Foreground controller event capture

For a recognized external controller, FitBaus consumes **every delivered
keycode**, including A, Back, Home and vendor-specific keycodes, and
controller-origin joystick or pointer motion before forwarding to regular
Activity handlers. This applies throughout the foreground native app,
not only during gameplay. Ordinary touchscreen input remains available
for Settings and exiting the app. Keycodes that Android handles entirely
before Activity dispatch are not available to be intercepted this way.
The raw HID claim mode described below attempts to bypass that limitation.

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
