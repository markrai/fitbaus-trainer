# Audiobookshelf integration

FitBaus Full will provide a native Books screen for a user's self-hosted Audiobookshelf server. No web application embedding, additional playback engine, or transcription model on the console is required.

## Implementation slices

1. **Library API foundation (implemented).** HTTPS or private-network HTTP server URL, username/password authentication or an existing Audiobookshelf API key as a bearer credential, audiobook library enumeration, bounded paginated item metadata, and cover URL construction. The API layer is independent of Android UI and credential storage.
2. **Books screen (implemented).** Media tab, server setup, keystore-backed credential storage, connection validation, library selection, five-column cover grid, pagination and server-side title search. Authenticated covers are confined to the configured origin; stale requests and caches are discarded on tab exit or disconnect. Selecting a book opens the native player.
3. **Playback (implemented; console qualification pending).** Dedicated ExoPlayer audio player with direct-play sessions, multi-file book-relative timeline, server resume, chapter navigation, seek and 30-second skips, playback speed, audio focus, periodic progress sync and session close. Leaving Books or pausing the activity releases playback. Server transcoding, background playback across tabs and offline progress recovery are not included in this slice.
4. **Read Along (Phase 3A implemented; qualification pending).** Parse bounded WebVTT/SRT input, synchronize against the book-relative playback clock, and provide an integrated large-print narration area in the default player with text size controls. The audio player remains the sole clock. Local transcript files are a qualification source, not a transcription engine.
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

### Chapter timeline (summarization Phase 1)

The direct-play session already provides Audiobookshelf chapters, independently of physical audio tracks. FitBaus retains their source ID when present, title and book-relative start/end in milliseconds. Ranges are sorted, deduplicated by start (first valid row wins), and half-open. Explicit ends are preserved unless they exceed the next chapter start or book duration; absent ends are inferred from the next valid chapter or the book duration. Invalid or zero-length rows are ignored, blank titles receive a fallback label, and genuine gaps remain unmapped. Chapter metadata is optional and bounded to 2,000 input rows; playback does not depend on it.

No extra metadata request is needed, and tracks are not synthesized into chapters when the server provides none. The live playback clock is the lookup source for both single-file and multi-file books. These chapter ranges are structural anchors only: they do not define summarization sections, request transcripts or invoke an inference provider.

### Summarization sections (Phase 2)

The section resolver uses the live book-relative playback clock and the normalized chapter ranges. Chapters up to ten minutes are a single section; longer chapters are split into approximately equal sections of at most ten minutes, avoiding tiny trailing sections. Unchaptered spans (including gaps between chapters) use consecutive five-minute sections from the span start, with a shorter final section if necessary. Sections never cross a known chapter boundary, and physical audio tracks are not section boundaries. All intervals are half-open; at the book end there is no active section. The section number and count are relative to its chapter or unchaptered span.

Section boundaries are deterministic even when narration is not yet available, after a seek, or when cached windows are evicted. For each section the resolver identifies every intersecting five-minute remote transcript window (at most three), verifies complete coverage and a consistent audio revision, and collects ordered overlapping cues. A missing or mismatched window yields a missing-coverage result with no partial text. A ready silent section is distinct from missing coverage. Fully contained cues are exposed separately from boundary-straddling cues so a future recap can avoid text outside its requested interval; cue-level timing cannot safely split a sentence. Local fixture transcripts can supply cues but are explicitly unverified for coverage and revision.

The read-along component exposes the current section on demand. The existing three-window buffer, audio playback, prefetch schedule and UI are unchanged. Resolution does not submit jobs or start inference; later summary orchestration will need to obtain missing windows, enforce text budgets and establish transcript/model identity for caching. Semantic and sentence-aware boundary refinement is deferred to a later phase.

### Summary provider discovery (Phase 3)

