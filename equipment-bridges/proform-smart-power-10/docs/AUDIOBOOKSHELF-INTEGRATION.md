# Audiobookshelf integration

FitBaus Full will provide a native Books screen for a user's self-hosted Audiobookshelf server. No web application embedding, additional playback engine, or transcription model on the console is required.

## Implementation slices

1. **Library API foundation (implemented).** HTTPS or private-network HTTP server URL, username/password authentication or an existing Audiobookshelf API key as a bearer credential, audiobook library enumeration, bounded paginated item metadata, and cover URL construction. The API layer is independent of Android UI and credential storage.
2. **Books screen (implemented).** Media tab, server setup, keystore-backed credential storage, connection validation, library selection, five-column cover grid, pagination and server-side title search. Authenticated covers are confined to the configured origin; stale requests and caches are discarded on tab exit or disconnect. Selecting a book opens the native player.
3. **Playback (implemented; console qualification pending).** Dedicated ExoPlayer audio player with direct-play sessions, multi-file book-relative timeline, server resume, chapter navigation, seek and 30-second skips, playback speed, audio focus, periodic progress sync and session close. Leaving Books or pausing the activity releases playback. Server transcoding, background playback across tabs and offline progress recovery are not included in this slice.
4. **Read Along.** Parse bounded WebVTT/SRT input, synchronize against the book-relative playback clock, and provide large adjustable text and a minimal focus display. Seeking, speed changes and track changes must not cause timestamp drift.
5. **Optional transcription worker.** Run local speech recognition outside the console, using authorized audio only. Cache timestamped transcript segments by book identity and audio revision. Playback must work without a worker.

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

## Qualification

- Unit tests for URL and credential validation, library and item parsing, pagination, HTTP errors, modern and legacy login responses, and bounded token renewal.
- Physical Android 5.1.1 x86 console: username/password and library/cover browsing over private HTTP confirmed. HTTPS, playback and progress synchronization still require console testing.
- Verify uninterrupted bike telemetry and USB control.
- For playback, verify single-file and multi-file books, interrupted networking, resume across devices, and correct progress accounting.
- For Read Along, verify large-text layout, seeks across chapters and playback speeds.
