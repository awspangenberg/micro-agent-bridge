# Windows standalone Micro host

The standalone host owns the Codex Micro directly. It supplies three sets of six
task keys: Codex on layer 1, Claude on layer 2, and Mixed on layer 3. It uses one
reader and serializes complete HID RPC requests. It does not modify Codex or need
an inspector. This is source for hardware evaluation, not a qualified binary release.

## Run

Requires Windows x64, Node.js 22+, Python 3.10+, and Windows PowerShell 5.1.
Run from a normal PowerShell terminal in this repository; no administrator access
is needed. Python must be on PATH as `python`, or pass `--python <full-path>`.

```powershell
npm ci
npm run windows:doctor
npm run windows:status
```

`doctor` enumerates devices and checks metadata without opening a HID reader or
changing configuration. `status` attempts exclusive ownership, reads
`device.status`, and releases the connection.

If exclusive access fails with Windows error 32, quit Codex and Work Louder Input.
Run this in a separate terminal, then reopen Codex after the host reports running:

```powershell
npm run windows:start -- --configure-profile --consent
```

This first-run command backs up the profile, maps its task rows, verifies the
write, and starts without releasing ownership in between. Later starts use:

```powershell
npm run windows:start
```

`windows-start.cmd` is an equivalent launcher that forwards options. Ctrl+C clears
the lighting banks and releases the device; the native app can reacquire it.
The host does not install a background service or start at login.

## Ownership and connections

Stock `node-hid` Windows handles permit sharing. This host uses it only for
enumeration. Its C# helper uses `CreateFileW` with share mode zero, validates
VID `303A`, PID `8360`, vendor usage page `FF00`, and 64-byte reports, then starts
one reader. Acquisition failure releases acquired handles before any RPC.
There is no shared-access fallback. A per-user lock also prevents parallel hosts
using different state directories.

After acquisition, Windows denies competing reads/writes on that RPC interface.
Codex can remain open for task status and navigation while its native Micro
connection is unavailable. Native Micro action handling is not active. Read/write
denial does not imply denial of metadata-only handles or every HID feature request.

**Use one Micro and one connection, USB or Bluetooth. Do not add or switch
connections while running.** Startup refuses multiple RPC interfaces. Topology
checks stop the host on connection changes, but discovery of a newly added
interface is not atomic with another app opening it. Exclusivity does not extend
to future USB/Bluetooth interfaces.

Over Bluetooth the device identity is its Bluetooth address, which differs per
Work Louder Bluetooth channel or pairing. Ownership records and backups are bound
to that identity, so a different channel refuses with `Profile ownership device
identity mismatch`. Switch back to the original channel, or use a separate
`--state <directory>` for the new identity and keep the original directory for restore.

Disconnects, invalid reports, failed writes, RPC timeouts, and Windows suspend/
resume notifications release ownership and cancel queued work. Writes are never
replayed automatically. A long polling gap also stops the host before fresh
requests. Without `--supervise`, restart explicitly after a reconnect or sleep.

With `start --supervise`, the host waits for the **same** Micro (same identity) to
reappear and then performs a complete fresh start: exclusive open, topology guard,
profile verification, and repaint from current task state. Nothing from the old
connection is replayed. Profile, ownership, identity, and consent problems still
stop the host for a person to resolve; a different Micro identity is never adopted.
If Codex reopens the device first after a reconnect, the exclusive open fails and
the host keeps retrying until Codex releases it; quit Codex to hand it back.

## Tasks and controls

Pin local tasks in the app sidebars. Assignments retain their positions; newly
observed pins use the recent-pin allocator. Mixed starts with Codex/Claude
interleaving. A task key opens its validated desktop URI.

Codex state comes from its local named pipe, including what the active turn is
doing (plan mode, reasoning, command, file change). Claude state comes from its
process registry (`busy` for a live same-user process, executable, and creation
time) plus optional owned hooks. Completion is never inferred from silence.

Colour says what a task is doing; animation says how urgent it is:

| State | Colour | Animation |
|---|---|---|
| Needs approval | red-orange | fast flash |
| Asking a question | magenta | fast flash |
| Planning | violet | slow breath |
| Running tests | yellow | slow breath |
| Running a command | cyan | slow breath |
| Editing files | teal | slow breath |
| Working (other) | provider: blue Codex, amber Claude | slow breath |
| Completed | green | solid |
| Error | red | solid |
| Disconnected | red | slow breath |
| Inactive (idle/unknown) | faded provider colour | solid |

Test runs are recognized from the command in memory only; the text is never
stored or sent. The background ring summarizes all 18 slots: fast flash in the
approval or question colour if anything needs you, red for an error, a slow sweep
in the provider colour (white if both) while anything works, otherwise off. Key
backlighting stays off. The terminal prints slot titles and state changes.

Claude detail beyond working needs the owned hooks. They merge only their own
entries into `~/.claude/settings.json` (backed up in the state directory) and
record only state for allowlisted, assigned local sessions whose live process
identity and ancestry match:

```powershell
python src/claude_hooks.py --install --state "$env:LOCALAPPDATA\Micro Agent Bridge\standalone"
python src/claude_hooks.py --remove --state "$env:LOCALAPPDATA\Micro Agent Bridge\standalone"
```

Use the same `--state` directory the host runs with.

Metadata errors retain assignments but disable navigation and display unknown
until the reader recovers.

### Remote Claude sessions

Claude Code tasks running on another machine appear here as pinned bridge
sessions (`session_…`) with no local process. While such pins exist, the host
looks for them on reachable machines without installing anything there:

- candidates are concrete `Host` aliases in `~/.ssh/config` (Git hosting excluded),
  online Tailscale peers on Linux/macOS with Tailscale SSH, and any
  `--remote <ssh-alias|user@host>` targets; `--no-remote-discovery` disables the
  automatic candidates;
- each candidate gets one `ssh -o BatchMode=yes … 'sh -s'` session that streams a
  read-only probe (`src/remote-sessions.sh`) every two seconds: session ID, bridge
  ID, registry status, and whether its process is alive. No paths, names, prompts,
  or transcripts leave the machine and nothing is written there;
- Tailscale peers are checked against the host keys published by the tailnet,
  pinned in the state directory, with strict host-key checking; `~/.ssh/known_hosts`
  is not modified. Set the remote user with a `Host … User …` entry in
  `~/.ssh/config`;
- a pin shows a remote state only when exactly one live session on a fresh host
  carries its bridge ID (`busy` working, `waiting` needs you, `idle` inactive). A
  host serving no pins is closed after 30 s and rechecked every five minutes;
  failures back off up to five minutes, and a known host going silent shows
  disconnected.

Logins that need interaction (passwords, Tailscale SSH check mode awaiting browser
approval) simply fail and back off. Claude Code cloud sessions run on no machine
this PC can reach, so they stay inactive; their live status exists only in the
claude.ai service, which the host never contacts.

### Lower controls

On the Mixed layer, after a Claude task is opened with its Mixed key, the lower
controls act on that task in the Claude desktop app: ACT14 Allow, ACT15 Deny,
ACT19 New, ACT04/ACT05 Back/Forward, ACT20 sidebar. Each press checks, through UI
Automation, that the foreground window is the installed Claude app and that its
document URL names exactly that session (navigation or bridge ID), then invokes
the single enabled, visible button with the expected label. Anything else (zero or
several matches, another task in front, an expired 15-minute binding, a different
task in the slot) does nothing. No keystrokes are injected and no shell command is
substituted. A performed Back/Forward/New releases the binding.

Codex windows expose only an internal `app://` document URL with no task identity,
so a Codex action could not be proven to reach the selected task; Codex tasks and
layer 1's native controls stay inert. Microphone, fork, FAST, dial, and plan
controls have no task-bound desktop control and do nothing. Existing lower
mappings are preserved; newly created layers have blank lower controls.

## Profile backup and restore

Profile changes are opt-in. `start` alone leaves the profile unchanged, so AG00–17
must already be mapped for task presses. Configuration owns only the first two
task rows in profile 0, layers 0–2. Existing names and other controls remain;
missing layers are created as Claude and Mixed. Automatic app mappings
(`linkedApps`) prevent configuration.

```powershell
npm run windows:setup -- --consent
npm run windows:restore
```

These commands acquire/release ownership and may require quitting the native app
first. Backups, ownership records, and slot metadata live under
`%LOCALAPPDATA%\Micro Agent Bridge\standalone`. `--state <directory>` overrides
this; retain the directory for restore. Exact original bytes are backed up before
the first write and bound to the device identity.

Restore preserves later edits outside the owned rows. Conflicting edits refuse
restoration. Startup verifies previously configured rows against the device
without rewriting them. Interrupted writes leave a pending transaction: retry setup with
`--consent` or restore using the same device and state directory. Unrecognized
device bytes refuse recovery. Keep all backups until restoration is verified.

Other overrides: `--home <user-directory>` and `--claude-data <data-directory>`.
Claude discovery checks the conventional Roaming profile and a single matching
Microsoft Store profile; ambiguous profiles need an explicit override. Metadata
and backups stay on this machine. No network listener or upload is created.

## Validation

If Claude activity updates but an active Codex chat stays `unknown`, the Codex
subscription may have been announced before its renderer was ready. The host
reannounces on renderer connection and follower requests, and retries missing or
notLoaded snapshots every five seconds. Initialization also has a deadline, so an
unanswered handshake cannot leave the connection stuck indefinitely.

Source changes require a host restart. Quit Codex/Input while the old host still
owns the device, stop that host with Ctrl+C, start it with the same `--state`
directory, wait for exclusive-access confirmation, then reopen Codex. A host
launched from a packaged app may have its state redirected into that app's
`LocalCache\Local` directory; preserve the actual directory and backups when
changing launch context. Profile setup is unnecessary for a status-code repair.

```powershell
npm run test:windows
npm run check
```

Tests cover the real PowerShell/C# helper protocol without opening hardware,
simulated fragmented HID RPC, deadlines, cleanup, profile transactions, task
selection, Windows inventory fixtures, and the proposed named-pipe service client.

Physically verified on a Bluetooth Codex Micro (firmware 0.6.2) with Codex
26.1013 and Claude desktop 2.42304: exclusive ownership while Codex stays open
(Codex's own attempts fail harmlessly), profile backup/verification without
rewrite, per-key slot mapping on all three layers, task keys opening the exact
Codex and Claude tasks, the palette and ambient ring tracking Claude hook activity
and Codex turn activity, and Ctrl+C stopping the host. Still to observe on hardware:
specific Codex activity colours (test/command/edit) during a live turn, empty-slot
and key-release no-ops, `--supervise` recovery after a real Bluetooth drop or sleep,
remote status against a host running Claude Code, and the Mixed lower controls on
an actual permission prompt.

The [proposed native service extension](windows-service.md) is a separate design
that the Store app cannot currently load. This standalone host does not depend on it.
