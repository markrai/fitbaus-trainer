# YouTube tab

The Bike Bridge console app has a **YouTube** tab next to the game tabs. It
browses and plays public YouTube videos natively inside `NativeBridgeActivity`
(no WebView, no external app, no extra Activity or service). The technique is
the one qualified on the console with SkyTube OSS 3.003
([YOUTUBE-QUALIFICATION.md](YOUTUBE-QUALIFICATION.md)), reimplemented as a
small FitBaus-owned layer.

## Behaviour

- **Browse:** opening the YouTube tab always shows the default thumbnail
  grid: Trending while signed out, or **FROM YOUR CHANNELS** while signed in.
  The signed-in grid combines recent uploads from subscribed channels, with
  more channel batches loaded as the user scrolls. The separate SEARCH and
  MY FEED buttons are removed. The search field remains, using the keyboard
  Search action for global YouTube search; its × clears the search and returns
  to the default feed. **MY YOUTUBE** opens the account browser for channels
  and playlists. Its top-left back arrow returns to the home grid; the lower
  BACK control remains for channel/playlist hierarchy. This is not Google's
  proprietary Home recommendations.
- **Discover:** on an authenticated subscription home grid, DISCOVER switches
  the existing video grid to related-video suggestions. It selects at most
  three non-live seeds, preferring distinct subscribed channels, then uses
  NewPipe's `StreamInfo.getRelatedItems()` for up to twelve candidates per
  seed. Round-robin mixing, filtering and ID deduplication produce at most
  24 results and exclude videos already visible in the source sample.
  Suggestions are fetched only when tapped, with an explicit retry and a
  separate cancellable below-normal-priority worker. Returning to FROM YOUR
  CHANNELS does not refetch the original feed; searching resets the discovery
  view. Discovery never requests additional Google scopes or YouTube API
  search quota. Unauthenticated Trending has no Discover control, and
  extraction failures never silently replace the subscription feed.
- **Play:** tapping a card opens the player inside the tab: video surface,
  PLAY/PAUSE (or tap the video, showing a briefly centered play/pause icon), seek bar with buffered range, elapsed and
  total time, a screen-brightness slider (5-100 %, written to the same
  brightness setting as the Bridge brightness API and applied immediately), a
  vertical system music-volume slider in its own column right of the video
  (top loud, bottom silent, with a percentage; follows hardware volume keys), a
  quality menu (240p / 360p default / 480p maximum, persisted), a CC toggle,
  and
  "‹ RESULTS". Live videos play from
  HLS and cannot seek. The exercise HUD (RPM / Watts / Resistance / HR) stays
  visible above the tab, fed from the existing 200 ms dashboard refresh.
- **Captions:** NewPipeExtractor supplies available subtitle tracks. FitBaus
  picks a single supported track, preferring English then human-authored tracks;
  if only another language is available, it uses that instead. Supported
  formats are WebVTT, TTML and SRT. Captions start enabled when available,
  and the CC button enables/disables them without restarting video playback.
  A small text overlay stays within the video frame, not the exercise HUD.
  Caption files are capped at 2 MiB and loaded by ExoPlayer independently
  of audio/video; missing/expired caption URLs are treated as a missing
  caption rather than a video failure. Videos without usable captions play
  normally with CC disabled. This lightweight first version selects one
  language per video, without a language picker or translations.
- **Google authorization lifecycle:** the TV OAuth client ID/secret are persisted
  encrypted by the existing importer. They are separate from Google's
  short-lived device code. Entering MY YOUTUBE with an existing client and no
  connected account automatically requests a new device code on the existing
  Google-account worker, without another ADB import. Re-entering with an
  unexpired code keeps the same code, including across tab switches. The
  authorization ticket remains in memory, but polling is suspended when
  the YouTube tab is inactive; it resumes on return. A code whose lifetime
  has elapsed is never reused. Google provides `expires_in` (sample 1800 seconds) and
  `interval` in each device response. FitBaus computes the code deadline
  using `SystemClock.elapsedRealtime()` from receipt, clears the visible
  code/QR at expiry and stops polling. A window-focus check also catches
  codes that expired while Android delayed callbacks were suspended in sleep. Users can choose GET NEW CODE without
  resupplying the OAuth client. Google token refresh is unchanged.
  Consistent with RFC 8628, no device codes are requested at app startup
  or automatically regenerated on a background expiry timer. The existing
  manual CHANGE CLIENT path remains available. Imported credentials still
  initiate their original immediate authorization once; imports bypass
  the stored-client auto-arm path to avoid issuing duplicate codes.
