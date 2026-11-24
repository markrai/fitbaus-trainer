# Audiobookshelf integration

FitBaus Full will provide a native Books screen for a user's self-hosted Audiobookshelf server. No web application embedding, additional playback engine, or transcription model on the console is required.

## Implementation slices

1. **Library API foundation (implemented).** HTTPS or private-network HTTP server URL, username/password authentication or an existing Audiobookshelf API key as a bearer credential, audiobook library enumeration, bounded paginated item metadata, and cover URL construction. The API layer is independent of Android UI and credential storage.
2. **Books screen (implemented).** Media tab, server setup, keystore-backed credential storage, connection validation, library selection, five-column cover grid, pagination and server-side title search. Authenticated covers are confined to the configured origin; stale requests and caches are discarded on tab exit or disconnect. Selecting a book opens the native player.
3. **Playback (implemented; console qualification pending).** Dedicated ExoPlayer audio player with direct-play sessions, multi-file book-relative timeline, server resume, chapter navigation, seek and 30-second skips, playback speed, audio focus, periodic progress sync and session close. Leaving Books or pausing the activity releases playback. Server transcoding, background playback across tabs and offline progress recovery are not included in this slice.
4. **Read Along (Phase 3A implemented; qualification pending).** Parse bounded WebVTT/SRT input, synchronize against the book-relative playback clock, and provide an optional large-print focus display with text size controls. The audio player remains the sole clock. Local transcript files are a qualification source, not a transcription engine.
5. **Optional transcription companion (Phase 3B onward).** A separate headless open-source repository, `fitbaus-transcriber`, will provide a containerized engine, authenticated and versioned API, job queue, persistent cache, CPU baseline and optional GPU acceleration. No web UI, cloud account, server modification or additional installation is required for ordinary audiobook listening. The companion must respect library permissions and cache by server, item and audio revision. FitBaus will implement the optional remote transcript source separately.

## Server connection

Use HTTPS with a certificate trusted by Android, or explicit HTTP to a private IPv4 address (10/8, 172.16/12, or 192.168/16) on a trusted network. Both support the server root and the `/audiobookshelf` reverse-proxy path. HTTP connections bypass system proxies. Public hosts require HTTPS. Do not send API keys in URL query strings, disable certificate verification, or follow redirects carrying credentials. Prefer a dedicated non-admin Audiobookshelf user with access only to the desired libraries.

