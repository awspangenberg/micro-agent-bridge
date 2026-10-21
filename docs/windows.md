# Windows standalone Micro host

The standalone host owns the Codex Micro directly. It supplies three sets of six
task keys: Codex on layer 1, Claude on layer 2, and Mixed on layer 3. It uses one
reader and serializes complete HID RPC requests. It does not modify Codex or need
an inspector. The installer and the source tree are for hardware evaluation; neither
is a qualified release.

## Install

The release installer (`Micro-Agent-Bridge-<version>-windows-x64-setup.exe`) needs
Windows 10/11 x64, Windows PowerShell 5.1, .NET Framework 4.8 and the Microsoft Edge
WebView2 Runtime. Windows 11 includes all of them; current Windows 10 includes all
but sometimes WebView2, and the installer warns if it is missing. It bundles
Node.js and Python, installs per user to
`%LOCALAPPDATA%\Programs\Micro Agent Bridge` without administrator access, and is
not Authenticode-signed. Verify it against `SHA256SUMS` before running it.

### Onboarding

When installation finishes, **Micro Agent Bridge** opens a setup window. Each step
checks live state, so you can close setup and reopen it later from the Start menu
(**Set up Micro Agent Bridge**, or *Set up again* in the dashboard).

1. **Welcome:** checks that Codex and Claude are installed, counts pinned tasks, and
   checks that a Group Policy doesn't block the PowerShell helper.
2. **Connect:** USB, or Bluetooth with a button that opens Windows Bluetooth
   settings for pairing. Setup watches device enumeration until exactly one Micro
   connection is present, and explains a doubled USB+Bluetooth connection.
3. **Control:** shows whether Codex and Work Louder Input are running, offers to
   quit them (force quit only on request), then opens the Micro exclusively once
   (`status`) to confirm nothing else holds it.
4. **Map:** explains what changes, asks for consent, then backs up the profile and
   maps the task rows (`setup-profile --consent`). An already mapped Micro is
   detected. Linked-app mappings, an interrupted mapping and a different device
   identity each get specific instructions.
5. **Test:** lights all eighteen task keys (`test-keys`) and shows each press live
   until one key on every layer works. Nothing opens during the test.
6. **Options:** start with Windows, alerts when a pinned task needs approval or an
   answer, and the opt-in Claude status hooks.
7. **Finish:** starts the bridge and opens the dashboard, which offers to reopen
   Codex.

### Running

The app lives in the notification area. Its icon's ring follows the device's ring:
blue or amber while tasks work, red-orange when a task needs you, red on error.
Right-click it to stop (releasing the Micro to Codex and Input), start, set up
again, toggle start with Windows and alerts, or quit. The dashboard shows all
eighteen slots with their live state and offers **Restore original keyboard
profile**. With start with Windows on, the app starts in the background and waits
for the Micro to connect (`start --supervise --wait-for-device`).

Other Start menu entries under *Troubleshooting* run `doctor` and `status` in a
console. The optional *Add to PATH* task puts the `micro-agent-bridge` command on
the user PATH. It takes the same commands and options as `standalone-control.mjs`
below, plus `micro-agent-bridge hooks install|remove`.

### Upgrade and removal

Setup and uninstall ask a running app to quit, which stops the host and releases
the Micro. A host started from a terminal must be stopped with Ctrl+C first.
Uninstall offers to restore the original keyboard profile while the Micro is
connected. It then removes the program files, the sign-in entry, the PATH entry,
any hooks this package installed, and the app's preferences and WebView cache. It
keeps `%LOCALAPPDATA%\Micro Agent Bridge\standalone`, which holds the profile
backups. Upgrades replace the program files and keep that directory; a sign-in
entry from rc.3 or earlier is moved to the app.

## Run from source

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
Running from source installs no background service and no sign-in entry. Only the
installer's opt-in *Start at sign-in* option adds one.

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

Each layer's six task keys show either its pinned tasks (the default) or its six
most recent tasks; choose per layer under *Agent keys* in the Controls view.
Pinned: pin local tasks in the app sidebars. Assignments retain their positions;
newly observed pins use the recent-pin allocator, and Mixed starts with Codex/Claude
interleaving. Most recent: the six tasks with the latest activity (Codex threads,
Claude desktop sessions and live Remote Control sessions); a task that stays in
the six keeps its key. A task key opens its validated desktop URI.

Claude keeps stars for Remote Control sessions that have ended, and hides them in
its own sidebar. The bridge hides them too: a `session_…` pin with no local
session behind it appears only while a reachable host reports it alive.

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

