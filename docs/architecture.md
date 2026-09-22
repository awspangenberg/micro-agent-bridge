# Architecture and privacy

`slots.mjs` implements independent stable recent-pin allocations. `daemon.mjs`
coordinates discovery/status and routes task keys independently from status polls.
Platform adapters discover apps and confirm task identity. `remotes.mjs` supervises
one bounded SSH observer per explicitly configured host. Protocol version 1 uses
newline-delimited JSON with an increasing sequence; local receive time determines
freshness, avoiding false disconnects from clock skew.

The narrow in-memory Codex adapter obtains the existing Micro service and reuses
its complete-request HID queue. It does not open another device handle, replace
native methods, or inject app actions. The temporary loopback inspector is owned
and closed before device I/O; an occupied inspector port prevents attachment.
No app bundle is edited. This is a version-dependent integration, not a public
vendor hardware API. A second HID reader can crash the native app, and independent
writers can corrupt multipart requests; neither is permitted.

Task metadata (provider/host/native/navigation ID and title) supports discovery.
Status storage/SSH transfer contains only identities, state, timestamps, sequence,
and validated process identity. Prompt/tool contents are never retained or
transferred. Metadata readers may inspect local transcript records to locate native
continuation/Stop metadata; transcript files are never packaged or uploaded.
Private state uses per-user permissions. No telemetry or automatic log uploads.

Hook installation merges only owned commands into existing settings. Allowlisting
expires when the supervisor disappears. Foreground/layer/connection changes revoke
action authorization. Unknown identity never authorizes approval or other actions.

Public builds contain only source, synthetic tests, bundled open-source runtimes,
and documentation. No user profiles, host mappings, private backups, auth files,
keychain profiles, or live acceptance logs belong in the repository or installers.