The API uses the current Audiobookshelf server routes for library enumeration and minified paginated items. See [upstream source](https://github.com/advplyr/audiobookshelf) and the [API reference](https://api.audiobookshelf.org/) (the latter is no longer actively maintained).

## Connect the bike

1. Open **Books** on the console.
2. Select HTTP or HTTPS, enter the host or IP address (without a scheme or port), and optionally enter the port. Enable the Audiobookshelf subpath checkbox if the server is mounted there. For example: HTTP, `192.168.1.193`, port `13378`.
3. Choose **Username / password** (the default) and enter your Audiobookshelf credentials, or choose **API key** and enter an existing key. Select **Connect**.
4. Choose a library. Use Previous/Next to browse pages, Search for book-title matches, and Clear to return to the library. Search shows up to 20 direct book matches; author and series match navigation is not included in this slice.
5. To change accounts or servers, select **Disconnect**. This forgets the locally saved credentials without revoking the server-side session or key.

A verified connection is automatically restored when Books is reopened. Modern Audiobookshelf servers return access and refresh tokens; older servers can return a legacy bearer token. The client retries an unauthorized request once after refreshing and securely saves rotated credentials. The password is not persisted. The token credentials and server address are encrypted together using a random AES key wrapped by a dedicated Android Keystore RSA key. Credentials are never placed in a URL.

## Playback

Tap a book to start at its Audiobookshelf resume position. Use Play/Pause, the seek bar, 30-second skips, Chapters and playback speed. Return to Library to stop playback and close the server session. Progress is sent during playback and on exit; network failures are best-effort and offline recovery is not implemented. Audio requests are restricted to the selected book's file endpoints on the configured server and do not follow redirects.

## Read Along (local qualification)

Play an audiobook, then tap **Read Along**. This switches the presentation without creating a new audio session. Use the text-size button to cycle through 28, 36, 44 and 52 sp; play/pause and ±30-second skips remain available. **Player** restores the regular playback controls. Missing or invalid transcripts are isolated from audio playback.

For now, the local source looks for a UTF-8 transcript under the app-specific external files directory:

```text
read-along/<SHA-256 of saved server address>/<library item ID>.vtt
```

A file with the same base name and `.srt` extension is also supported. To test, open Read Along for a book without a transcript; the screen displays its expected absolute file path and creates the parent directory. Push a small test file there using ADB, then select **Reload**. A sample fixture:

```vtt
WEBVTT

00:00:00.000 --> 00:00:05.000
First test sentence.

00:00:05.000 --> 00:00:10.000
Second test sentence.

00:00:12.000 --> 00:00:20.000
Third test sentence, following a gap.
```

This is synthetic qualification text, not a transcription of the audiobook. Seek to the beginning for the test. No storage permissions or external document picker are required. The app-specific directory can be removed by uninstalling; it is not a production transcript cache.

### Transcript contract

- Timing is absolute within the complete audiobook, in milliseconds from its start, not wall-clock time or per-file offsets.
- Cues are ordered, non-overlapping, half-open intervals: start inclusive and end exclusive. Gaps are permitted.
- UTF-8, plain-text narration, WebVTT or SRT; VTT presentation settings and tags are not rendered. Limits: 4 MiB input, 30,000 cues, 1,200 characters per cue.
- Lookup is independent of the source and uses the actual book playback position, including after backward seeks and speed changes. The renderer does not extrapolate time.
- The optional source must return data only for the requested book. A future remote adapter will additionally verify audio revision and coverage before displaying text. This local fixture adapter does not verify audio revision.

## Qualification

- Unit tests for URL and credential validation, library and item parsing, pagination, HTTP errors, modern and legacy login responses, and bounded token renewal.
- Physical Android 5.1.1 x86 console: username/password and library/cover browsing over private HTTP confirmed. HTTPS, playback and progress synchronization still require console testing.
- Verify uninterrupted bike telemetry and USB control.
- For playback, verify single-file and multi-file books, interrupted networking, resume across devices, and correct progress accounting.
- For Read Along, verify large-text layout, exact cue boundaries and gaps, backward/forward seeks, chapters and playback speeds. Confirm that opening and closing Read Along does not restart the audiobook and that missing/malformed files never stop playback.


## Optional transcriber connection (Phase 3D.1)

The separate [FitBaus Transcriber](https://github.com/markrai/fitbaus-transcriber) service can be configured in native Settings → Transcriber. Select HTTPS or HTTP, enter the host and port (initial default 8765), and enter a one-time pairing code generated by `docker compose exec transcriber python -m transcriber pair` on the server. Connect exchanges the code for a separate device bearer and validates the authenticated v1 capability response before saving. A compatible service without a prepared model or configured source can be saved but is shown as not ready. Disconnect removes only the transcriber configuration. The token is masked and stored in a separate Android Keystore-wrapped encrypted record; it is not sent to Audiobookshelf. Changing the endpoint requires a fresh code rather than forwarding the saved token automatically. Codes are case-insensitive, expire after ten minutes, and are automatically hyphenated. Tap Connect with an empty code to retest the unchanged saved connection. Disconnect removes the local credential; the server operator can revoke all paired credentials.

HTTP uses the same private IPv4 restriction as Audiobookshelf; HTTPS uses normal certificate validation. For a local deployment, configure the companion's LAN binding and restrict access to the trusted LAN before connecting. This phase only establishes the connection; remote transcript requests, Audiobookshelf credential reuse, lookahead and synchronized rendering follow in Phase 3D.2/3D.3. Normal audio playback and local fixture Read Along remain unchanged.


## Remote Read Along (Phase 3D.2)

Pair the transcriber in Settings → Transcriber. Successful ready status is green. Open an audiobook, start playback and tap Read Along. A paired service receives the current Audiobookshelf access credential (not the password or refresh token) alongside its own device bearer. The paired service must be trusted and configured for the same audiobook library. If Audiobookshelf uses HTTPS, the transcriber must also use HTTPS to avoid downgrading credential transport. A missing pairing retains the previous local VTT/SRT fixture path.

The reader requests the aligned five-minute window containing the player's current position, polls the asynchronous job on a background worker, and renders cues using the actual book-relative player clock. It verifies the manifest against playback track IDs and timing, requires matching source/item/revision/coverage in job and transcript responses, accepts silent windows and discards superseded UI results. A change of audio revision requires reopening Read Along. Seeking to another window requests that window. Playback continues while the transcript is pending or unavailable; Reload retries a failed window. Closing Read Along stops client polling, not already admitted server inference.

Phase 3D.3 automatically requests one upcoming window as soon as the current window is ready and playback is requested. The reader keeps at most the previous, current and next windows in memory and switches by the actual playback clock. A seek to an uncached window takes priority over speculative work. Failed prefetch does not disturb current narration; it is retried when needed, and a failed foreground request waits for Reload. Slow or unavailable transcription may still leave a gap; audio is never paused to wait for text. No new server deployment or model is needed.


## Floating Books player

Switch to Dashboard or a game during an established audiobook session to keep listening in a compact in-app overlay. If Read Along was open, the overlay shows the same synchronized narration and uses the same transcript buffer and lookahead worker. Otherwise it shows the author, book title, playback progress and controls without requesting transcription. Tap the text or expand control to restore the original Books view. Drag the title to move the overlay and the lower-right handle to resize it within the content area. Pause/resume and thirty-second skips operate on the same player. Close stops playback and submits the normal session close/progress update. Selecting YouTube or leaving the host activity stops Books; selecting Books stops any floating YouTube player. Android system-level PiP and background playback outside FitBaus are not enabled. Physical layout and lifecycle qualification on the console remain necessary.


## Model management and prepared narration (Phase 3C.2G)

With a current paired Transcriber server, open Settings → Transcriber → Manage Models to see Tiny, Base and Small, their installation state and download progress. Tiny remains the bundled live fallback. Optional downloads run on the server, use its existing quota and can be cancelled; leaving the dialog does not stop an admitted download. The dialog polls only while visible and active work is reported, and offers a manual refresh. A downloaded optional model must have a current server hardware qualification before it can prepare a book. With a Phase 3C.2H server, the hardware check starts automatically, and both dialogs display waiting, checking, progress, failure and retry controls. Existing valid qualifications are reused. The bundled synthetic narration is not private audiobook audio and measures hardware feasibility rather than accuracy. Live Read Along takes priority. Servers that advertise source_url but predate automatic qualification retain the manual qualification procedure.

Open a book and tap Prepare in the audiobook player. Select an installed qualified model (Tiny is selected initially), then Prepare. The dialog lists existing jobs for that item, their completed narration duration and progress, and provides pause, resume, cancel and explicit discard controls. Cancel retains completed windows; discard removes them. Resume requires a matching current audio revision. Prepared exact windows are served by the server through the existing Read Along protocol; other windows use the usual Tiny live fallback. Playback continues independently. Server-side background work continues after closing the dialog or leaving the book.

Prepare and Resume reuse the saved Audiobookshelf session without a separate sign-in prompt. The bike retains sole ownership of its rotating refresh token; only the current access credential is forwarded. On servers advertising background_reauthorize, the running bike app periodically checks jobs it started or resumed and conditionally reauthorizes jobs waiting for credentials, even when the preparation dialog is closed. Paused, failed, cancelled and completed jobs are never automatically resumed. API-key and legacy-token sessions use their existing credential. Background authorization is memory-only on the server, with no client-imposed expiration. If the bike app is stopped or powered off, jobs may wait for credentials on upstream expiration; tapping Resume uses the existing saved session. Older compatible servers support the same one-tap start/resume but not automatic reauthorization. Paired-device revocation stops its background work without losing checkpoints. The management client requires the configured Audiobookshelf URL to match the saved connection and checks the manifest against playback timing before sending preparation credentials. HTTPS must not be downgraded to HTTP; private HTTP is for trusted LAN deployments only.

Read Along requires the Transcriber to advertise the same Audiobookshelf base URL as the saved bike connection before source credentials are sent. Servers predating the source_url capability must be upgraded; ordinary audiobook playback remains independent. On live recovery, a matching ready prepared window may replace the original live job identity. Model and preparation mutations require the advertised new capabilities. Qualify on the physical console with Tiny fallback, optional download/cancel, existing Small checkpoints, existing-session passthrough, conditional reauthorization, pause/resume, stale revision, discard confirmation and normal playback while the dialog is open.
