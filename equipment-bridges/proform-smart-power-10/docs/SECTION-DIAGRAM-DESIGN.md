# Audiobook section diagrams: Phase 0 contract

Status: proposed design for implementation; no runtime feature is enabled by this phase.

## Approved experience

- Every eligible whole-section rolling summary can have a visual explanation. No separate setting, visible diagram button, title, or change to the inline summary's fixed bottom anchor, 13sp italic typography, or narration-first collision behavior.
- Start background diagram preparation once the ready summary has actually been laid out visibly, not when the summary request begins or merely when a ready response arrives. A hidden summary does not trigger a new attempt. Repeated layout and playback ticks are idempotent.
- Long press visible summary text to enter a dedicated full-screen diagram presentation. Ordinary tap does nothing; dragging still scrolls the summary. No long-press target exists over hidden summary or narration.
- The diagram occupies the entire app content surface: no telemetry, narration, summary, library/player controls, tabs, or floating players. Audio and exercise telemetry collection continue; only the HUD presentation is suppressed. Keep existing system navigation and safety/mandatory system UI policy.
- An explicit close icon at bottom right and Android Back return to the previous fullscreen narration presentation, restoring its HUD and existing state without reopening the book or resetting the reading controls. No extra dismissal gesture is needed.
- If the diagram is pending, show a centered, quiet loading state, “Preparing visual explanation…”, then replace it in place on success. If generation fails or is unsupported for a selected section, show “Visual explanation unavailable” with Close; background failure is otherwise silent. Older servers without capability retain ordinary summary behavior and do not consume long presses.
- Leaving Books, exiting narration fullscreen, closing/replacing the book, losing authorization/capability, invalidating the summary snapshot, seeking into another section, or moving into a different section closes the diagram, restores host chrome as appropriate, and invalidates pending delivery. A seek within the same unchanged section need not close it. Closing just the diagram leaves the current eligible prefetch running and permits reopening it.

## Ownership and boundaries

Trainer owns the gesture, presentation state, client request lifecycle, and native renderer. Transcriber owns Audiobookshelf authorization, summary identity, diagram generation, parsing, validation, admission, and durable cache. LOBO and other existing OpenAI-compatible providers require no modification. No raw transcript, provider key, model override, custom prompt, or arbitrary destination is accepted from the bike.

Current integration points:
- `BooksReadAlong`, `BooksNarrationViewport`: actual visible summary and existing `BooksSummarySelection`/scope.
- `RemoteBooksSummary`: validated ready result (revision, model, prompt version, transcript digest).
- `BooksContent` and `NativeBridgeActivity`: own fullscreen presentation and HUD visibility. Introduce an explicit presentation mode (ordinary, narration fullscreen, diagram fullscreen), rather than independent competing booleans. Diagram Back/close transitions to narration fullscreen; leaving Books resets ordinary mode. No diagram view owns player, USB or telemetry lifecycle.
- Transcriber `summaries`, `summary_cache`, `summary_provider`, and `server.Service.summary_slot`: authoritative summary/cache identity and currently single shared LLM admission.

No WebView, Mermaid JavaScript runtime, external layout service, script execution, or provider-specific diagram API.

## Versioned protocol

Advertise optional `summary_diagram_api: true` and `summary_diagram_formats: ["flowchart"]` in authenticated capabilities only once Phase 1 is implemented. Absence, wrong type, or unsupported format disables this client feature; support is distinct from active provider configuration.

Proposed endpoint: `POST /v1/section-diagrams`. Same operator/paired device bearer and current `X-Audiobookshelf-Token` as summaries. Exact request keys:

```json
{
  "source_id": "home-library",
  "item_id": "book-1",
  "audio_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "start_ms": 180000,
  "end_ms": 540000,
  "transcript_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "summary_model": "lobo-nano",
  "summary_prompt_version": "section-v1",
  "summary_digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
```

Digest examples are placeholders. The summary digest is SHA-256 of the exact UTF-8 `summary` string returned by the ready summary response, before UI trimming. Use existing identifier, interval, model and digest validation; positive half-open interval at most ten minutes, within manifest. Request body <= 4 KiB. No caller text, retry-transcription option, model selection, credentials in JSON, or recap support in v1.

On every request, including cache hit, revalidate device and book access, source/revision, provider identity and preferred complete existing transcript coverage. Recompute the authoritative summary cache key using existing summary rules; require a nonempty cached summary matching the supplied model, prompt version, transcript digest and exact summary digest. Do not generate or regenerate a summary or schedule transcription as a side effect of diagram preparation. A missing/evicted/changed parent returns a bounded stale/missing-parent error. Provider configuration changes during work invalidate delivery and cache publication; device/source guards must be checked before dispatch and before response. Source credentials never reach the LLM.

