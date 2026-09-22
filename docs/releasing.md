# Release checklist

Version 1.0 requires prebuilt, downloadable Mac and Ubuntu installers. A source-only
release does not satisfy this project. Do not label an unqualified build v1.0.

1. Run focused tests, syntax checks, publication scan, and gitleaks on source and Git
   history. Review the staged diff and archive contents. Use the repository owner's
   GitHub no-reply identity; exclude machine paths, host addresses, task IDs/titles and private logs.
2. Build Debian packages in clean Ubuntu 24.04 and 26.04 environments; install as a
   fresh non-root user. Test observer setup, repeat setup, hook preservation/removal,
   alternate paths, migration, package upgrade/rollback/reinstall/removal.
3. Build on Apple Silicon with pinned runtimes. Set `MAB_SIGNING_IDENTITY` and
   `MAB_NOTARY_PROFILE` locally; never commit values or keychain credentials. Apple
   embeds certificate identity in signed binaries; obtain explicit publication
   consent for a personal certificate or use an organization certificate.
4. Check signatures, successful notarization and stapled tickets. Inspect the DMG
   contents and embedded executables. Scan the extracted package payloads too.
5. On real Mac and Ubuntu GNOME Wayland/X11 desktops, validate six task slots,
   overflow, empty keys, unpin/repin/new pins, duplicate titles, local/remote tasks,
   all status transitions and native layer preservation. Validate only implemented
   native actions; focus loss must revoke them. Repeat Bluetooth, sleep, SSH, app,
   helper restart. Five-second normal update / thirty-second recovery targets.
6. Record sanitized per-platform acceptance with the exact app/firmware/package
   versions. Never include session IDs, titles, hostnames or raw logs. The local
   `acceptance.json` also records the SHA-256 of `src/compatibility.json` and
   `passed:true`; it must come from completed physical acceptance, not bypass it.
7. Set package version 1.0.0 only after all gates pass. Rebuild, create SHA256SUMS,
   and publish the DMG, both Debian packages, checksums, notices and compatibility
   report to the matching GitHub release. Retain earlier verified releases for
   rollback. Never upload vendor apps or private runtime data.

The Linux native transport qualification, Mac notarization credentials, and physical
multi-platform acceptance are current blockers. Source CI must not publish releases
merely because unit tests pass.

## Evaluation prereleases

Prebuilt evaluation packages may be published manually as a GitHub prerelease
before physical qualification. Explicitly name every unmet gate in the release
notes and retain runtime qualification checks. Do not mark these releases stable
or latest, and do not include an unsigned/unnotarized Mac DMG. Attach the built
packages, SHA256SUMS, license, dependency notices and compatibility report. Verify
anonymous downloads and their checksums after publication. GitHub Actions artifacts
alone are not public installer delivery. Debian and DMG files belong in Release
Assets, not the GitHub Packages registry.