The action keys, microphone, bottom-right key, knob and joystick work on all
three layers. [Controls](micro-controls.md) lists the events each one sends. The
dashboard's **Controls** view shows what each control does on each layer and
where that comes from. You can change any of them there.

**What a control does.** With *Follow Codex settings* on (the default), each layer
uses what Codex assigns to that control in its own Micro settings
(`~/.codex/config.toml`, `[desktop.codex-micro-layout]`), so Codex stays the one
place to configure them. That includes the knob mode Codex offers (task
navigation, reasoning effort, conversation scroll). Where Codex's choice can't run
on that layer, the bridge default applies instead:

| Control | Bridge default |
|---|---|
| Bolt, check, cross, branch | Stop the running turn, Approve, Decline, New task |
| Microphone | Push to talk while held |
| Bottom-right key | Open the app: Codex on layer 1, Claude on layer 2, and on layer 3 whichever app most recently asked for you or was acted on |
| Knob left/right, press, hold | Previous/next task on this layer (opening it), open the selected task, next task needing you |
| Joystick up/down/left/right | Previous/next task, Back, Forward |

The Controls view offers every option Codex has: the bridge's own actions, Codex's
keycap presets, text keycaps such as `:yolo:`, and every Codex command (read from
the installed Codex app, so the list matches its version). Its *Knob* setting sets
the knob for a layer, including *Thinking level* (turn left to raise reasoning
effort, right to lower it). Choosing an action for a control overrides it for that
layer; *Reset* returns to the followed or default action. *Recent presses* lists
the last presses and why any did nothing (also kept in `controls-log.json` in the
state directory).

**Claude** (layer 2, and layer 3 when a Claude window is in front). Claude has no
shortcut interface, so each action uses a named control in its window through UI
Automation, after checking that the foreground window is the installed Claude app
and that its document URL names an allowed session: Approve/Decline, New session,
Back/Forward, sidebar, Stop, Send, Add files and dictation are buttons; fast mode,
plan mode and thinking level go through the model and permission-mode menus.
Commands Claude has no equivalent for do nothing there. By default, the allowed
sessions are the tasks on that layer's keys (*this layer's task in front*). With
*the task last opened with its key*, only the Claude task last opened by its key
qualifies, for 15 minutes. Dictation turns Claude's "Press and hold to record"
button on when the key goes down and off when it comes up. Opening a menu takes
a moment, so knob detents that arrive meanwhile are merged into one change (a
fast spin moves the thinking level several steps in one menu visit), and when a
menu can't be found or used the bridge stops opening menus for 30 seconds. The only keystrokes
sent to Claude are Escape and arrow keys inside a menu the bridge just opened.

**Codex** (layer 1, and layer 3 when a Codex window is in front). Codex exposes its
window content to neither UI Automation nor any outside interface, so the bridge
sends the command's Codex shortcut: your own from Codex's `keybindings.json`, else
Codex's default (Back `Ctrl+[`, Forward `Ctrl+]`, sidebar `Ctrl+B`, new task
`Ctrl+N`, Approve `Enter`, Decline `Escape`, and so on). It sends them only while the
foreground window is the Codex app and no modifier key is held. Approve and Decline
are sent only while a Codex task on the keys is waiting for approval, so `Enter`
can't send a half-written prompt. Codex has no stop command; Stop sends `Escape`,
which interrupts the running turn, only while a Codex task on the keys is working
and none is waiting for you (there, `Escape` would decline). Text keycaps type
their text into Codex.

Many Codex commands (fast mode, plan mode, reasoning effort, fork, push to talk)
have no default shortcut. With *Let the bridge add Codex shortcuts* on (off by
default), the bridge adds an unused chord (Ctrl/Alt/Shift with F13 to F24) to
Codex's `keybindings.json` (in `CODEX_HOME`, else `~/.codex`) for exactly the
commands your controls use. It records what it added, never changes anyone else's
entries, and removes its own when you turn the option off. Codex reads the file
when it starts, so restart Codex if a new shortcut doesn't respond. Task
navigation, the bottom-right key and the next task needing you work for both apps,
because the bridge opens those tasks itself.

**Profile.** Setup maps the Claude layer's knob, joystick and action keys to the
bridge's codes when they are unused (`KC_NONE`). It never takes over lower controls
a person assigned. The layer 1 controls stay Codex's own, and restore puts back
whatever was there. A device mapped by rc.5 or earlier is offered an update in
setup. The update restores the original profile and maps it again, keeping later
edits and every backup.

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