The optional LLM provider is configured and accessed exclusively by [FitBaus Transcriber](https://github.com/markrai/fitbaus-transcriber). Trainer reads the optional `summary_provider` capability from its existing authenticated `GET /v1/capabilities` request. A configured OpenAI-compatible provider advertises its protocol and model name only. Missing, disabled, malformed or unsupported provider capabilities are treated as unavailable without affecting transcription or playback. Configured does not mean the provider is reachable or qualified.

No provider credentials, URLs, extra network requests, summary controls or generation requests are introduced on the bike in this phase. Future summary requests will go through the existing paired transcriber connection, with source/item/revision authorization and section boundaries; summary execution and caching belong on the companion server.

### Summary request client (Phase 4C)

Trainer now exposes an explicit asynchronous current-section summary request and cancellation hook in Read Along. Requests are not triggered by playback, prefetch or entering fullscreen. Phase 5 attaches the visible control in fullscreen reading mode. The companion server must advertise both the summary API and a configured supported provider. Legacy or disabled servers are unavailable for summaries without affecting ordinary playback or narration.

The client checks the configured Audiobookshelf source URL before sharing its access credential with the paired transcriber, verifies the manifest identity and complete track timeline against playback, and rejects an audio revision mismatch with Read Along. It submits only source/item/revision and section timing (plus an optional explicit transcript retry flag); no text, LLM credentials or prompts leave the bike. A separate worker handles pending transcript responses with four-second polling and a five-minute admission/polling budget. A summary POST has a separate 240-second socket read timeout; this is not a hard wall-clock deadline. Pending polls never repeat the explicit failed-transcript retry flag. Transport errors or ambiguous provider outcomes are not automatically retried. Ready/empty responses must match the expected book, revision, section and configured model.

The request is scoped to the selected playback session, section and known audio revision. Changing sections, reopening or closing the book, exiting fullscreen, replacing a request or destroying Read Along cancels local delivery and polling; late results are ignored. Cancellation cannot retract a server request already accepted or necessarily interrupt a blocked socket immediately. The server remains responsible for generation, durable caching, authorization and its own concurrency limits. Trainer retains no persistent summary cache. The fullscreen controls use these hooks.

### Fullscreen summary view (Phase 5)

Fullscreen defaults to live narration. A small Summary control appears in the lower-left only after a remote narration window advertises both the summary API and a supported configured provider. The existing bottom-right fullscreen exit and the top bike telemetry remain unchanged. Local-only transcripts and legacy servers do not show the control. No additional capability request or automatic inference is triggered by opening fullscreen.

Tapping Summary explicitly requests the current section and replaces the reading area with a scrollable panel showing the section interval, an AI-generated/upcoming-narration warning and the preparation, ready, empty or failure state. This is a whole-section summary, not a spoiler-free recap. Retry is explicit; authorization failures direct the rider to reconnect. Tapping Read along restores live narration immediately. Playback, transcript prefetch, telemetry and floating narration remain independent. The panel closes on section/session change, loss of advertised capability, fullscreen exit, book close or destruction. The companion service remains the only place where summaries are generated and cached. Actual console layout and end-to-end provider qualification are still required.

### Narration-aware section adoption (Phase 6B)

When the companion advertises section_plan_api, long chapters use balanced nominal sections of at most eight minutes (chapters up to ten minutes remain intact). Chapter gaps and unchaptered books retain five-minute nominal intervals. Adjacent intervals are grouped into fixed blocks of at most four sections; blocks never cross chapter or gap boundaries. The mode is latched after the first verified remote narration window for a playback session. Older servers retain the original section resolver.

On the first explicit Summary request in an eligible block, the separate summary worker requests the optional read-only section plan before requesting a summary. No planning occurs during ordinary playback or fullscreen entry. The client validates source, audio revision, identity, original cuts, returned algorithm/state/digest and every adjusted interval, including fixed outer anchors and the 30-second shift limit. The server uses existing transcription only; missing windows, unsupported endpoint, network or protocol failures fall back to the nominal block. The summary request independently revalidates audiobook access and its own exact interval.

A selected block (including nominal fallback) is frozen in memory until playback session close or replacement; at most 256 blocks are retained without eviction. Once full, additional blocks remain nominal. This prevents boundaries from drifting while reading, during seeking back to an already selected block, or when more transcription becomes available. Cancelling an in-progress plan before selection does not freeze it. The summary range label updates before generation starts. Leaving the original section or closing the panel during planning suppresses late results. No persistent plan storage or new LLM requests for planning are introduced. Reopening the book can produce different cuts if better transcription is now available.

## Read Along (local qualification)

Open an audiobook. The default player automatically displays synchronized narration when a transcript is available, or the book cover while opening, waiting or unavailable. Use the text-size slider (28–52 sp); playback controls, chapter navigation and seeking stay in the same view. Missing or invalid transcripts are isolated from audio playback. Tap the fullscreen icon at the lower-right of the narration to hide the app header and player controls, retaining only the live exercise HUD at the very top above the narration. Tap the same corner to restore the regular player. The existing audio session and text size are retained; leaving the book or minimizing returns to regular mode.

For now, the local source looks for a UTF-8 transcript under the app-specific external files directory:

```text
read-along/<SHA-256 of saved server address>/<library item ID>.vtt
```

A file with the same base name and `.srt` extension is also supported. To test, open a book without a paired transcriber; the local source creates the parent directory. Push a small test file to the path above within the app's external files directory using ADB, then tap **Retry Narration**. A sample fixture:

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
- For Read Along, verify large-text layout, exact cue boundaries and gaps, backward/forward seeks, chapters and playback speeds. Confirm that the automatic transition from cover to narration does not restart the audiobook and that missing/malformed files never stop playback.


## Optional transcriber connection (Phase 3D.1)

The separate [FitBaus Transcriber](https://github.com/markrai/fitbaus-transcriber) service can be configured in native Settings → Transcriber. Select HTTPS or HTTP, enter the host and port (initial default 8765), and enter a one-time pairing code generated by `docker compose exec transcriber python -m transcriber pair` on the server. Connect exchanges the code for a separate device bearer and validates the authenticated v1 capability response before saving. A compatible service without a prepared model or configured source can be saved but is shown as not ready. Disconnect removes only the transcriber configuration. The token is masked and stored in a separate Android Keystore-wrapped encrypted record; it is not sent to Audiobookshelf. Changing the endpoint requires a fresh code rather than forwarding the saved token automatically. Codes are case-insensitive, expire after ten minutes, and are automatically hyphenated. Tap Connect with an empty code to retest the unchanged saved connection. Disconnect removes the local credential; the server operator can revoke all paired credentials.

HTTP uses the same private IPv4 restriction as Audiobookshelf; HTTPS uses normal certificate validation. For a local deployment, configure the companion's LAN binding and restrict access to the trusted LAN before connecting. This phase only establishes the connection; remote transcript requests, Audiobookshelf credential reuse, lookahead and synchronized rendering follow in Phase 3D.2/3D.3. Normal audio playback and local fixture Read Along remain unchanged.


## Remote Read Along (Phase 3D.2)

Pair the transcriber in Settings → Transcriber. Successful ready status is green. Open an audiobook; narration loads automatically in its player. A paired service receives the current Audiobookshelf access credential (not the password or refresh token) alongside its own device bearer. The paired service must be trusted and configured for the same audiobook library. If Audiobookshelf uses HTTPS, the transcriber must also use HTTPS to avoid downgrading credential transport. A missing pairing retains the previous local VTT/SRT fixture path.

The reader requests the aligned five-minute window containing the player's current position, polls the asynchronous job on a background worker, and renders cues using the actual book-relative player clock. It verifies the manifest against playback track IDs and timing, requires matching source/item/revision/coverage in job and transcript responses, accepts silent windows and discards superseded UI results. A change of audio revision requires reopening the audiobook. Seeking to another window requests that window. Playback continues while the transcript is pending or unavailable; Retry Narration retries a failed window. Closing the audiobook stops client polling, not already admitted server inference.

Phase 3D.3 automatically requests one upcoming window as soon as the current window is ready and playback is requested. The reader keeps at most the previous, current and next windows in memory and switches by the actual playback clock. A seek to an uncached window takes priority over speculative work. Failed prefetch does not disturb current narration; it is retried when needed, and a failed foreground request waits for Reload. Slow or unavailable transcription may still leave a gap; audio is never paused to wait for text. No new server deployment or model is needed.


## Floating Books player

Switch to Dashboard or a game during an established audiobook session to keep listening in a compact in-app overlay. When narration is available, the overlay shows the same synchronized text and uses the same transcript buffer and lookahead worker. Otherwise it shows the book cover from the default player, falling back to author metadata only if artwork is unavailable. The overlay reuses the already loaded bitmap rather than fetching a second copy; title, playback progress and controls remain visible. Tap the text or expand control to restore the original Books view. Drag the title to move the overlay and the lower-right handle to resize it within the content area. Pause/resume and thirty-second skips operate on the same player. Close stops playback and submits the normal session close/progress update. Selecting YouTube or leaving the host activity stops Books; selecting Books stops any floating YouTube player. Android system-level PiP and background playback outside FitBaus are not enabled. Physical layout and lifecycle qualification on the console remain necessary.


## Model management and prepared narration (Phase 3C.2G)

With a current paired Transcriber server, open Settings → Transcriber → Manage Models to see Tiny, Base and Small, their installation state and download progress. Tiny remains the bundled live fallback. Optional downloads run on the server, use its existing quota and can be cancelled; leaving the dialog does not stop an admitted download. The dialog polls only while visible and active work is reported, and offers a manual refresh. A downloaded optional model must have a current server hardware qualification before it can prepare a book. With a Phase 3C.2H server, the hardware check starts automatically, and both dialogs display waiting, checking, progress, failure and retry controls. Existing valid qualifications are reused. The bundled synthetic narration is not private audiobook audio and measures hardware feasibility rather than accuracy. Live Read Along takes priority. Servers that advertise source_url but predate automatic qualification retain the manual qualification procedure.

Open a book and tap **Transcription Models** in the audiobook player. Three model cards describe speed, quality, resource use and installation status. Select an installed qualified model (Tiny is selected initially), then **Start [model] Transcription**. The dialog lists existing jobs for that item, their completed narration duration and progress, and provides pause, resume, cancel and explicit discard controls. Cancel retains completed windows; discard removes them. Resume requires a matching current audio revision. Prepared exact windows are served by the server through the existing Read Along protocol; other windows use the usual Tiny live fallback. Playback continues independently. Server-side background work continues after closing the dialog or leaving the book.

Start Transcription and Resume reuse the saved Audiobookshelf session without a separate sign-in prompt. The bike retains sole ownership of its rotating refresh token; only the current access credential is forwarded. On servers advertising background_reauthorize, the running bike app periodically checks jobs it started or resumed and conditionally reauthorizes jobs waiting for credentials, even when the preparation dialog is closed. Paused, failed, cancelled and completed jobs are never automatically resumed. API-key and legacy-token sessions use their existing credential. Background authorization is memory-only on the server, with no client-imposed expiration. If the bike app is stopped or powered off, jobs may wait for credentials on upstream expiration; tapping Resume uses the existing saved session. Older compatible servers support the same one-tap start/resume but not automatic reauthorization. Paired-device revocation stops its background work without losing checkpoints. The management client requires the configured Audiobookshelf URL to match the saved connection and checks the manifest against playback timing before sending preparation credentials. HTTPS must not be downgraded to HTTP; private HTTP is for trusted LAN deployments only.

Read Along requires the Transcriber to advertise the same Audiobookshelf base URL as the saved bike connection before source credentials are sent. Servers predating the source_url capability must be upgraded; ordinary audiobook playback remains independent. On live recovery, a matching ready prepared window may replace the original live job identity. Model and preparation mutations require the advertised new capabilities. Qualify on the physical console with Tiny fallback, optional download/cancel, existing Small checkpoints, existing-session passthrough, conditional reauthorization, pause/resume, stale revision, discard confirmation and normal playback while the dialog is open.
