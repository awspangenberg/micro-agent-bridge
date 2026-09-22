#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends /packages/micro-agent-bridge-observer_*.deb
useradd --create-home --shell /bin/sh package-tester
su - package-tester -c 'micro-agent-bridge setup --role observer --defaults'
su - package-tester -c 'micro-agent-bridge setup --role observer --defaults'
su - package-tester -c 'micro-agent-bridge doctor'
su - package-tester -c 'micro-agent-bridge status'
su - package-tester -c 'micro-agent-bridge uninstall --keep-profile'
su - package-tester -c 'test ! -f "$HOME/.config/micro-agent-bridge/config.json"'
su - package-tester -c 'python3 -c '\''import json; from pathlib import Path; assert not json.loads((Path.home()/".claude/settings.json").read_text()).get("hooks")'\'''
apt-get install -y --reinstall /packages/micro-agent-bridge-observer_*.deb
apt-get install -y --no-install-recommends /packages/micro-agent-bridge_*.deb
su - package-tester -c 'micro-agent-bridge setup --role desktop --defaults'
su - package-tester -c 'micro-agent-bridge uninstall --keep-profile'
apt-get remove -y micro-agent-bridge
printf 'Fresh install, repeat setup, doctor, uninstall, reinstall, package removal passed\n'
