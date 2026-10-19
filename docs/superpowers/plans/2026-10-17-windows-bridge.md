# Windows Micro bridge implementation plan

**Goal:** Implement the three required operations in the Windows request: owned
lighting banks, sanitized input/layer events, and device status, through the native
service's existing request queue.

**Architecture:** A transport-independent host adapter runs inside the application
that already owns the device. A Node client uses the existing length-prefixed
Codex IPC envelope over the local Windows pipe (or Unix socket). The proposed
`micro-agent-bridge/*` methods require explicit host integration; they are not
present in Store build 26.1013.4894.0. No inspector, app patch, or HID handle is used.

**Constraints:** Node 22+, no new dependencies; native IDs 0–5 never writable;
grants come from host-side user consent; no generic RPC, task content, or profile
write endpoint. The host must authenticate local, same-user connections before
opening a session. Optional profile ownership is deferred, so layers must already
be configured. Existing Mac/Linux attachment remains separate.

- [x] Add service contract tests for explicit consent, exclusive banks, native
  queue calls, event projection, revocation, bounded work, and cleanup.
- [x] Implement `src/micro-service.mjs` and shared validators in
  `src/micro-protocol.mjs`; run the service tests.
- [x] Add real named-pipe/socket tests for client negotiation, fragmented frames,
  deadlines, unsupported hosts, disconnects, and event subscriptions.
- [x] Implement `src/micro-client.mjs`, shared IPC endpoint selection, and a
  read-only diagnostic CLI. Update the existing Codex task client endpoint.
- [x] Run Windows tests, existing portable tests, and publication checks. Probe
  the installed app without device writes. Document upstream integration and the
  difference between tested protocol behavior and hardware qualification.

Execution is inline on the existing clean `windows-support` branch. The existing
repository plan specifies sequential work without subagents. Source changes stay
local for review.

The live app returns `no-client-found` for the extension; the diagnostic reports
`MICRO_UNAVAILABLE`. Host registration and physical acceptance are blocked, not
completed. The legacy full suite requires Unix `python3`/`fcntl`; the Node tests
and the new named-pipe tests are independently runnable on Windows.