- **Google authorization handoff:** while awaiting OAuth approval, MY YOUTUBE
  shows a local 256×256-pixel QR code rendered by ZXing Core with a white quiet
  zone and a large, case-sensitive manual code. It encodes only Google's
  exact `verification_url`, or the validated complete URI if Google's
  response actually supplies one (`verification_uri_complete` or
  `verification_url_complete`). Google currently documents the basic URL
  and separate user code, so prefill is not promised or synthesized.
  The code and QR are removed when authorization finishes, fails or is
  cancelled. QR rendering is bounded, occurs only when the URL changes,
  and degrades to manual URL/code entry if encoding fails. No HTTP QR service,
  new permissions, on-bike browser, or change to OAuth polling.
- **Account browser:** MY YOUTUBE lists subscribed channels and personal
  playlists, with pagination. Choose a subscribed channel to see its recent
  uploads, or a playlist to see its videos; choose a video to play it in the
  same native player. A top-left arrow replaces the old MY YOUTUBE heading
  and BROWSE button; it returns to the home grid. Channel or playlist names
  still appear when browsing a specific collection. The subscribed-channel
  list is not the personalized YouTube Home feed; the official API does not
  expose Home recommendations. The account UI uses compact text lists rather
  than the thumbnail browsing grid.
- **Floating player continuity:** switching from YouTube to Dashboard or
  any arcade game while a video is resolving, buffering, playing or paused
  moves the same video view to a compact overlay in the top-right of the
  content area. Playback continues, including its existing audio, position,
  subtitle state and decoder. The floating preview is a full 16:9 image
  with no title bar; a 48 dp touch target for the X overlays its top-right
  corner. Tap the video or the YouTube tab to return to the full player
  without a stream re-resolution. The X closes the overlay, stops playback
  and releases ExoPlayer. The overlay is
  not created for browse-only, failed or completed videos. A video that
  finishes or encounters a playback error after floating remains visible
  until the user taps X or returns to YouTube. Normal game cameras and
  clocks continue independently of the floating player.
  This is an in-Activity UI overlay for Android 5.1.1, not Android's system
  PiP, and does not persist when FitBaus itself loses foreground focus.
- **Leaving the Activity:** pausing or destroying FitBaus releases video
  playback, regardless of whether the user is viewing YouTube or a floating
  player over Dashboard/game content. Returning after a host pause shows
  browsing results as before; reopening the same video can resume from its
  saved position (positions under 5 s and finished videos start over).
  Switching tabs without an active video also retains the old stop behavior.

## Architecture

```text
host/arcade/ArcadeMode.kt      ModeKind {Dashboard, Game, Media}; YouTube is Media
host/NativeBridgeActivity.kt   YouTube tab group, content view, startMedia/stopMedia hooks
host/youtube/
  YouTubeModels.kt             VideoSummary, FeedPage, failures, catalog interface
  NewPipeYouTubeCatalog.kt     kiosk / search / paging / stream lookup (NewPipe)   [GPL-3.0 adapted]
  HttpUrlDownloader.kt         NewPipe Downloader over HttpURLConnection
  YouTubeStreamSelector.kt     stream choice from plain descriptors                [GPL-3.0 adapted]
  YouTubeMediaSources.kt       ExoPlayer DASH / progressive / HLS + captions     [GPL-3.0 adapted]
  PlayerEngine.kt              engine interface + ExoPlayer 2.19.1 implementation
  YouTubeSession.kt            state machine: lists, playback, staleness, retries
  ThumbnailLoader.kt           bounded thumbnail fetch and cache
  YouTubeContent.kt            programmatic UI
  GoogleYouTubeApi.kt           Google OAuth and YouTube Data API HTTP client
  GoogleAccountStore.kt         Android Keystore-encrypted credential storage
  GoogleAccountController.kt    authorization polling and account requests
  GoogleAccountView.kt          native account browser and login controls
  GoogleSubscriptionFeedCatalog.kt  bounded subscribed-channel home grid
java/.../youtube/media/YoutubeHttpDataSource.java                                [copied, GPL-3.0 + Apache-2.0]
```

