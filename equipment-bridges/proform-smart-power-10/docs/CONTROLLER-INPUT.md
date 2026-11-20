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

## Bricks steering source selector

The **Bricks** HUD now has two input buttons immediately left of **1×, 2×,
3×**, with the same green-selected/outlined-inactive styling: a webcam icon
and a controller icon.

- With no explicitly saved choice, a single selected/connected Android
  gamepad (or an active raw-HID session) makes **Controller** the default.
  Without an available controller, **Webcam** is selected and the controller
  icon is shown as unavailable.
- Tapping **Webcam** immediately switches Bricks steering to the normal
  hand/face-tracking path. Controller-origin events are still consumed before
  Android receives them, but Bricks no longer executes mapped controller game
  actions. Held steering input is cleared on the switch. The selection is
  saved in Bricks' preferences and overrides future automatic controller
  selection, including after an app restart or USB reconnect.
- Tapping **Controller** when available also saves the choice. Disconnecting
  a controller temporarily selects Webcam while retaining the saved
  Controller preference; reconnecting restores Controller automatically.
- The camera session remains available for an immediate return to
  Webcam mode, but **Controller mode never uses face-tracking samples to
  move the paddle**, including when raw USB HID data is unavailable.
  Touchscreen interaction retains its temporary priority. If controller
  input is actually unavailable, Bricks displays a controller-unavailable
  message instead of silently steering from the webcam.

This is **Bricks-only**. Biketris, Flak Run, Trail Ride and Finger Math retain
their previously implemented input behaviors, and the speed buttons work
independently of the new source choice.

## Biketris steering source selector

Biketris now displays the same webcam/controller icon pair as Bricks at
the top of the right-hand panel, using green-selected and outlined-inactive
states. The selection has its own persistent `biketris_input_source`
preference, independent of Bricks. With one chosen and connected gamepad,
Controller is selected by default until the player explicitly saves Webcam.
When the chosen controller disconnects, Biketris temporarily shows Webcam
but retains the saved Controller preference for reconnection.

- **Webcam** retains mirrored head steering and wave-to-rotate gestures.
- **Controller** steers through the configured gamepad mappings: holding
  Left/Right moves the active piece sideways at Biketris' normal repeat
  rate, Down increases the fall speed until released, and Rotate turns
  one step clockwise per physical button press. A joystick's horizontal
  and vertical axes work with the same directional behavior.
- Touch dragging remains an override. Controller mode does not require a
  visible face to start or continue playing, and does not act on head or
  wave movements. The camera remains available for switching back.
- Soft Drop multiplies the existing read-only gravity interval while
  respecting its safety minimum. It never simulates RPM, pedaling, or
  resistance changes; actual cadence still affects the game's speed.

The on-screen **Pedal to Slow Mode** button is independent of the
Webcam/Controller input selector. It replaces the former two-option
Pedal to Slow / Pedal to Speed Up mode choice. The toggle is **green when
on**, grey/neutral when off, and remembers its value. When on, sustained
pedaling at 40–100 RPM adjusts the gravity interval from ×0.75 to ×1.25
at the current level, slowing pieces as cadence increases. When off,
the interval uses the normal level-dependent gravity without any RPM
multiplier. The Level 1 baseline has been tightened from 720 ms to
420 ms per row, while later level progression is unchanged.
Previous Pedal to Slow users retain enabled; users who selected Pedal
to Speed Up migrate to disabled. No additional mode or pedaling mechanic
is introduced.

The on-screen Play Again action remains after game over. Controller
button assignments are stored per game and controller descriptor.
Controller capture via Android input events is independent of Bricks'
optional experimental raw-HID calibration.

## Per-game controller mappings

When Settings is opened from a game, the Controllers tab shows that game's
available gameplay actions and the saved button assignment for each action.
Tap an action and then press any Android-delivered key on the connected
controller to bind it. Assignments persist per game **and per physical
controller descriptor**, with Clear and Restore Defaults operations. Reusing
a button for another action unbinds its previous assignment in that game.
Entering Settings from Dashboard or YouTube provides no game-context extra,
so the entire per-game mapping section is hidden.

- Bricks: move left, move right
- Biketris: move left, move right, soft drop, rotate clockwise
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
path; Biketris uses native column movement, bounded soft drop, and
clockwise rotation without synthesizing touches. Analog axes are
supported as conventional directions, but per-axis remapping is not part
of the current keycode binding format. Mapping controls require Android to deliver the
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

## Automatic USB HID ownership

When a recognized USB gamepad is attached while FitBaus is in the foreground,
FitBaus attempts to claim it **automatically**. There are no manual
**Choose USB HID**, **Claim input**, or **Release** controls. The first
attachment may show Android's mandatory USB permission dialog; FitBaus
cannot grant USB Host permission without the user's approval. A denial
is not re-requested repeatedly for the same attachment.

Automatic raw USB claiming during Bricks gameplay is conditional on
**both left and right raw-HID bindings having been learned for that specific
controller and endpoint**. Without complete, trusted raw mappings, claiming
the USB driver would suppress Android key events without providing usable
steering. FitBaus therefore uses the Android gamepad key/axis path and
continues to consume every controller event delivered to its activities.
The raw diagnostic/learning route in Settings remains available to establish
those bindings. Automatic claiming still occurs once mappings are valid.

The controller is associated with a recognized Android gamepad and matched
against USB vendor/product IDs. Ambiguous matches fail closed rather than
claiming arbitrary equipment. The claim path checks every interface of a
pure-HID device and requests exclusive access to **all** of its interfaces,
including boot-interface HID reports, with kernel-driver detachment if the
Android kernel allows it. Devices with mixed USB interface classes,
non-HID cameras, the known bike controller VID 213C, and CP210x UART
controllers are excluded. HID endpoints must have bounded interrupt-IN
report sizes and each interface must be readable.

The Controllers screen retains live HID report diagnostics and **Learn LEFT**
/ **Learn RIGHT** for Bricks, without a separate ownership toggle. When
FitBaus leaves the foreground or the controller disconnects, the raw
reader cancels pending requests, releases the claimed interfaces and
closes the USB connection. A claim failure or uncalibrated raw layout leaves the ordinary Android
controller-event interception in place. Reconnecting a controller can be
necessary if a kernel fails to reattach its original HID driver after release.

**Automatic claiming does not imply universal report decoding.** HID
layouts vary by device. If the kernel detaches Android's input driver,
Android keycode mappings may temporarily stop working; Bricks raw LEFT/
RIGHT can be calibrated with the existing learn controls. Raw HID reports
from other interfaces or vendor-defined features may need additional
action mapping. FitBaus must not treat unrecognized raw bytes as game
commands or fake bike cadence/resistance. A Home-like hardware button
that Android handles before the claimed interface is available may
still be system-owned. Full button ownership must be verified on the
physical Android 5.1.1 console.

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
11. Verify normal foreground auto-claim, Settings handoff, backgrounding,
    and physical disconnect free the USB interface without manual Release.
    Reconnect USB if Android does not reattach the original HID driver.
12. If a controller's Home/shortcut button still leaves FitBaus despite a
    successful raw claim, document the result and stop claiming complete
    exclusivity: other interfaces or system-level control may be involved.

Bricks now restarts itself three seconds after either game over or
clearing the board, and its controller settings expose only left/right
movement. The camera input remains available for Bricks fallback.
Future raw-HID-to-game-action mappings should follow real report data
from the console; no game action may simulate physical pedaling.