Response schema `fitbaus.section-diagram/v1` echoes all request identity fields, plus `diagram_prompt_version: "flowchart-v1"` and `parser_version: "flowchart-subset-v1"`.

- HTTP 200 `state: "ready"`: `cache_hit` boolean, `mermaid` canonical validated source, and `graph` normalized object below.
- HTTP 202 `state: "deferred"`: no graph or partial result; admission temporarily unavailable, retry same identity after bounded server-suggested delay (integer 1–10 seconds).
- HTTP 400 invalid input; 401/403 authorization; 404 unknown item; 409 `diagram_parent_unavailable` or stale identity; 413 bounds exceeded; 429 request capacity; 502 invalid graph/provider error; 503 unavailable/disabled/cache error; 504 timeout. Error bodies contain sanitized codes only. No raw provider output in errors.

Example ready payload fragment:

```json
{
  "state": "ready",
  "cache_hit": false,
  "diagram_prompt_version": "flowchart-v1",
  "parser_version": "flowchart-subset-v1",
  "mermaid": "flowchart TD\nA[\"Present reality\"]\nB[\"Imagined future\"]\nC[\"Unnecessary anxiety\"]\nD[\"Focus on the present\"]\nA --> D\nB --> C\nC --> D",
  "graph": {
    "direction": "TD",
    "nodes": [
      {"id": "A", "label": "Present reality"},
      {"id": "B", "label": "Imagined future"},
      {"id": "C", "label": "Unnecessary anxiety"},
      {"id": "D", "label": "Focus on the present"}
    ],
    "edges": [
      {"from": "A", "to": "D"},
      {"from": "B", "to": "C"},
      {"from": "C", "to": "D"}
    ]
  }
}
```

## Mermaid subset and generation

Use a fixed diagram prompt on the exact authoritative summary alone. Do not send additional transcript text. Ask for the most informative causal, chronological, conceptual or argument structure; preserve language and avoid inventions, predictions and unnecessary complexity. Treat the summary as untrusted data, not instructions. The whole-section diagram has the same possible future-narration spoilers as its parent summary. LLM output is untrusted.

Strict line-oriented subset, no fences or prose in accepted output (optionally unwrap one exact outer Mermaid code fence before parsing, then canonicalize):

```text
flowchart TD
A["First concept"]
B["Second concept"]
A --> B
```

- Header exactly `flowchart TD` or `flowchart LR`. Nodes must be explicitly declared once before edges; identifier ASCII uppercase letter followed by up to seven ASCII uppercase letters or digits.
- Node syntax `ID["label"]`; edge syntax `ID --> ID` or `ID -->|"label"| ID`. Optional normalized edge `label` only when present.
- 2–10 unique nodes (prefer 4–8), 1–16 edges. Directed acyclic, weakly connected graph, no self-loops, duplicate ordered pairs, dangling IDs, or duplicate declarations. Multiple roots and branching/merging supported.
- Labels are plain Unicode text, 1–64 code points for nodes and 1–24 for edges, single line. Reject control/format characters, raw angle brackets, quotes, backslash, pipe and bracket metacharacters in labels; no entity decoding, HTML, Markdown links, image references or executable constructs. Trim outer whitespace, reject empty results. Preserve ordinary multilingual text.
- No classes, styles, directives, comments, links, click handlers, subgraphs, arbitrary shapes, chained edges, semicolon statements, or embedded HTML. No repair by executing or interpreting arbitrary Mermaid. Reject malformed, cyclic or oversized outputs as a whole; no automatic LLM repair/retry.
- Bound raw source and canonical source to 8 KiB UTF-8 each, normalized JSON response to 32 KiB, and model output to existing provider completion limits (1024 tokens, 8000 characters) or stricter. Deterministic canonical source and normalized graph are derived from the same parse. Never render raw Mermaid; retain it only as validated source for internal diagnostics, not user-visible logs.
- Trainer independently validates response schema, exact identity, graph types, bounds, references and acyclicity before layout. It never uses Mermaid source to create an executable view.

## Scheduling, cache, and cancellation

Diagram work is speculative and strictly subordinate to summaries. Phase 1 must provide a shared bounded provider admission coordinator covering summary/recap/management and diagram paths, not a separate unlimited executor or a second concurrent request to the same LOBO. Existing service has one summary slot; merely using a separate Android worker does not provide provider priority.

