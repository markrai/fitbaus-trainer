# YouTube playback qualification (ProForm Smart Power 10.0 console)

Hardware feasibility record for in-console YouTube playback. Measured on
2026-11-15 on the bike console at `192.168.1.226` (Android 5.1.1, API 22,
Intel Atom Z3735G x86, 898 MB RAM, 1280x800 at 160 dpi, no Google Play
services) while the native Bike Bridge 2.1.0 (`com.fitbaus.bikebridge`) was
running and connected to the brainboard.

## Result summary

| Path | Result |
| --- | --- |
| Official YouTube iframe player in the platform WebView (Chromium 39) | **Fails.** The player script uses ES2015+ syntax and `queueMicrotask`, which WebView 39 cannot parse or provide. |
| Firefox for Android 143.0.4 | **Fails.** YouTube shows "An error occurred"; two low-memory kills hit the Bridge process during the attempt. Firefox was then uninstalled. |
| SkyTube OSS 3.003 (NewPipeExtractor + ExoPlayer 2.19.1) | **Passes.** Real video and audio, Bridge unaffected. |

## SkyTube OSS 3.003 details

- APK: official GitHub release `v3.003`, CI-built, SHA-256
  `222f6be99185e4152f4f2166e3309ea5dec06e165cd2fa602de5e434fd219b4f`
  (matches GitHub's published digest). Package `free.rm.skytube.oss`,
  versionCode 63, minSdk 19, no native libraries, signer CN=Zsombor Gegesy.
- Video A `jNQXAC9IVRw` ("Me at the zoo", H.264): played to the end.
- Video B `aqz-KE-bpKQ` (Big Buck Bunny) with the highest resolution capped
  at 360p: SkyTube chose itag 243 (VP9 360p, WebM, video-only) plus itag 251
  (Opus), each wrapped in a generated DASH manifest and merged
  (`MergingMediaSource`). Stream URLs came from the `VISIONOS` client.
- Pause held a still frame and silenced audio (`audio_flinger`: 0 active
  tracks); seek from 0:52 to the midpoint rebuffered briefly and resumed.
  The owner confirmed picture and sound by ear.
- Sustained playback, sampled every 30 s:

| Measure | Result |
| --- | --- |
| Duration | about 4.5 minutes (cut short of the 10-minute target at the owner's request; values were flat) |
| SkyTube PSS | 87-115 MB |
| SkyTube CPU | 16-22 % of the whole SoC |
| Load average | 1.6-3.1 |
| Free + cached RAM | about 500 MB throughout |
| Low-memory kills of FitBaus | none |
| Bridge process | same PID (26553) throughout, never restarted |
| Bridge health | HTTP 200 on every sample, 17-48 ms, `connected` and `initialized` true |

- `ACTION_VIEW` with a YouTube HTTPS URL opened the exact video only when
  the target package was named; a second launch stacked a second player
  unless `FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK` was used.
- Decoder notes: `OMX.Intel.hw_vd.h264` was not available to mediaserver;
  H.264 fell back to `OMX.google.h264.decoder` and played. VP9 decoded in
  software within the CPU figures above.

## Consequence for FitBaus

FitBaus implements its own YouTube tab with the same technique (SkyTube's
NewPipeExtractor fork and ExoPlayer 2.19.1) instead of depending on the
SkyTube app. See [YOUTUBE-INTEGRATION.md](YOUTUBE-INTEGRATION.md).
