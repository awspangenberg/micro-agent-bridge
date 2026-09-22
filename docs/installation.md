# Installation

There is no qualified v1.0 release yet. The commands below describe the packaged
workflow; unsupported app builds fail preflight without changing the keyboard.

Prebuilt Ubuntu evaluation packages are available in
[v1.0.0-rc.1](https://github.com/awspangenberg/micro-agent-bridge/releases/tag/v1.0.0-rc.1).
Download one `.deb` and `SHA256SUMS` from the release's Assets section. Verify the
selected download with `sha256sum --ignore-missing --check SHA256SUMS` in the
download directory. Normal Linux desktop startup remains blocked by pending
hardware qualification. The Mac DMG is not yet published.

## Mac

Download the signed/notarized ARM64 DMG, verify its checksum, and drag **Micro
Agent Bridge** into Applications. Open it, choose Configure, then Check
compatibility. Grant Accessibility access to the helper in System Settings when
using task-bound controls. Input Monitoring belongs to the native Codex app.
Keep Work Louder Input closed while the helper is running.

Setup asks whether it may take ownership of existing layers 2 and 3. Without that
consent, occupied layers are preserved. Missing custom layers are created from the
native layout with inactive lower controls. All device changes have a fresh backup.
Click Start only after the required apps are installed and signed in.

The CLI is inside the application:

```sh
"/Applications/Micro Agent Bridge.app/Contents/Resources/runtime/node/bin/node" \
  "/Applications/Micro Agent Bridge.app/Contents/Resources/src/control.mjs" help
```

## Ubuntu desktop

Download the desktop `.deb`. It contains the helper runtime and observer capability; no second download is needed:

```sh
sudo apt install ./micro-agent-bridge_1.0.0-rc.1_amd64.deb
```

Open Micro Agent Bridge from the application menu. Configure, check compatibility,
and start. Neither package automatically installs hooks or enables a user service.
The desktop must be an active GNOME session. Wayland and X11 require separate
physical qualification. Narrow Micro udev permissions belong to the qualified
Codex distribution; never run the helper as root or grant world-writable HID access.

## Optional desktop apps

`micro-agent-bridge install-app claude --confirm` installs a missing app only.
On Ubuntu it checks Anthropic's signing-key fingerprint before configuring its
signed APT repository and installing the package; sudo may prompt. On Mac it
checks the downloaded app's Developer ID, bundle identifier, and Gatekeeper
assessment. It refuses an existing installation.

`install-app codex --confirm` supports the Mac vendor download. Linux Codex
installation is blocked until its official Linux package and native Micro
integration are qualified; setup does not silently install an untested build.
The latest vendor app may be newer than a supported adapter; installation and
compatibility are separate checks. Sign in yourself. The helper never handles
account passwords or tokens.

## SSH observer and multiple hosts

Install the observer-only package on each headless Ubuntu host and run as the coding user. Desktop and observer-only packages are alternatives, not co-installed dependencies:

```sh
sudo apt install ./micro-agent-bridge-observer_1.0.0-rc.1_amd64.deb
micro-agent-bridge setup --role observer --defaults
micro-agent-bridge doctor
```

Keep normal SSH authentication and host-key verification. The local desktop reads
only explicitly mapped hosts. Use native host identifiers from that desktop's
settings and the exact SSH target shown by Claude:

```sh
micro-agent-bridge hosts add build build-server \
  --codex-host remote-ssh-discovered:build-server --claude-target build-server
micro-agent-bridge hosts check build
```

Several native IDs/targets for one host can be comma-separated. An ID cannot map
to two hosts. The observer runs through SSH only while the desktop needs it.
No remote service, port, or credential copy is created. A disconnected host retains
its assignments with disconnected status. Use `hosts remove build` to remove a
mapping; this does not uninstall a shared remote observer.

## Startup, upgrade, rollback, uninstall

Use `micro-agent-bridge acceptance` to generate the checklist; save it as a private JSON report. Mark each entry true only after physically completing it, then run `micro-agent-bridge acceptance record REPORT.json`. Use `enable-login` after completing the acceptance checklist. Startup is blocked
until acceptance for the current compatibility manifest is recorded. `disable-login`
returns to manual operation. `stop` preserves layer definitions; `restore` restores
only owned layers if they have not subsequently been edited.

Upgrades replace program files through the platform's installer while private
configuration and state remain separate. Stop the helper before upgrade. Keep the
previous verified package to roll back program files. Do not downgrade across an
unsupported state schema. Existing original-helper installations can use `migrate`
after stopping the old helper and configuring host mappings. Migration copies
assignments and ownership records; it does not delete the old installation.

```sh
micro-agent-bridge uninstall
# If you edited the owned layers and want to preserve them:
micro-agent-bridge uninstall --keep-profile
```

Then remove the Mac app or Ubuntu packages using the OS. Owned settings/state are
archived locally, not published or erased. Remote observers are independent: remove
them on the remote host only when no other desktop uses them. Uninstall never
restores an entire old Claude settings file or keyboard profile over later edits.