- Existing summary and explicit provider-management work has priority. Diagrams may start only when foreground/provider work is idle and no high-priority waiter is registered. Busy admission returns deferred without starting a provider call or retaining source credentials. Foreground arrival prevents new speculative admissions and is first to receive the next available slot. Preserve existing bounded HTTP admission and foreground failure semantics.
- One in-flight diagram provider call per service, no durable queue, no parallel speculative inference, no server-side background credential retention. Client uses a separate bounded single-worker controller, at most one current section request and one pending replacement; drop stale work rather than queue a backlog.
- One attempt per displayed summary identity per fullscreen session, with at most three deferred retries (1–10 s server delay, total preparation deadline 180 s from first request). No retries of invalid output or failed inference; explicit re-entry/new snapshot allows a fresh attempt. Cached graph reuse still requires server authorization and parent validation. Poll only current eligible identity; no per-tick retries. An already displayed summary may finish preparation while temporarily hidden by a long narration cue.
- Client cancellation and scope invalidation suppress late results immediately. Before dispatch/cache/response, server rechecks authorization and provider snapshot. HTTP cancellation cannot guarantee that a provider stops inference; an admitted synchronous OpenAI-compatible call may delay the next foreground summary up to its bounded provider timeout, and socket timeout is not a strict process deadline. Phase 1 must demonstrate priority at admission and no speculative retries ahead of waiting foreground work. Do not claim hard preemption without provider cancellation support. If hardware testing shows unacceptable delay, disable automatic speculative admission until a safe policy is qualified, rather than run competing requests.
- Persist only successfully parsed, authorized diagrams in a separate bounded cache (proposed 1024 entries, 8 MiB serialized payload, 24 MiB SQLite page cap, LRU eviction). Key includes full authoritative summary cache identity, exact summary digest, diagram provider identity/cache epoch, prompt text/version, parser version and output limit. No tokens, URLs, raw transcripts, or invalid output in cache records. No cache writes on stale/failed/unauthorized results; storage failure is a bounded error, not unlimited retries. Existing summary cache unaffected. No persistent bike diagram cache.
- Client scope includes playback session object identity, item/source, resolved section bounds, revision, transcript digest, exact summary digest, provider/model/prompt and request generation. Never reuse a result for a different scope just because titles or summary text match. In-memory graph retained only for current summary; stale responses cannot open/repopulate overlay.

## Native rendering

Use a pure Kotlin graph model/validator and deterministic layered DAG layout independent of Android. Native Canvas or equivalent bounded custom View on Android API 22/x86; no new browser/runtime dependency.

Assign levels by longest path from roots, stable within-level order with deterministic crossing reduction, orthogonal or gently curved directed edges and arrowheads; honor TD/LR with readable label wrapping and no clipped/overlapping nodes. Measure text using actual font metrics. Limit layout iterations and graph dimensions, never recurse without bounds. For crossings, route edges behind nodes and keep edge labels distinguishable. Retain accessible textual node/relationship representation (TalkBack or an accessible native fallback). Render plain strings only.

Visual direction: black canvas, rounded charcoal nodes with muted outlines, mustard accents for key paths, warm off-white readable node labels, understated connectors. Use color as decoration rather than sole semantic signal. Fit graph initially with legible typography; if fit would make text too small, support bounded pan/zoom or scrolling, not tiny text. Preserve close affordance outside transform. No diagram animation required for first delivery. No persistent bitmap cache or heavy work on the playback/UI thread. Physical device qualification must check readability while pedaling, touch/scroll vs long press, and return-to-narration geometry.

## Phased delivery

| Phase | Scope | Acceptance gate |
| --- | --- | --- |
| 0 | This cross-repository design and protocol contract only | Review approved UX, ownership, strict bounds and non-preemptible provider caveat; no runtime capability advertised |
| 1 | Transcriber: parser, prompt, normalized schema, authoritative summary lookup, bounded cache and priority admission, optional endpoint/capabilities | Parser rejection suite, authorization/cache identity tests, real HTTP contract tests, foreground-priority concurrency tests, compatibility and provider failure bounds |
| 2 | Trainer: strict client, scope and visible-summary prefetch, long press, fullscreen/loading/failure state and host restoration | Fake transport and lifecycle tests, no duplicate/stale delivery, no request before visible layout, summary/recap unaffected, no telemetry HUD while diagram is open; no final graph renderer yet |
| 3 | Trainer: native layout and renderer | Deterministic layout tests for TD/LR, branching, merges, multilingual labels and maximum graph; no overlap; accessible fallback; physical API 22 visual/touch checks |
| 4 | Integration qualification and polish | Test LOBO and Ollama, slow/failed providers, section transitions, cache hits, old server, gestures, Back, app mode changes, continuous audio and equipment sampling, and narration priority under load |

