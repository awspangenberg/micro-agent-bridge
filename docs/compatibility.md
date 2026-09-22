# Compatibility

| Component | Current evidence | Release status |
|---|---|---|
| Original Mac helper, Codex 26.915.31945 / Claude 2.2553.1 / firmware 0.6.2 | Native, Claude, Mixed selection and live pins physically demonstrated | Portable app must be requalified |
| macOS 14+ ARM64 packaged helper | Build/test target | Not yet release-qualified |
| Ubuntu 24.04/26.04 amd64 observer | Protocol and package test target | No service needed |
| Ubuntu GNOME desktop Wayland/X11 | UI adapter implemented, native transport qualification pending | Blocked |

`src/compatibility.json` is the machine-readable contract. Unknown Codex bundle
hashes disable HID attachment. Unknown Claude versions disable its selection/status.
The helper does not promise compatibility with an automatic vendor update until
that update is tested. Only a reviewed helper release changes the adapter manifest.

Working: pulsing blue. Waiting: pulsing amber. Real completion: green. Confirmed
idle: white. Unknown/unloaded: dim gray. Error/disconnected: red. Empty: off.
Completion is never inferred from silence. An unavailable app does not unpin tasks.

The initial pin order comes from native sidebar order (Codex-first interleave for
Mixed), because the apps do not expose comparable historical pin timestamps.
Later observed additions determine recency; simultaneous additions during an outage
use sidebar order. Starting an unpinned task has no effect.

FAST, fork/SPLIT, microphone, dial, and joystick plan controls remain unavailable.
Other action controls require exact foreground-task verification and release
qualification; an unverified control is not advertised as supported. No CLI shortcut
is substituted for a desktop action. Layer 2 lower controls remain as configured.

Sleep/reconnect recovery, six live slots, and supported actions are separate release
gates. Earlier static colors or simulated reconnection do not satisfy those gates.
