# Audiobookshelf integration

FitBaus Full will provide a native Books screen for a user's self-hosted Audiobookshelf server. No web application embedding, additional playback engine, or transcription model on the console is required.

## Implementation slices

1. **Library API foundation (implemented).** HTTPS server URL, existing Audiobookshelf API key as a bearer credential, audiobook library enumeration, bounded paginated item metadata, and cover URL construction. The API layer is independent of Android UI and credential storage.
2. **Books screen (implemented).** Media tab, server setup, keystore-backed credential storage, connection validation, library selection, five-column cover grid, pagination and server-side title search. Authenticated covers are confined to the configured origin; stale requests and caches are discarded on tab exit or disconnect. Selecting a book displays metadata only until playback is implemented.
3. **Playback.** Use the existing ExoPlayer dependency with a separate audiobook session controller. Verify direct playback, multi-file track offsets, chapter navigation, resume, playback speed, progress sync, audio focus and session close. Ensure only one media source is audible and preserve bridge USB operation across media transitions.
4. **Read Along.** Parse bounded WebVTT/SRT input, synchronize against the book-relative playback clock, and provide large adjustable text and a minimal focus display. Seeking, speed changes and track changes must not cause timestamp drift.
5. **Optional transcription worker.** Run local speech recognition outside the console, using authorized audio only. Cache timestamped transcript segments by book identity and audio revision. Playback must work without a worker.

## Server connection

Use an HTTPS endpoint with a certificate trusted by Android, either at the server root or under the supported `/audiobookshelf` reverse-proxy path. Do not send API keys in URL query strings, disable certificate verification, or follow redirects carrying credentials. Prefer a dedicated non-admin Audiobookshelf user with access only to the desired libraries.

The API uses the current Audiobookshelf server routes for library enumeration and minified paginated items. See [upstream source](https://github.com/advplyr/audiobookshelf) and the [API reference](https://api.audiobookshelf.org/) (the latter is no longer actively maintained).

## Connect the bike

1. In Audiobookshelf, create an API key associated with a user who can access the desired audiobook libraries.
2. Open **Books** on the console.
3. Enter the HTTPS server URL (including the port or `/audiobookshelf` prefix if needed) and API key, then select **Connect**.
4. Choose a library. Use Previous/Next to browse pages, Search for book-title matches, and Clear to return to the library. Search shows up to 20 direct book matches; author and series match navigation is not included in this slice.
5. To change accounts or servers, select **Disconnect**. This forgets the locally saved connection without revoking the server-side key.

A verified connection is automatically restored when Books is reopened. The API key and server address are encrypted together using a random AES key wrapped by a dedicated Android Keystore RSA key. No API key is embedded in the APK, written to the changelog, or placed in a URL.

## Qualification

- Unit tests for URL and credential validation, library and item parsing, pagination, and HTTP errors.
- Physical Android 5.1.1 x86 console validation against a self-hosted server, including TLS compatibility.
- Verify uninterrupted bike telemetry and USB control.
- For playback, verify single-file and multi-file books, interrupted networking, resume across devices, and correct progress accounting.
- For Read Along, verify large-text layout, seeks across chapters and playback speeds.