`ArcadeMode.isGame` is true only for game modes. Dashboard and YouTube
never start the arcade camera or clock. `ArcadeModeController` still owns the
selected game's camera/clock lifecycle; floating YouTube playback is managed
separately by the Activity and may coexist with one active game. Only one
ExoPlayer and one arcade camera pipeline are created. Host pause releases
both media playback and the game pipeline.

`YouTubeSession` runs on the main thread. Extraction and media-source
preparation (some NewPipe manifest creators make network requests) run on one
background thread at below-normal priority; only the ExoPlayer calls run on the
main thread. Thumbnails use two minimum-priority threads.
Each list request and each playback attempt carries a generation number, so a
late response from an older search, page or video is dropped. Each page
request deduplicates against its own copy of the IDs already shown, and the
next-page cursor is adopted only when the response is accepted, so a response
discarded after a tab switch cannot hide videos when the page is retried. Engine callbacks
are tied to the engine that produced them.

### Stream selection

Inputs are NewPipe's combined (`videoStreams`), video-only and audio streams
plus the HLS URL. Rules, adapted from SkyTube's `StreamSelectionPolicy`:

1. Live streams use HLS.
2. Usable video: URL delivery, progressive or DASH, MP4 / WebM / 3GP, codec
   H.264, VP9 profile 0, VP8 or MPEG-4. AV1 and high-bit-depth VP9 are
   rejected.
3. Usable audio: original track, AAC, Opus or Vorbis (no AC-3 / E-AC-3).
   AAC is preferred, at the highest bitrate up to 160 kbit/s.
4. Video-only streams are only considered when usable audio exists.
5. Pick the highest height at or below the cap (default 360p). At equal
   height: combined before split, then H.264, VP9, VP8, MPEG-4, then
   progressive before DASH, then lower bitrate. The cap is a strict
   maximum: a stream above it is never chosen.
6. Otherwise fall back to HLS with the same cap applied in ExoPlayer's track
   selector (`setMaxVideoSize`, `setExceedVideoConstraintsIfNecessary(false)`).
   If HLS has no variant within the cap, playback stops with a quality error.
7. Otherwise report "isn't available at Np or lower (lowest is Mp)" when only
   higher qualities exist, or "no format this console can play".

Progressive video-only and audio streams are wrapped in DASH manifests made by
NewPipe's `YoutubeProgressiveDashManifestCreator` and fetched through
`YoutubeHttpDataSource` (range and `rn` parameters, POST body, client
user agent), exactly as SkyTube does. Separate video and audio are merged with
`MergingMediaSource`.

### Recovery (never unbounded)

| Event | Action |
| --- | --- |
| HTTP 403 / 404 / 410 during playback (expired URL) | re-resolve once and resume at the same position; a second expiry is an error |
| Decoder failure | exclude that codec family and re-plan once (for example H.264 to VP9); a second failure is an error |
| Network, parse or other playback error | release the player and show the message with RETRY |
| List or page failure | message with RETRY; paging stops until the user taps retry |
| HTTP 429 or "confirm you're not a bot" | rate-limit message; nothing retries automatically |
| Only qualities above the selected maximum | quality error naming the lowest available height; no automatic upgrade |


## Composite subscribed-channel home grid

When Google authentication is present, the console requests the user's
subscriptions using `subscriptions.list(mine=true, order=unread)`. For each
visible batch of at most eight channels, `channels.list` resolves the
channel uploads playlists in one request, followed by at most one
`playlistItems.list` request per channel (up to four recent videos).
The result is deduplicated and sorted newest-first **within the sampled
batch**. Further batches are fetched only through the existing grid's
pagination behavior; the complete channel library is not fetched at
startup. The API may return fewer uploads for channels with private or
unavailable content.

This uses at most approximately **10 units** for the first feed batch
(one subscription page, one channel lookup, and up to eight uploads
playlist requests), and about nine more for each further eight-channel
batch. Each API read costs one unit under Google's published quota
schedule. It does not use the costly `search.list` API to discover
channel uploads. Browsing and playback remain in the existing YouTube
worker, never on the UI thread or equipment-control worker. Cached access
tokens remain memory-only; switching Google accounts invalidates them
before subsequent feed requests.