Merge/deploy Transcriber support before enabling Trainer capability-driven feature. Phase 2/3 may be developed against fixtures but must not expose a ready graph until native rendering and full validation are available. Keep recap and book recap dormant and unchanged.

## Required negative regressions

- No graph generated for a pending, empty, failed, invisible-never-displayed or stale summary. A short/long/short cue transition must not move the summary anchor or create extra diagram requests.
- No telemetry visibility while diagram is presented, yet no suspension of exercise sampling, connection, audio playback or statistics. Back and close restore HUD and exact narration mode. Section changes close old diagram even if a delayed response arrives.
- No model calls for missing/changed parent, unauthorized/revoked book/device, or cache hit. No arbitrary provider, source URL or prompt. No silent fallback to unverified TLS.
- Reject malformed graph, script/HTML/directive, unsupported syntax, duplicate/dangling edges, cycles, excessive nodes/bytes and mismatched identity; test Unicode code-point and UTF-8 limits.
- Verify admission order with simultaneous summary and diagram demand, one provider call at a time, bounded deferred retries, no stale-client delivery, and no foreground regressions. Report non-preemptible provider behavior explicitly.


## Phase 2 implementation

Trainer now recognizes the optional diagram capability, retains the verified summary source identity, and checks the exact summary digest and response identity. The HTTP client independently validates graph bounds, labels, references, connectedness and acyclicity; Mermaid source is never rendered. The response body is bounded to 32 KiB. The client allows one initial request and at most three deferred retries, checking its 180-second elapsed budget between requests (socket reads are not hard process deadlines).

A visible-summary draw callback with a text generation guard initiates the bounded worker. The request scope rejects duplicate attempts and obsolete results, checks the encrypted Transcriber connection record without decrypting on playback ticks, and is invalidated with the parent summary. The long-press target is the summary TextView only. The dedicated fullscreen diagram presentation hides the HUD, narration and player chrome, places the diagram surface above floating media, and restores narration mode on Close or Back. It does not stop audio or telemetry collection. Older servers retain normal summary behavior. Phase 2 intentionally displays a loading, unavailable or ready-placeholder surface only; no graph is displayed until the native renderer is added in Phase 3. Physical gesture and fullscreen restoration qualification remain outstanding.


## Phase 3 implementation

The ready state now presents a native Canvas flowchart instead of the placeholder. A pure Kotlin layout assigns longest-path ranks, inserts virtual slots for long edges, performs three deterministic bidirectional barycenter sweeps, and allocates connector lanes and separate label bounds between layers. TD and LR both use the same axis-based geometry. Real node boxes and edge label boxes do not overlap, and routes avoid intermediate node interiors. Connector crossings may remain for nonplanar or densely connected graphs; the layout does not promise a crossing-free drawing.

The API 22-compatible view measures and wraps plain multilingual labels with Android StaticLayout, renders rounded charcoal nodes, mustard terminal accents and directed connectors on black, and exposes node labels and directed relationships through an accessibility description. Node text is 20sp and edge text 16sp at native scale. Initial fit never falls below 80%; larger graphs remain navigable by dragging and pinch zoom (0.8x–2.5x). Oversized graphs open at the start of the main flow axis. The close control is outside the graph's transform and remains at the bottom right. No WebView, Mermaid execution, third-party renderer, or new dependency is introduced. Graph geometry is prepared once per displayed graph, bounded by the validated 10-node/16-edge contract; drawing reuses it. Failed layout falls back to the existing unavailable presentation.

Unit regressions cover deterministic TD/LR geometry, branching/merging and long routes, node/edge-label separation, intermediate-node avoidance, maximum supported graph cardinality, invalid sizes and cycles, and viewport bounds. Native font shaping, real-screen readability, accessibility and touch navigation still need physical console qualification in Phase 4. No Transcriber or LOBO changes are required.


## Phase 4 repository hardening and qualification

See [section diagram qualification](SECTION-DIAGRAM-QUALIFICATION.md) for baseline CI evidence, additional automated regressions, and the outstanding physical console/LOBO/Ollama acceptance matrix. The visible-draw gate, live playback position checks and loading indicator are hardened without changing provider or narration behavior. Physical qualification is not complete.
