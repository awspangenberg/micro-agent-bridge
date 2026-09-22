# Micro Agent Bridge

Independent Claude and mixed task layers for the Work Louder Codex Micro.
Native Codex stays on layer 1. Layer 2 shows six recent Claude Code pins; layer 3
shows six recent pins across Codex and Claude. Task activity does not change pin
recency. Surviving assignments retain their positions.

**Release status: under qualification. No supported v1.0 binary release yet.**
The original macOS helper demonstrated the three layers. Portable installers,
Linux desktop behavior, and recovery require separate release acceptance.
Do not interpret a package building successfully as hardware qualification.

## Planned prebuilt downloads

- `Micro-Agent-Bridge-1.0.0-macOS-arm64.dmg`: signed, notarized Apple Silicon app,
  macOS 14+ subject to desktop-app requirements, bundled helper runtimes.
- `micro-agent-bridge_1.0.0_amd64.deb` (self-contained): Ubuntu
  24.04/26.04 GNOME desktop.
- `micro-agent-bridge-observer_1.0.0_amd64.deb`: Ubuntu SSH session observer;
  no desktop, background service, or keyboard required on the remote host.

Download artifacts and SHA256SUMS from this project's GitHub Releases only.
No compiler or Homebrew is required by the prebuilt Mac installer. Intel Macs,
ARM Linux, Windows, other Linux desktop environments, and arbitrary app versions
are not currently supported.

[Installation and removal](docs/installation.md) ·
[Compatibility and limitations](docs/compatibility.md) ·
[Privacy and architecture](docs/architecture.md) ·
[Release validation](docs/releasing.md)

## Development

Node.js 22 and Python 3.10+ are required. `npm test` runs the focused tests.
`npm run check` checks publication hygiene. `npm run build:deb` builds both Debian
packages. Build the Mac app on Apple Silicon using `python3 packaging/build_macos.py`.
Signing and notarization are mandatory before publishing a release DMG.

The project uses no provider API keys. Sign in to the desktop apps normally.
