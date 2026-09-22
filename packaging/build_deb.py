#!/usr/bin/env python3
import shutil,subprocess
from pathlib import Path
from common import ROOT,VERSION,runtime,payload,sums
version=VERSION.replace('-rc.','~rc')
build=ROOT/'build/deb';dist=ROOT/'dist';dist.mkdir(exist_ok=True)
if build.exists():shutil.rmtree(build)
for name in ('micro-agent-bridge-observer','micro-agent-bridge'):
 base=build/name;control=base/'DEBIAN';control.mkdir(parents=True)
 observer=name.endswith('observer');other='micro-agent-bridge' if observer else 'micro-agent-bridge-observer'
 deps='python3 (>= 3.10), openssh-client, ca-certificates, libc6 (>= 2.35), libstdc++6, procps'
 if not observer:deps+=', python3-gi, python3-pyatspi, gir1.2-gtk-3.0, gir1.2-ayatanaappindicator3-0.1, xdg-utils'
 (control/'control').write_text(f'Package: {name}\nVersion: {version}\nArchitecture: amd64\nMaintainer: awspangenberg <16296290+awspangenberg@users.noreply.github.com>\nDepends: {deps}\nConflicts: {other}\nReplaces: {other}\nSection: utils\nPriority: optional\nHomepage: https://github.com/awspangenberg/micro-agent-bridge\nDescription: Independent Claude and mixed task layers for Codex Micro\n Per-user setup required; no hooks or startup entries enabled by package installation.\n')
 pre=control/'preinst'
 pre.write_text('#!/bin/sh\nset -eu\nif [ "${1:-}" = upgrade ] && command -v pgrep >/dev/null && pgrep -f "[/]usr/lib/micro-agent-bridge/src/daemon.mjs" >/dev/null; then\n echo "Stop Micro Agent Bridge for all active users before upgrading." >&2\n exit 1\nfi\n')
 pre.chmod(0o755)
 lib=base/'usr/lib/micro-agent-bridge';lib.mkdir(parents=True);payload(lib);runtime('nodeLinux',lib/'runtime/node')
 command=base/'usr/bin/micro-agent-bridge';command.parent.mkdir(parents=True)
 command.write_text('#!/bin/sh\nexec /usr/lib/micro-agent-bridge/runtime/node/bin/node /usr/lib/micro-agent-bridge/src/control.mjs "$@"\n');command.chmod(0o755)
 if not observer:
  desktop=base/'usr/share/applications/micro-agent-bridge.desktop';desktop.parent.mkdir(parents=True)
  desktop.write_text('[Desktop Entry]\nType=Application\nName=Micro Agent Bridge\nComment=Configure Claude and mixed keyboard layers\nExec=/usr/bin/python3 /usr/lib/micro-agent-bridge/src/setup_linux.py\nIcon=input-keyboard\nTerminal=false\nCategories=Utility;\n')
 # Keep Debian's tilde inside package metadata; GitHub renames tildes in asset filenames.
 output=dist/f'{name}_{VERSION}_amd64.deb';candidate=build/(output.name+'.next')
 subprocess.run(['dpkg-deb','--root-owner-group','--build',str(base),str(candidate)],check=True)
 candidate.replace(output)
sums(dist)
