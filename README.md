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

[**Download v1.0.0-rc.3**](https://github.com/awspangenberg/micro-agent-bridge/releases/tag/v1.0.0-rc.3)

- [Ubuntu desktop installer](https://github.com/awspangenberg/micro-agent-bridge/releases/download/v1.0.0-rc.3/micro-agent-bridge_1.0.0-rc.3_amd64.deb)
- [Ubuntu SSH observer installer](https://github.com/awspangenberg/micro-agent-bridge/releases/download/v1.0.0-rc.3/micro-agent-bridge-observer_1.0.0-rc.3_amd64.deb)
- [Windows x64 installer](https://github.com/awspangenberg/micro-agent-bridge/releases/download/v1.0.0-rc.3/Micro-Agent-Bridge-1.0.0-rc.3-windows-x64-setup.exe) (standalone Micro host, per-user, unsigned)
- [SHA256 checksums](https://github.com/awspangenberg/micro-agent-bridge/releases/download/v1.0.0-rc.3/SHA256SUMS)

The Windows installer bundles Node.js and Python and needs no administrator
access; see [Windows](docs/windows.md#install). It is not Authenticode-signed, so
SmartScreen warns before running it. Verify its checksum first.

The Ubuntu packages are prebuilt Ubuntu 24.04/26.04 x86-64 evaluation packages.
Clean-machine installation tests passed for rc.1; physical Linux keyboard
acceptance remains pending.
Normal desktop startup stays disabled until qualification. The observer package
supplies SSH reporting without a desktop or keyboard. Install one package per host.

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
Windows (npm and Inno Setup 6 required). Build the Mac app on Apple Silicon using `python3 packaging/build_macos.py`.
Signing and notarization are mandatory before publishing a release DMG.

The project uses no provider API keys. Sign in to the desktop apps normally.