The composite does **not** claim to reproduce Google's exact Home
recommendations, global chronological ordering across all subscriptions,
or user's watch history. Unauthenticated users continue to receive
NewPipe Trending. An authenticated API failure is not silently replaced
with Trending.

## Google account setup and limits

For the full end-user Google Cloud setup and troubleshooting instructions,
including Google Auth Platform navigation, OAuth scopes, ADB import, and the
successful-`adb push` output regression, see
[Connect YouTube to FitBaus](../../../docs/YOUTUBE-GOOGLE-OAUTH-SETUP.md).

### Import Google OAuth credentials with ADB (Windows)

1. Download the **TVs and Limited Input devices** OAuth client JSON from
   Google Cloud Console. Keep its original filename.
2. Create `secrets/youtube/` under the repository root and put **exactly
   one** `.json` file there. Git ignores the entire `secrets/` directory.
3. Install a Bike Bridge build containing the importer, enable ADB on
   the console, and from the repository root run:

   ```bat
   push_youtube_auth.bat
   ```

   By default this targets `192.168.1.226:5555`, just like `deploy-bike.bat`.
   Set `FITBAUS_BIKE_ADB` or supply a target address to override. For staging:

   ```bat
   push_youtube_auth.bat 192.168.1.200 staging
   ```

4. The script validates the Google `installed.client_id` and
   `installed.client_secret`, checks the exact ADB target and installed app,
   briefly pushes the JSON to the app-specific external files directory,
   and invokes the app's one-time nonce-based import action.
5. FitBaus immediately deletes the staging JSON, encrypts the secret with
   its existing Android Keystore-backed credential store, and initiates
   the same Google device-code login flow as manual entry. The script
   reports success only when storage acknowledges the import, then cleans
   up any remaining staging and status files even if import fails.
6. Approve the code displayed on the bike with your phone. The client
   JSON alone cannot authorize your YouTube account.

The JSON and secret are never passed in shell arguments, logs, APK builds
or Bridge HTTP APIs. This is not a new network service or Android permission.
Android 5.1's app-specific **external** storage is not private against
other apps with broad storage access; plaintext exists there briefly.
Keep ADB private, import promptly, and delete your local JSON when no longer
needed. Never commit or share the downloaded file.

### Manual entry

1. In Google Cloud Console (https://console.cloud.google.com/), select or
   create a project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen and create an OAuth client with type
   **TVs and Limited Input devices**. If the consent screen is in Testing,
   add the intended Google account as a test user. Google may expire Testing
   refresh tokens after seven days.
3. On the console, open **YouTube → MY YOUTUBE → CONNECT GOOGLE**. Enter the
   TV OAuth client ID and its client secret. Do not commit these credentials
   to the repository or add them to CI logs.
4. FitBaus displays Google's device-verification URL and user code. Open that
   URL on a phone already signed in to Google, enter the displayed code, and
   consent to **YouTube read-only access**.
5. Once authorized, open Subscriptions or Playlists. The selected video is
   resolved and played using FitBaus's existing NewPipe/ExoPlayer player.
   Sign out using the account browser's **SIGN OUT** control.

The Google credentials are configured per bike. The TV client credentials are
not privileged server secrets and cannot be kept truly secret in a distributed
app; FitBaus nevertheless keeps them out of source control and encrypts the
locally stored client secret and refresh token using an Android Keystore-backed
AES-GCM key. Access tokens are kept only in memory. Neither OAuth tokens nor
Google passwords are passed to NewPipe, to the Bridge HTTP server, or to the
Trainer. App backup is disabled in the Bridge manifest.

Google grants only the requested youtube.readonly scope. The official
YouTube Data API provides the authorized user's subscriptions, playlists, and
playlist items, but not the personalized Home recommendation feed, Watch Later,
or Watch History. Videos unavailable to unauthenticated NewPipe playback will
still be unavailable in the FitBaus player. Account data is fetched on demand
with paginated requests (up to 50 items per page), not a background bulk-sync.

The account worker, token polling and HTTPS calls are independent of the
Bridge's USB/resistance/control workers. No new Android permissions or network
listeners are introduced. Network responses are capped at 512 KiB, connections
have fixed timeouts and redirects are disabled; Google API tokens are sent only
in bearer headers to fixed Google API endpoints. Leaving the YouTube tab cancels
authorization polling and UI request delivery. Signing out removes the saved
refresh token locally before attempting server-side revocation; a failed
revocation can still be completed through Google Account access settings.

Before any production release, physically qualify the Google code flow,
token refresh/revocation, expired authorization, app/process restart,
subscriptions with many pages, playlist videos, console memory, and continuous
bike telemetry while watching video.

## Bike Bridge protection

- No YouTube code references the Bridge service, USB session, HTTP server,
  resistance, pairing, camera or permissions; `YouTubeSafetyTest` enforces
  this by scanning the sources. Mode hooks never touch `NativeBridgeService`
  (`ArcadeModeTest`).
- Manifest permissions are unchanged. ExoPlayer's `ACCESS_NETWORK_STATE` is
  removed with `tools:node="remove"`; ExoPlayer's `NetworkTypeObserver`
  catches the resulting `SecurityException` and reports an unknown network.
- The tab runs in the Bridge's process (the Bridge service has no separate
  `android:process`). An uncaught exception in UI code would therefore
  restart the Bridge. All extraction, engine creation and preparation paths
  catch failures and turn them into on-screen errors; this still needs to be
  watched in the on-console soak test.

