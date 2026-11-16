# YouTube tab

The Bike Bridge console app has a **YouTube** tab next to the game tabs. It
browses and plays public YouTube videos natively inside `NativeBridgeActivity`
(no WebView, no external app, no extra Activity or service). The technique is
the one qualified on the console with SkyTube OSS 3.003
([YOUTUBE-QUALIFICATION.md](YOUTUBE-QUALIFICATION.md)), reimplemented as a
small FitBaus-owned layer.

## Behaviour

- **Browse:** opening the tab loads YouTube's default kiosk (trending) as a
  thumbnail grid with title, channel, views and duration (or LIVE). A search
  field, SEARCH and TRENDING buttons sit above the grid. Further pages load
  as the grid nears its end. Loading, empty, error (with RETRY) and
  "couldn't load more, tap to retry" states are shown in place.
- **Play:** tapping a card opens the player inside the tab: video surface,
  PLAY/PAUSE (or tap the video), seek bar with buffered range, elapsed and
  total time, a screen-brightness slider (5-100 %, written to the same
  brightness setting as the Bridge brightness API and applied immediately), a
  vertical system music-volume slider in its own column right of the video
  (top loud, bottom silent, with a percentage; follows hardware volume keys), a
  quality menu (240p / 360p default / 480p maximum, persisted) and
  "‹ RESULTS". Live videos play from
  HLS and cannot seek. The exercise HUD (RPM / Watts / Resistance / HR) stays
  visible above the tab, fed from the existing 200 ms dashboard refresh.
- **Leaving:** switching tabs, opening settings or pausing the activity
  releases the player and cancels outstanding work. Coming back shows the
  results list as it was; reopening the same video resumes where it stopped
  (positions under 5 s and finished videos start over).

## Architecture

```text
host/arcade/ArcadeMode.kt      ModeKind {Dashboard, Game, Media}; YouTube is Media
host/NativeBridgeActivity.kt   YouTube tab group, content view, startMedia/stopMedia hooks
host/youtube/
  YouTubeModels.kt             VideoSummary, FeedPage, failures, catalog interface
  NewPipeYouTubeCatalog.kt     kiosk / search / paging / stream lookup (NewPipe)   [GPL-3.0 adapted]
  HttpUrlDownloader.kt         NewPipe Downloader over HttpURLConnection
  YouTubeStreamSelector.kt     stream choice from plain descriptors                [GPL-3.0 adapted]
  YouTubeMediaSources.kt       ExoPlayer DASH / progressive / HLS sources          [GPL-3.0 adapted]
  PlayerEngine.kt              engine interface + ExoPlayer 2.19.1 implementation
  YouTubeSession.kt            state machine: lists, playback, staleness, retries
  ThumbnailLoader.kt           bounded thumbnail fetch and cache
  YouTubeContent.kt            programmatic UI
java/.../youtube/media/YoutubeHttpDataSource.java                                [copied, GPL-3.0 + Apache-2.0]
```

`ArcadeMode.isGame` is now true only for game modes. Dashboard and YouTube
never start the arcade camera or clock. `ArcadeModeController` owns at most one
of {camera pipeline, media player} at a time and stops the previous owner
before starting the next one.

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
