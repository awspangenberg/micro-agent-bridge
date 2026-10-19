# Proposed Windows Micro service extension

The client and host adapter are implemented and tested over Windows named pipes.
**The installed Codex Store app cannot load this adapter. This is not a working
Windows desktop helper release.** Codex must integrate the host adapter into the
process that already owns its Micro device. No app files are modified and no
inspector or second HID handle is used.

On 2026-10-17, Store package `OpenAI.Codex` `26.1013.4894.0`, app
`26.1013.40934`, accepted the normal IPC initialization request and returned
`no-client-found` for `micro-agent-bridge/initialize`. The live probe requested no
lighting changes. These extension method names are proposed by this project;
they are not an official OpenAI API.

## Run the client

From the repository directory, with Node.js 22 or later:

```powershell
npm run test:micro
npm run micro:doctor
npm run micro:status
npm run micro:watch
```

`doctor` checks negotiation without device I/O. `status` reads device status after
negotiation. `watch` subscribes to input, layer, connection, and invalidation
events; Ctrl+C releases the session. All use `\\.\pipe\codex-ipc` on Windows.
An unavailable host produces JSON with `available: false`, an error code, and
exit status 1. No configuration or profile is changed by these commands.

The task-status client in `codex-ipc.mjs` now uses the Windows pipe as well. The
existing `control.mjs` installer, supervisor, Python hooks, and desktop action UI
are still Mac/Linux implementations. This change does not enable them on Windows.

## Host integration contract

`src/micro-service.mjs` exports:

```js
createMicroBridge({getState, request, getAllowedBanks, maxPending: 8})
```

The host supplies these callbacks:

| Callback | Required behavior |
| --- | --- |
| `getState()` | Return the existing service's current state, including `status`, `transport`, and `controlPlaneStatus` when available. |
| `request(method, params)` | Submit one complete RPC through the existing native device request queue, with its normal deadline and connection guards. Resolve to the unwrapped result, reject native RPC errors. This callback is only called with `v.oai.thstatus` or `device.status`. |
| `getAllowedBanks()` | Read host-owned consent for the connected device. Return a subset of `[6, 12]`, defaulting to `[]`. IPC parameters must never set this consent. |

Create **one bridge per native service**, not one per IPC client. Native app writes
must share the same underlying complete-request queue. The bridge's own serial
queue orders extension calls; it cannot serialize a separate device writer.
The host must map its current SDK response/error shape to the callback contract.

For each authenticated IPC connection, call:

```js
const session = bridge.openSession({
  localUserVerified: true,
  send(event) {
    sendToThisConnection({
      type: 'broadcast',
      method: 'micro-agent-bridge/event',
      params: event,
      version: 1,
    });
  },
});
```

Here `sendToThisConnection` is the host's existing targeted IPC sender. It must
bound its output queue and close an unresponsive connection. Before passing
`localUserVerified: true`, the host must verify a local, same-user peer using OS
credentials. A claimed `sourceClientId`, pipe name, or this boolean received in
a client message is **not authentication**. Reject remote peers. If integrating
a separate pipe, enforce its user ACL and remote-client rejection in the native
listener. This package intentionally creates no production listener or ACL.

Register the exact methods in the next section with the host's IPC router and
route each request to `session.handle(message.method, message.params)`. Return
its value using the existing `response` envelope with the matching `requestId`,
`method`, `resultType: 'success'`, and `result`; route failures as IPC errors.
Keep this session bound to the authenticated connection, and await
`session.close()` on connection loss. Release errors must be surfaced or logged.

Fan out the service's **already parsed** notifications to
`bridge.publish('v.oai.hid', params)` and `bridge.publish('kb.radial', params)`.
Call `bridge.invalidate('connection-changed')` for disconnects, replacement
devices, and transport changes, before processing new device requests. Notify
`suspend`, `resume`, and `consent-changed` the same way. Await `bridge.dispose()`
before the host disposes its device connection. No native reader or listener is
replaced by this module.

The installed app has no loader/registration point for these calls. Adding them
requires Codex desktop source access or a vendor-provided extension hook. The
named-pipe test host in `tests/test-micro-client.mjs` is synthetic test code, not
a mechanism for attaching to the running application.

## Protocol version 1

Transport uses the existing Codex IPC envelope: a four-byte little-endian byte
length followed by UTF-8 JSON. The Micro client limits frames to 1 MiB, pending
requests to eight, and request/connection deadlines to three seconds by default.
The host must enforce equivalent framing and input bounds in its existing IPC
listener. First perform ordinary Codex IPC `initialize` with version 0 to obtain
a `clientId`, then use version 1 and that `sourceClientId` for extension requests.

| Method prefix `micro-agent-bridge/` | Parameters | Result |
| --- | --- | --- |
| `initialize` | `{protocol: 1, banks: []}` | Protocol, granted banks, allowed banks, event names, `profileWrite: false` |
| `status` | `{}` | `{status, transport, layerIndex}`; index is zero-based or null |
| `lights` | `{frame: [...]}` | `{sent: true}` |
| `subscribe` | `{events: ['input', 'layer', 'state', 'invalidate']}` | `{subscribed: [...]}`; replaces the subscription |
| `release` | `{}` | `{released: true}` after cleanup |

For lighting, request `[6]`, `[12]`, or `[6,12]` during initialization. A bank has
one owner until that session's cleanup completes. An initialization that cannot
claim every requested bank claims none. Empty banks allow read-only diagnostics.
Consent is rechecked immediately before each queued write.

Each frame contains exactly six distinct IDs in one granted bank. Color `c` is
an integer from 0 to `0xffffff`; brightness `b` is finite and at most 0.65; effect
`e` is one of 0, 1, 4, 6; speed `s` is finite from 0 to 1. `sk` and `sa` are zero.
Native slots 0–5 and generic RPC/file access are rejected. Profile reads/writes
are not exposed: the optional profile feature remains unimplemented, and the
custom key mappings must already exist before task-key use.

Events expose only key/action, layer index, connection state/transport, or a
fixed invalidation reason. Prompt/tool content and arbitrary native event fields
are discarded. Session shutdown clears only banks it wrote on the current
connection generation, while consent remains valid. It never clears a replacement
device's bank or replays frames after reconnect. A write already submitted to the
native queue may finish after invalidation; cancellation depends on the native
service. Pending extension writes are rejected before submission.

## Programmatic use

After the host integration is available and the user has granted banks 6 and 12:

```js
import {MicroServiceClient} from './src/micro-client.mjs';
import {frame} from './src/slots.mjs';

const micro = new MicroServiceClient();
try {
  await micro.connect({banks: [6, 12]});
  micro.on('input', event => console.log(event.key, event.act));
  micro.on('layer', event => console.log(event.layerIndex));
  await micro.subscribe(['input', 'layer']);
  console.log(await micro.status());
  await micro.lights(frame(['working', 'idle', 'empty', 'empty', 'empty', 'empty'], 6));
  // Keep this session open while the owning supervisor is running.
} finally {
  await micro.close();
}
```

A timeout or malformed frame closes the entire client session and rejects pending
requests. Reconnect explicitly with `connect()` and reacquire any desired banks;
the client never automatically retries device writes.

## Validation boundary

Tests exercise actual Windows named-pipe transport and synthetic device callbacks,
including malformed frames, deadlines, exclusive ownership, consent revocation,
sleep, connection changes, event filtering, and cleanup. They do not qualify
firmware, physical lighting, hardware key events, the Store app's ACLs, or native
queue integration. Those checks require an integrated host build and a Micro.