## Memory and size

| Item | Bound |
| --- | --- |
| Players | one; released on video change, back, tab change, pause and destroy |
| ExoPlayer buffer | 15-30 s, start after 1.5 s, rebuffer 3 s, 16 MB target (Java heap) |
| Disk media cache | none (SkyTube's `SimpleCache` is not used) |
| NewPipe manifest caches | 4 entries each, cleared before each preparation |
| Thumbnails | 320x180 `mqdefault.jpg`, RGB_565, 4 MB LRU, cleared when the tab is left; each request has its own ticket so a stale completion cannot affect a recycled card; failed or cancelled loads retry on the next bind, and the grid rebinds when the tab reopens |
| Extractor responses | 8 MB maximum body; connect 10 s, read 15-20 s timeouts |
| Media HTTP error bodies | 64 KiB maximum, error stream always closed (`YoutubeHttpDataSource`) |

The console's Dalvik heap growth limit is 100 MB per process. SkyTube used
87-115 MB PSS in total (Java plus native) while playing.

APK size: the unsigned release build grows from about 7.4 MB (installed
2.1.0) to 11.5 MB. Uncompressed dex is 12.7 MB. The extractor (about
0.8 MB), Rhino, ExoPlayer core/DASH/HLS, Guava and protobuf-lite account for
most of it. The build does not run R8; enabling minification would shrink
this but is a separate, project-wide decision.

## Dependencies

| Artifact | Version | Repository | License |
| --- | --- | --- | --- |
| `com.github.SkyTubeTeam:NewPipeExtractor` | `skytube-2026-10-24` (commit `08bdd480`) | JitPack | GPL-3.0 |
| `com.github.TeamNewPipe:nanojson` (transitive) | `e9d656dd...` | JitPack | Apache-2.0 |
| `org.mozilla:rhino` (transitive) | 1.7.15 | Maven Central | MPL-2.0 |
| `org.jsoup:jsoup` (transitive) | 1.23.2 | Maven Central | MIT |
| `com.google.protobuf:protobuf-javalite` (transitive) | 4.36.2 | Maven Central | BSD-3-Clause |
| `com.google.android.exoplayer:exoplayer-core / -dash / -hls` | 2.19.1 | Google | Apache-2.0 |
| `com.google.guava:guava`, `androidx.annotation:annotation` | 31.1-android, 1.3.0 (same versions ExoPlayer already resolves; declared because the copied data source compiles against them) | Maven Central / Google | Apache-2.0 |
| `com.android.tools:desugar_jdk_libs` | 2.0.2 | Google | GPL-2.0 with Classpath Exception |

JitPack is declared in `settings.gradle.kts` inside `exclusiveContent`, limited
to exactly those two modules, so no other dependency can resolve from it. The
SkyTube `okhttp-client` component was not used; `HttpUrlDownloader` replaces
it with the platform `HttpURLConnection` (the same stack SkyTube's media data
source already used on the console). SkyTube's UI libraries, Glide, RxJava and
`exoplayer-ui` are not used.

Build changes required by the extractor:

- **Core library desugaring** (`desugar_jdk_libs` 2.0.2, as SkyTube uses): the
  extractor calls `java.time` and `java.util.function`, which API 22 lacks.
- **Java/Kotlin target 17 for `bridge-app`** (was 1.8): the extractor jar is
  Java 17 bytecode containing `record`s. AGP only enables D8 global synthetics
  for debuggable variants when the module's language level is above 14;
  without it `mergeExtDexDebug` fails with "Attempt to create a global
  synthetic for 'Record desugaring' without a global-synthetics consumer".
  D8 still emits dex for minSdk 22; SkyTube builds the same way.
- ExoPlayer 2.19.1 marks its API deprecated in favour of Media3, so the two
  ExoPlayer-facing files carry `@file:Suppress("DEPRECATION")` under the
  module's warnings-as-errors setting. Media3 was not substituted because
  2.19.1 is the version qualified on this console.

## Licensing

See `bridge-app/third-party/YOUTUBE-NOTICE`, shipped in the APK as
`assets/licenses/YOUTUBE-NOTICE` with the license texts under
`assets/licenses/`. The adapted files keep the SkyTube copyright and GPL-3.0
notice, pin the SkyTube revision, carry `SPDX-License-Identifier: GPL-3.0-only`
(the copied data source is `GPL-3.0-only AND Apache-2.0`) and describe the
FitBaus changes. All other new files are AGPL-3.0-only. Distributing the APK
requires offering the complete corresponding source, including the extractor
fork at the pinned commit.

## YouTube service and distribution concerns

- The tab uses NewPipeExtractor, not the YouTube Data API or the official
  player. YouTube's Terms of Service restrict accessing content other than
  through YouTube's own players and interfaces. Using this for a personal
  console is the same position as NewPipe or SkyTube. Distributing it to
  third parties, especially commercially, is a legal and policy decision for
  the project owner.
- No sign-in, no Google services, no downloads or offline storage, no DRM or
  restriction bypass. Age-restricted, private, members-only, paid,
  region-blocked and upcoming videos show an error.
- YouTube changes break extractors regularly. The extractor fork must be
  updated (new tag, re-verified on the console) when browsing or playback
  stops working. Stream URLs are bound to the console's IP and expire after a
  few hours; the single automatic re-resolve covers long pauses.
- Streams use the extractor's `VISIONOS` client user agent for media requests,
  as SkyTube does.

## Tests

`bridge-app/src/test/kotlin/com/fitbaus/bikebridge/host/`:

- `arcade/ArcadeModeTest`: classification, YouTube never activating the
  arcade, game/YouTube/Dashboard ownership hand-over, pause/resume/destroy,
  activity wiring without camera, clock or Bridge service.
- `youtube/YouTubeStreamSelectorTest`: combined, split, unsupported formats,
  HLS and live, caps, audio choice, codec exclusion.
- `youtube/YouTubeSessionTest`: discovery, search, empty and failed states,
  stale list / page / resolution responses, single player, release on back,
  stop and destroy, resume, expired-URL and decoder recovery limits, quality
  change, controls, live.
- `youtube/NewPipeMappingTest`: NewPipe items and streams to FitBaus models,
  failure classification, ID validation, formatting.
- `youtube/NewPipePagingTest`: real NewPipe cursor over a fake list
  extractor; a discarded page request followed by a retry (directly and via
  a tab switch in the session) still shows every new video.
- `youtube/ThumbnailRequestsTest`: stale completions on recycled cards,
  pause cancellation, retry and rebind on return.
- `youtube/media/YoutubeHttpDataSourceBoundsTest`: 64 KiB error-body bound,
  stream closing and attribution of the change.
- `youtube/HttpUrlDownloaderTest`: POST bodies, headers, gzip, 429, error
  bodies, size bound (loopback server only), playback failure classification.
- `youtube/YouTubeSafetyTest`: forbidden references, attribution headers,
  permissions, identity, pinned dependencies, JitPack scope, shipped notices.

No unit test touches the internet.
