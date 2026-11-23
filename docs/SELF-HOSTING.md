# Self-host FitBaus Trainer

FitBaus Trainer is a static web application. You do **not** need an application backend, database, hosted account or running Node.js process after the site is built. Serve its web assets over HTTPS from your existing web server or reverse proxy.

The optional **ProForm Smart Power 10.0** Bike Bridge, native Android/iOS apps and on-console games are separate from the self-hosted web trainer. Hosting the site does not turn an arbitrary exercise bike into a supported controller.

## Option 1: Use a published web bundle

Download the `fitbaus-trainer-web-X.Y.Z.zip` from a [published GitHub Release](https://github.com/markrai/fitbaus-trainer/releases) and extract it into an empty web-root directory. Use a *published* release, not an unreleased version number from `main`.

The archive contains the static app. Serve its extracted files at the **root of a dedicated origin**, such as `https://fitbaus.example.com/`. The service worker currently uses root-relative asset paths, so hosting under `https://example.com/fitbaus/` is not supported without code changes.

## Option 2: Build the latest source

Install Node.js 22 or later, then:

```bash
git clone https://github.com/markrai/fitbaus-trainer.git
cd fitbaus-trainer
npm ci
npm run build
node scripts/package-web-deploy.cjs
```

Serve the generated `deploy/` directory, not the entire source repository. It includes `index.html`, `dist/`, `sw.js`, the manifest, workout data and required assets. Do not publish `secrets/`, `.github/`, the source tree or development tooling through the web server.

## Example: Docker with an existing HTTPS reverse proxy

From the repository directory, after building the `deploy/` folder, create `compose.yaml`:

```yaml
services:
  fitbaus:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:80"
    volumes:
      - ./deploy:/usr/share/nginx/html:ro
```

Start the web server:

```bash
docker compose up -d
```

Point your existing reverse proxy at `http://127.0.0.1:8080` and enable HTTPS on its public hostname. If your proxy runs in another container, adapt the network routing rather than publishing the service directly to the internet without TLS.

This container only serves static files. There is no database or account service to provision.

## Data, browser and hardware limitations

- **Data lives on the client.** Workout history and athlete profile data reside in the browser's local storage/IndexedDB. Hosting the app does not provide sync between browsers or automatic backups. Export important data before clearing site data or moving devices.
- **Use HTTPS.** Web Bluetooth and installable-PWA capabilities need compatible browsers and a secure context. Local `localhost` can be used for development.
- **One origin, one cache namespace.** Deploy to the same site root when updating, and ensure `dist/version.js` and the deployed assets come from one consistent build. A new published version updates the service-worker cache identity.
- **Optional bike control is not available from arbitrary hosted browsers.** The ProForm bridge speaks trusted-LAN HTTP and is restricted by browser CORS policy; use the supported native integration instead. Never expose the bike's control HTTP API to the public internet.
- **Google/YouTube account setup and console games** belong to the native Bike Bridge and are not included in this static web deployment.

For console hardware installation, see the [supported ProForm bridge guide](../equipment-bridges/proform-smart-power-10/README.md). For app builds, see [native development](NATIVE-DEVELOPMENT.MD).
