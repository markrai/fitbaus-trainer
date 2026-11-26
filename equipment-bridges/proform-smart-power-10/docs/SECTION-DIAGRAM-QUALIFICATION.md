# Section diagram qualification (Phase 4)

## Scope and evidence

Baseline: Transcriber PR [34](https://github.com/markrai/fitbaus-transcriber/pull/34), CI [373](https://github.com/markrai/fitbaus-transcriber/actions/runs/45878661977); Trainer PR [150](https://github.com/markrai/fitbaus-trainer/pull/150), CI [566](https://github.com/markrai/fitbaus-trainer/actions/runs/45880967349); Trainer PR [151](https://github.com/markrai/fitbaus-trainer/pull/151), CI [568](https://github.com/markrai/fitbaus-trainer/actions/runs/45881904461). All three baseline PRs are merged and those CI runs passed. This qualification change is not a physical console or live provider pass.

Phase 4 hardening:
- A generation-scoped, distinct-ticket draw gate consumes a visible eligible summary exactly once after successful callback admission. Repeated redraws no longer post speculative work. Hidden, cancelled or superseded draws cannot consume a replacement. Legacy servers do not post diagram callbacks.
- Request admission, long press and completion use the current playback position rather than the last rendered tick. A response crossing a section boundary cannot open or replace the current diagram.
- Loading has a centered native mustard indeterminate indicator. It is stopped when hidden, closed, failed or ready, and does not overlap the close control.
- Tests add 128 reproducible connected DAGs rendered in TD and LR (256 layout cases), mixed node and label dimensions, multiple roots, stale/cancelled draw tickets, cache identity failures, deferred deadline, and non-retryable provider errors. Existing geometry, authorization and narration-layout checks remain.

## Automated gates

Run Trainer's existing Native Bike Bridge CI unit-test/build/lint jobs and Transcriber's existing Python suite. Do not waive warnings or weaken a prior assertion. Relevant JVM suites are `RemoteBooksDiagramTest`, `BooksDiagramLayoutTest`, `BooksInlineSummaryAttemptTest`, `BooksSummaryPresentationTest`, and existing summary/recap and transport tests. Relevant Transcriber suites are `test_section_diagrams` and `test_summary_api`. The new regression tests must pass before calling Phase 4 repository qualification complete. These tests exercise bounded geometry and HTTP fixtures, not Android touch dispatch, actual glyph shaping, or real provider output.

## Physical console and provider acceptance

Use a test audiobook with short and long narration cues and at least two adjacent resolved sections. Use a configured paired Transcriber with prepared transcripts. Run the same exercise on the physical API 22 console with LOBO and with an OpenAI-compatible Ollama endpoint; use ordinary provider settings and explicit existing egress consent. Record APK/version, Transcriber version, provider/model, elapsed summary/diagram timings, cache-hit observations and pass/fail per case. Do not include audiobook text, access tokens or provider credentials in logs or issues.

| Case | Procedure | Acceptance |
| --- | --- | --- |
| Cold start | Enter fullscreen narration for an uncached section. | Summary becomes visible before the first diagram request. Normal audio and bike sampling continue. No diagram UI until a long press. |
| Hidden summary | Use a long cue that occupies the fixed summary region, then a short cue. | No speculative request for a never-displayed summary. Narration is not displaced or resized. The first eligible visible draw starts one attempt; subsequent cue changes do not reissue it. |
| Loading and dismissal | Long press while diagram inference is pending; close, then reopen. | Fullscreen black loading surface with no HUD, narration, floating media or player controls. Close/Back restores narration and HUD; reopening shows current loading/ready state without a new request. |
| Ready and warm cache | Long press after a valid graph is ready; reopen the same section in a new fullscreen session. | Ready graph uses native view. Warm server hit does not call the model again; authorization and parent identity still checked. |
| Layout and touch | Exercise both directions, branch/merge, long labels and larger graphs. Drag and pinch, including edges of viewport. | Readable labels, no node/label box overlap, no route through node interiors, reachable content, fixed Close control, no unintended gesture on ordinary tap or summary scrolling. Crossings may remain. |
| Section transition | Let playback cross a section boundary while loading or viewing a graph; seek within and across sections. | Old diagram closes at transition; no late old response opens or overwrites the replacement. Same-section seek does not unnecessarily discard current result. |
| Connection and mode | Exit fullscreen, minimize, change app tab, replace book, or clear pairing while a request is pending. | Pending UI delivery invalidated; ordinary host chrome restored. No old graph appears on return. |
| Old server | Use a server without diagram capability. | Normal summary and narration unchanged; no diagram request or active long-press action. |
| Failed provider | Use a disconnected provider or invalid completion on a test instance. | Failure is silent in narration; explicit long press shows unavailable, not a retry loop. |
| Foreground priority | While a diagram is pending or running, cross into a section requiring a new summary. | No concurrent inference to the same provider. Foreground gets priority at the next admission. Record observed delay; if unacceptable, do not qualify automatic speculative admission. |
| Sustained use | Play through several sections while pedaling, open/close diagrams repeatedly. | No audio interruption, sampling gap, unbounded work queue, excessive memory growth or HUD restoration failure. |

A provider call already admitted for a diagram is not guaranteed preemptible by a foreground summary. The server allows one bounded foreground waiter behind it; socket timeouts are not hard process deadlines. Measure this with both actual providers before declaring latency acceptable. A ready client graph is session-scoped; remote authorization is checked on server requests, not continuously polled while viewing an already-returned result.

## Result status

- Baseline automated CI: passed (links above).
- Phase 4 automated regressions: pending new CI.
- Physical API 22 console, LOBO and Ollama: not run.
- Release qualification: incomplete until physical and real-provider results are recorded. No claim of hardware readiness or measured rendering/inference performance is made by this PR.
