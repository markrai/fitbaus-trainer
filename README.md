<p align="center">
  <img src="github.png" alt="FitBaus Trainer" width="720" />
</p>

# FitBaus Trainer

**Smarter rides. Open-source software. Your fitness data, under your control.**

FitBaus Trainer is a heart-rate-guided fitness coach for people who want more from their workouts without being tied to a subscription or cloud platform. Train with structured sessions, see how your body responds, and track your cardiovascular progress. Use it in a browser, install the mobile app, or connect supported exercise equipment for a more hands-off ride. Also includes interactive games that use face and hand tracking to turn your movements into part of the action, making exercise more engaging and fun!

## What you can do

- **Train by heart rate.** Follow structured workouts with live intensity guidance instead of guessing how hard to push.
- **Measure your progress.** Record workout history and use a formal bike VO₂ assessment to estimate cardiovascular fitness.
- **Connect a chest strap.** Read Bluetooth heart rate through Web Bluetooth in supported browsers or native BLE on Android and iOS.
- **Let a supported bike adjust itself.** FitBaus can use measured power, cadence, and resistance to guide automatic resistance changes during authorized structured workouts.
- **Play while you pedal.** On supported console hardware, arcade games use face and hand tracking to bring movement into the game.

The core Trainer works without an equipment bridge. More advanced athlete-relative watt personalization is being evaluated, but does **not** currently control the bike.

## Self-host it

FitBaus is a static web application. You don't need to run an application server, database, or authentication service to use the core Trainer. It stores workout history, heart-rate samples, and athlete profile data on the device.

With **Node.js 22+** and npm:

```bash
git clone https://github.com/markrai/fitbaus-trainer.git
cd fitbaus-trainer
npm ci
npm run build
npm run serve
```

Open the local URL shown by the server. For access from another device, serve the web app over HTTPS using your preferred static web server. Web Bluetooth requires a compatible browser and secure context.

**A web-hosted Trainer is not the same as a bike controller:** the current ProForm bridge uses trusted-LAN HTTP, which the hosted browser app cannot access directly because of CORS restrictions. Use the native mobile app for the supported bridge integration.

## Bike integration

FitBaus can communicate with model-specific equipment bridges on a trusted local network. **Currently, the only supported bike is the ProForm Smart Power 10.0.** This is not a claim of general ProForm or iFIT compatibility.

Its native Kotlin bridge runs on the bike's Android console and provides:

- Live bike measurements: watts, cadence, and resistance
- Automatic resistance commands during authorized structured workouts
- Chest-strap heart-rate forwarding for display on the console
- Console brightness control
- Console-based arcade games

Pairing is required for protected commands. Once configured, an authorized structured workout automatically sends resistance guidance; there is no separate automatic-control toggle. The console does not connect to the chest strap itself.

See the [ProForm bridge setup and safety notes](equipment-bridges/proform-smart-power-10/README.md) or the [equipment bridge overview](equipment-bridges/README.md). Equipment-control endpoints must stay on a trusted LAN, not the public internet.

Interested in adding support for another bike? Contributions and hardware research are welcome.

## Your data stays yours

Workout history and athlete data live in local browser or app storage, not in a mandatory cloud account. Optional SISU synchronization is available; it excludes personalization and local research fields from uploads.

Browser and native app storage are separate, and local storage is not a backup. Export or preserve your data before clearing browser storage or uninstalling an app.

## Build and contribute

FitBaus includes a TypeScript PWA and Capacitor Android/iOS projects. The current product version is **1.0.0**. For development:

```bash
npm run build
npm run check
npm run check:version
npm test
```

Edit TypeScript in `src/`, then commit the matching generated `dist/` output. Do not hand-edit `dist/`. Treat persisted schemas and version identifiers as compatibility contracts.

Product versioning is centralized in `version.js`. See [VERSIONING.md](VERSIONING.md)
for how Android, iOS, Bike Bridge, and the PWA cache stay aligned. Maintainer release
signing, Lite versus Full tracks, and automated publication are documented in
[docs/RELEASE.md](docs/RELEASE.md). Physical-device qualification remains a separate
gate from CI packaging.

See [Native Development](docs/NATIVE-DEVELOPMENT.MD) for platform toolchains and device testing, and [Personalization Architecture](docs/personalization-architecture.md) for the distinction between live control and experimental research.

## License

FitBaus Trainer is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). The npm package is private and is not published to npm.
