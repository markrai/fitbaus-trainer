# Transcriber workspace phase 3: compatibility and maintainability

Date: 2026-11-26

## Review scope

Trainer main at `ad650985f7917072698a0cfa72b3f54acc6331cd` includes #139, #140, #141, #142 and #143. Transcriber #32 at `845385e0dbb64b18b223b4d06f758666716c8991` is reviewed as a proposed server change, not as deployed main. Transcriber main remains `3e6348f71a5f9ee4216b602e3aa764c1b272946d` at review time.

Review the workspace, shared model presentation, summary provider workflow/actions, API adapter, LAN discovery, provider settings and trust registry. This is a focused qualification of the UX consolidation, not a general architecture rewrite.

## Evidence and disposition

| Area | Review result |
|---|---|
| Workspace navigation | One parent scroll surface, inline tabs, collapsed connection form. Standalone audiobook preparation reuses the model view. |
| Request lifecycle | Selected tab owns workers, polling and discovery; close cancels local pending work and ignores late UI completions. Connection requests use generation guards. Server operations already accepted can still finish. |
| Model readiness | Installed, qualified and memory-admitted are distinct; failures retain last reported states with disabled controls. Connection readiness is last-check, not continuous monitoring. |
| Provider identity | Saved provider and proposed endpoint/model are separate. Save needs matching candidate/test/consent and confirmed response. Uncertain mutations require reload. |
| Authorization | Pairing and scoped administrator grant are separate. Code entry is progressive; no persisted AUTH input or new bike credentials. Lock changes uses the existing cancel operation. |
| LOBO trust | Server-owned exact-private-IPv4 endpoint registry, bounded to 16, stored atomically with configuration. TLS remains hostname/IP and CA verified. No trust from LAN advertisement. Revocation requires grant, confirmation and inactive endpoint. |
| Compatibility | Older servers omit remembered inventory, preserving current-provider reuse and first-time AUTH. Trainer minSdk 22 and x86 target unchanged. View/keyboard behavior needs physical acceptance. |

## Narrow hardening in phase 3

- An action created from one workflow state previously could be admitted after an edit to the draft or selected model (only forget was explicitly snapshot-bound). All actions now require the exact captured workflow state at begin; existing typed completion ticket guards remain. Tests cover stale discovery and stale inference-test requests.
- First-time LOBO discovery previously checked the returned endpoint only, unlike remembered discovery which checks pinned HTTPS metadata. Both paths now require matching private IPv4 HTTPS endpoint, custom CA, no API key and no HTTP opt-in before accepting the candidate. Reject mismatched submitted endpoint against the current LOBO draft before a network request.
- Canonical LOBO endpoint validation now applies to draft admission and the first-time API request, consistent with the server. Rejected addresses do not enable discovery or display the AUTH field. The regression tests cover public addresses, incorrect ports, HTTP, wrong path and canonical trailing slash normalization.

No new worker, network client, settings format, permission, dependency, version or public API is introduced in Trainer phase 3.

## Automated baseline

- [Trainer #143 CI](https://github.com/markrai/fitbaus-trainer/actions/runs/45854629121), attempt 2: success. Trainer 1,623 tests passed, zero failed/skipped/cancelled; native equipment protocol, bridge release unit tests, USB probe and arcade tests passed; Gradle metadata reported minSdk 22 and targetSdk 34. Attempt 1 failed while installing CMake with a connection reset, before native build/test.
- [Transcriber #32 CI](https://github.com/markrai/fitbaus-transcriber/actions/runs/45852588658): tests and container jobs succeeded. 157 tests ran, one skipped; tests for remembering devices across switches/disable/restart and a real TLS handshake rejecting a replaced certificate passed.
- Phase 3 adds three focused JVM regression tests. CI on the phase 3 head is required before merge; the prior baseline is not evidence that the new head passes.

## Release and physical acceptance boundaries

Transcriber #32 must be merged and deployed for inactive-device reuse or revocation. Its v2 settings format containing remembered pins is not readable by older versions; back up summary-provider.json before upgrading. An address change requires verification again. Registry capacity is intentionally finite; revoke inactive entries to free capacity. Trust is CA-based, not leaf-certificate pinning; rotation under the same trusted installation CA remains valid if normal TLS validation succeeds. No device-name trust or authentication bypass.

The server grant may remain live until expiration after a locally closed view if cancellation has not reached the server; the client discards the grant and secrets. An accepted remote operation is not guaranteed to be undone by leaving the screen. Local input state and remote settings are not a distributed transaction. Storage rename is atomic, not an exhaustive power-loss qualification. No physical LOBO devices, bike display, keyboard, LAN discovery, signed APK or installation tested here. NSD behavior on the old console and actual card widths/scrolling remain hardware acceptance items.

With green phase 3 CI and server deployment, close the planned UX implementation. Further changes should be driven by reproduced issues or a specific feature request, not speculative refactoring.
