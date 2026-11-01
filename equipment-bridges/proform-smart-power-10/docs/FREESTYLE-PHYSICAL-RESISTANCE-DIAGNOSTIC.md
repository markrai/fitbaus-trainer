# Freestyle physical resistance diagnostic (read-only)

Operator-owned checklist for the ProForm SMART Power 10.0 while Fitbaus Freestyle is active and Bike Bridge is connected. Do not issue LAN resistance POSTs during this procedure. Do not alter Wolf/ERU packages.

## Goal

Distinguish:

1. Hardware-observed resistance from `WhenMetricChanged`
2. Accepted LAN `POST /api/v1/resistance` commands (should remain zero during Freestyle)
3. Rider physical increase/decrease behavior
4. Whether resistance returns to zero without a Fitbaus command

## Preconditions

- Stock Wolf is stopped for the USB session used by Bike Bridge.
- Fitbaus Bike Bridge is connected and streaming telemetry.
- Fitbaus Trainer Freestyle Ride is started and bound as `manual_freestyle_ride`.
- Automatic workout control may be enabled or disabled; Freestyle must still post **zero** resistance commands.
- Capture logs before starting:

```text
adb logcat -c
adb logcat -s FITBAUS_BRIDGE:I *:S
```

## Sequence

1. Start Freestyle with the bridge connected.
2. Pedal at observed resistance zero.
3. Press the bike's physical increase control until observed resistance is a nonzero level.
4. Continue pedaling for at least 60 seconds without touching resistance controls.
5. Record whether observed resistance remains at that nonzero level or returns toward zero.
6. Press physical decrease, then increase again. Record each observed change.
7. Finish or discard the Freestyle ride only after notes are complete.

## Evidence to capture

- Fitbaus live observation HUD resistance timeline (fresh vs waiting-for-fresh).
- Bridge logcat telemetry lines around each physical press.
- Trainer/bridge count of accepted resistance POSTs for the session (expect **0**).
- Whether any resistance change appeared in telemetry **without** a corresponding POST.
- Whether any POST occurred **without** an explicit operator LAN command.

## Interpretation rules

- A telemetry resistance change without a POST is hardware/Shire-observed, not a Fitbaus command.
- A POST acceptance is not proof the bike reached that level; only `WhenMetricChanged` is observation.
- Do not treat a resistance telemetry edge as proven rider-key intent. Shire currently exposes Resistance / RPM / Watts metrics only; no separate physical-key event channel is wired in Fitbaus Bike Bridge.
- `StartKeyEnabled = false` / `IdleModeLockout` during Shire init is stock FitPro initialization, not a Fitbaus resistance write. Its effect on physical keys with Wolf stopped remains an open hardware question until this checklist is run.

## Pass / fail for Freestyle software

- Pass: zero resistance POSTs during the Freestyle session; observed resistance follows physical presses when the bike itself accepts them; no Fitbaus-authored return-to-prior or return-to-zero command.
- Hardware-open: if resistance returns to zero with zero POSTs, the reset is outside Fitbaus command authority and must not be papered over with an automatic hold algorithm.
