# Micro Agent Bridge public installers

Approved 2026-09-21. Public MIT project: awspangenberg/micro-agent-bridge.
Targets: Apple Silicon macOS14+ (compatible apps required), Ubuntu24.04/26.04 amd64 GNOME Wayland/X11 desktop and SSH observer. No Intel Mac or ARM Ubuntu.

## Implementation
- [ ] Portable shared core, platform adapters, multi-host discovery, versioned config/CLI/protocol/compatibility manifest.
- [ ] Guided setup; optional verified app installation; permissions and compatibility checks; own profile/hook changes only.
- [ ] Signed/notarized Mac app/DMG with runtimes; desktop and observer Debian packages.
- [ ] Transactional upgrade/migration/rollback, acceptance-gated startup, safe uninstall.
- [ ] Clean-machine and physical acceptance; public source/docs/checksums/notices/releases only after relevant gates.

Preserve native layer1, Claude layer2 and Mixed layer3 recent pins, stable survivor slots, exact task identity, genuine completion, one shared native HID queue. No competing HID reader/writer. Unknown compatibility fails closed. Unsupported actions remain visibly unavailable. Target five-second updates and thirty-second recovery. No blanket permissions or substitute shortcuts.

Modified: new repository, helper install/config/state, owned layer mappings, scoped hooks, startup entries, narrow Linux device access. Read-only: app bundles/settings/native pins/session metadata/SSH configuration. Out of scope: firmware, authentication, unrelated host services, shared rules/harnesses, unrelated sessions, retired Input Linux integration. Verify cross-surface drift through ownership snapshots and source diff; preserve existing dirty Linux Codex checkout.

Tests: allocation/overflow/pin changes/new tasks/duplicate titles/local+remote/statuses; fresh install/upgrade/interruption/rollback/reinstall/uninstall with alternate user; native controls/empty keys/manual layers/action focus loss; Bluetooth cycle/sleep/SSH/helper/app restarts; physical Mac and Linux acceptance. Linux exact navigation/pins/transport/lighting/foreground identity and Mac notarization are release blockers, not assumed passes.

Orchestration: sequential Codex implementation/research/review; shared physical device.  No subagents.

Prior trial correction: user confirmed Claude layer2 selection and live pins work; Mixed/native layers work. Advanced actions and full recovery qualification remain incomplete. Existing installations remain intact during packaging.

## Implementation checkpoint

Portable source, CLI, guided setup windows, shared recent-pin logic, multi-host SSH
observer supervision, scoped hook ownership, migration recovery, and rollback are
implemented. Source is public; no stable release tag exists. Existing working
installations have not been replaced.

Prebuilt desktop/observer Debian candidates passed clean-user install, repeated
setup, configuration, hook removal, reinstall, role-package replacement, and removal
on Ubuntu 24.04 and 26.04. The Linux setup window rendered in a virtual display.
Node allocation/status/config/transaction tests, Python metadata/hook tests, and
simulated HID isolation/ownership/recovery tests passed. Missing custom layers are
created and restored while preserving the native layer. These checks are not
physical Linux acceptance.

The Apple Silicon application compiled with bundled Node/Python; runtime import
checks passed. Signing and notarization remain blocked on credential access and
publication consent for the certificate identity. The compiled portable Mac app
still requires full end-to-end acceptance.

Linux physical testing is explicitly deferred by the requester. Version 1.0 is held
until those gates pass; it must include the notarized DMG and self-contained Ubuntu
packages. Candidate builds and source-only publication do not meet that release gate.

Publication checks: staged source and Git history secret scans passed; personal
paths, private host addresses, live task IDs and private runtime files are excluded.
The Node SDK was removed from payloads; it is not required at runtime. Only the
repository owner's GitHub username and GitHub no-reply address are used in Git
commits. Package source references the public repository owner intentionally.

## Download publication

The requester explicitly asked for downloadable packages while platform gates remain
open. Publish the self-contained Ubuntu candidates as v1.0.0-rc.1, marked prerelease
and not latest, with checksums, license, dependency notices and compatibility report.
Verify public anonymous download checksums. This does not qualify Linux desktop or
clear the stable v1.0/Mac signing and hardware acceptance gates.
