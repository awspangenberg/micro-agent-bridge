# Micro Agent Bridge

Independent Claude and mixed task layers for the Work Louder Codex Micro.
In the native-service integration, Codex stays on layer 1. Layer 2 shows six recent
Claude Code pins; layer 3 shows six recent pins across Codex and Claude. Task
activity does not change pin recency. Surviving assignments retain their positions.

**Release status: under qualification. No supported v1.0 binary release yet.**
The original macOS helper demonstrated the three layers. Portable installers,
Linux desktop behavior, and recovery require separate release acceptance.
Do not interpret a package building successfully as hardware qualification.

## Download the prerelease

[**Download v1.0.0-rc.4**](https://github.com/awspangenberg/micro-agent-bridge/releases/tag/v1.0.0-rc.4)

- [Ubuntu desktop installer](https://github.com/awspangenberg/micro-agent-bridge/releases/download/v1.0.0-rc.4/micro-agent-bridge_1.0.0-rc.4_amd64.deb)
- [Ubuntu SSH observer installer](https://github.com/awspangenberg/micro-agent-bridge/releases/download/v1.0.0-rc.4/micro-agent-bridge-observer_1.0.0-rc.4_amd64.deb)
- [Windows x64 installer](https://github.com/awspangenberg/micro-agent-bridge/releases/download/v1.0.0-rc.4/Micro-Agent-Bridge-1.0.0-rc.4-windows-x64-setup.exe) (standalone Micro host, per-user, unsigned)
- [SHA256 checksums](https://github.com/awspangenberg/micro-agent-bridge/releases/download/v1.0.0-rc.4/SHA256SUMS)

The Windows installer bundles Node.js and Python and needs no administrator
access. When it finishes, a setup window walks you through connecting or pairing
the Micro, handing it over from Codex, mapping and testing the keys; the bridge then
runs from the notification area. See [Windows](docs/windows.md#install). It is not
Authenticode-signed, so SmartScreen warns before running it. Verify its checksum first.

The Ubuntu packages are prebuilt Ubuntu 24.04/26.04 x86-64 evaluation packages.
Clean-machine installation tests passed for rc.1; physical Linux keyboard
acceptance remains pending.
Normal desktop startup stays disabled until qualification. The observer package
supplies SSH reporting without a desktop or keyboard. Install one package per host.

## Before you install

Check these first so installation and the first run go smoothly.

### Windows installer

| Requirement | Details |
| --- | --- |
| Windows 10 or 11, x64 | ARM64 Windows is not supported. The installer refuses older versions. |
| Windows PowerShell 5.1 and .NET Framework 4.8 | Both ship with Windows 10 (1903 or later) and 11. The app runs on .NET Framework, and the HID helper compiles itself with it at runtime, so neither may be removed or disabled. |
| Microsoft Edge WebView2 Runtime | Draws the setup and dashboard windows. Windows 11 includes it, and most Windows 10 PCs have it through Edge. If it's missing, the installer warns you; get the Evergreen runtime from [Microsoft](https://go.microsoft.com/fwlink/p/?LinkId=2124703). |
| Script policy that allows a bypass | The host starts PowerShell with `-ExecutionPolicy Bypass`. A Group Policy that enforces `AllSigned` or `Restricted` (check with `Get-ExecutionPolicy -List`), WDAC or AppLocker can block the helper. |
| Permission to run unsigned installers | The installer is not code-signed. SmartScreen warns (*More info → Run anyway*). Windows 11 **Smart App Control**, when on, blocks it outright. Antivirus may need to allow `%LOCALAPPDATA%\Programs\Micro Agent Bridge`. |
| About 150 MB free | The installer bundles Node.js and Python. You need no administrator rights and no separate Node.js or Python. |
| Work Louder Codex Micro | Firmware 0.6.2 was verified. Use **one** connection, USB or Bluetooth, not both, and keep it unchanged while the host runs. |
| Codex and/or Claude desktop apps | Installed and signed in. Microsoft Store Codex 26.1013 and Claude 2.42304 were verified. Pin the tasks you want in each app's sidebar; only pinned tasks get keys. |
| Work Louder Input and Codex closed while setup takes control | The bridge needs exclusive access to the keyboard. Setup shows which of them is open and offers to quit it; reopen Codex once the bridge is running. |
| Optional: OpenSSH client | Built into Windows. Needed only for status of pinned Claude sessions on other machines, discovered from `~/.ssh/config` and, optionally, Tailscale. |

Setup backs up the keyboard profile and remaps the task keys on layers 1–3, with
your consent. If the profile uses automatic app mappings (`linkedApps`), turn them
off in Work Louder Input first, or mapping refuses to run. For Bluetooth, have the
Micro ready to enter pairing mode, and pair it on the channel you'll keep using:
a different channel looks like a different device to the bridge.

### Ubuntu packages

| Requirement | Details |
| --- | --- |
| Ubuntu 24.04 or 26.04, x86-64 | `apt` installs the dependencies: Python 3.10+, OpenSSH client and the GTK/AppIndicator libraries. Install with `sudo apt install ./<file>.deb`, not `dpkg -i`, so dependencies resolve. |
| One package per host | Desktop and observer conflict. Remove one before installing the other. |
| Desktop package | An active GNOME session (Wayland or X11) and supported Codex/Claude desktop builds (see [compatibility](docs/compatibility.md)). Normal desktop start stays blocked until physical Linux qualification. |
| Observer package | No desktop or keyboard needed. The desktop must reach the observer host over normal SSH with key authentication. |
| Stop a running helper before upgrading | The package refuses to upgrade while `micro-agent-bridge` is running. |

The Mac DMG is not available yet: signing/notarization and portable Mac acceptance
remain release blockers. Version 1.0 will include the Mac installer when those gates
pass. Downloads live in **Releases → Assets**; the separate GitHub Packages registry
does not host Debian or DMG installers.

## Planned v1.0 downloads

- `Micro-Agent-Bridge-1.0.0-macOS-arm64.dmg`: signed, notarized Apple Silicon app,
  macOS 14+ subject to desktop-app requirements, bundled helper runtimes.
- `micro-agent-bridge_1.0.0_amd64.deb` (self-contained): Ubuntu
  24.04/26.04 GNOME desktop.
- `micro-agent-bridge-observer_1.0.0_amd64.deb`: Ubuntu SSH session observer;
  no desktop, background service, or keyboard required on the remote host.

Download artifacts and SHA256SUMS from this project's GitHub Releases only.
No compiler or Homebrew is required by the prebuilt Mac installer. Intel Macs,
ARM Linux, Windows on ARM, other Linux desktop environments, and arbitrary app
versions are not currently supported. Windows x64 is supported only through the
standalone host below.

[Installation and removal](docs/installation.md) ·
[Compatibility and limitations](docs/compatibility.md) ·
[Privacy and architecture](docs/architecture.md) ·
[Release validation](docs/releasing.md)

Windows: the [standalone Micro host](docs/windows.md) ships as an evaluation
installer, and runs from source with `npm ci` and `npm run windows:doctor`. It owns
the device exclusively and supplies Codex, Claude, and Mixed task banks, with
opt-in profile backup/restore. Physical Windows qualification is still pending.
The separate [native service extension](docs/windows-service.md) remains a proposed
integration that the current Store application does not load.

## Development

Node.js 22 and Python 3.10+ are required. `npm test` runs the focused tests.
`npm run check` checks publication hygiene. `npm run build:deb` builds both Debian
packages. `python packaging/build_windows.py` builds the Windows installer on
Windows (npm, the .NET SDK and Inno Setup 6 required). The setup and dashboard pages
under `windows/ui` preview in a browser with a built-in simulator. Build the Mac app on Apple Silicon using `python3 packaging/build_macos.py`.
Signing and notarization are mandatory before publishing a release DMG.

The project uses no provider API keys. Sign in to the desktop apps normally.
