import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// SSH targets are passed to ssh as a single argument; refuse anything option-like.
const TARGET = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,255}$/;
const GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'ssh.dev.azure.com', 'vs-ssh.visualstudio.com']);
const PROBE = fs.readFileSync(fileURLToPath(new URL('./remote-sessions.sh', import.meta.url)), 'utf8').replace(/\r/g, '');

export function remoteHosts(targets = []) {
  const seen = new Set();
  return targets.map(target => {
    if (typeof target !== 'string' || !TARGET.test(target)) throw Error('Use an SSH alias or user@host for --remote, not SSH options');
    if (seen.has(target)) throw Error('Duplicate --remote target');
    seen.add(target);
    return {target};
  });
}

// Concrete aliases from ~/.ssh/config, excluding wildcard patterns and Git hosting.
export function sshConfigHosts(text) {
  const hosts = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    for (const name of m[1].split(/\s+/))
      if (TARGET.test(name) && !GIT_HOSTS.has(name.toLowerCase()) && !name.includes('@')) hosts.push(name);
  }
  return [...new Set(hosts)];
}

// Online Tailscale peers with Tailscale SSH (published host keys) on Unix-like OSes.
export function tailscaleHosts(status) {
  const peers = Object.values(status?.Peer ?? {});
  return peers.filter(p => p?.Online && Array.isArray(p.sshHostKeys) && p.sshHostKeys.length && ['linux', 'macOS'].includes(p.OS) && typeof p.DNSName === 'string')
    .map(p => ({target: p.DNSName.replace(/\.$/, ''), hostKeys: p.sshHostKeys.filter(k => typeof k === 'string' && /^[a-z0-9-]+ [A-Za-z0-9+/=]+$/.test(k))}))
    .filter(h => TARGET.test(h.target) && h.hostKeys.length);
}

export function parseProbe(lines) {
  const sessions = [];
  for (const line of lines) {
    const m = /^MAB1 ([0-9a-f-]{36}|-) ((?:session|cse)_[A-Za-z0-9]{1,128}|-) ([a-z_]{1,32}|-) ([01])$/.exec(line);
    if (!m || m[1] === '-') continue;
    sessions.push({sessionId: m[1], bridge: m[2] === '-' ? null : m[2].replace(/^cse_/, 'session_'), status: m[3] === '-' ? null : m[3], alive: m[4] === '1'});
  }
  return sessions;
}
const STATUS = {busy: 'working', waiting: 'awaiting_input', idle: 'idle', shell: 'command'};

async function discover({stateDirectory, home = os.homedir(), run = execFile}) {
  const hosts = [];
  try { hosts.push(...sshConfigHosts(fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf8')).map(target => ({target}))); } catch { /* No SSH config. */ }
  const tailscale = [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe'), 'tailscale'].filter(Boolean);
  for (const exe of tailscale) {
    try {
      const stdout = await new Promise((resolve, reject) => run(exe, ['status', '--json'], {windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024}, (e, out) => e ? reject(e) : resolve(out)));
      const peers = tailscaleHosts(JSON.parse(stdout));
      for (const peer of peers) {
        // Pin keys published by the authenticated tailnet; never edit ~/.ssh/known_hosts.
        const dir = path.join(stateDirectory || os.tmpdir(), 'remote-known-hosts');
        fs.mkdirSync(dir, {recursive: true});
        const file = path.join(dir, peer.target);
        fs.writeFileSync(file, peer.hostKeys.map(k => `${peer.target} ${k}`).join('\n') + '\n', {mode: 0o600});
        hosts.push({target: peer.target, knownHosts: file});
      }
      break;
    } catch { /* Tailscale unavailable. */ }
  }
  return hosts;
}

// Claude Code tasks on other machines appear here as pinned claude.ai bridge sessions
// with no local process. Each candidate host streams its session registry over one
// read-only SSH connection; only a single live session with that bridge ID is trusted.
export class RemoteClaudeStatus {
  constructor({targets = [], discoverHosts = true, stateDirectory, spawnSsh = spawn, discoverer = discover, now = Date.now} = {}) {
    Object.assign(this, {spawnSsh, discoverer, now, stateDirectory, discoverHosts});
    this.explicit = remoteHosts(targets); this.hosts = new Map(); this.requested = []; this.lastHost = new Map();
    this.discoveredAt = -Infinity; this.discovering = null; this.closed = false;
    for (const h of this.explicit) this.addHost(h);
  }
  addHost({target, knownHosts}) {
    if (this.hosts.has(target)) { if (knownHosts) this.hosts.get(target).knownHosts = knownHosts; return; }
    this.hosts.set(target, {target, knownHosts, child: null, at: 0, sessions: [], failures: 0, next: 0, idleSince: 0});
  }
  update(tasks) {
    this.requested = [...new Set(tasks.filter(t => t?.provider === 'claude' && !t.nativeId &&
      typeof t.navId === 'string' && t.navId.startsWith('session_')).map(t => t.navId))];
  }
  fresh(host) { return !!host && this.now() - host.at < 8000; }
  // Exactly one fresh machine reports a live session with this bridge ID.
  alive(navId) { return this.matches(navId).length === 1; }
  matches(navId) {
    return [...this.hosts.values()].filter(h => this.fresh(h)).flatMap(h => h.sessions.filter(s => s.alive && s.bridge === navId).map(s => ({host: h, session: s})));
  }
  tick() {
    if (this.closed) return;
    if (!this.requested.length) { for (const h of this.hosts.values()) this.stopHost(h); return; }
    if (this.discoverHosts && !this.discovering && this.now() - this.discoveredAt > 300000) {
      this.discoveredAt = this.now();
      this.discovering = this.discoverer({stateDirectory: this.stateDirectory}).then(found => { if (!this.closed) for (const h of found) this.addHost(h); })
        .catch(() => {}).finally(() => { this.discovering = null; });
    }
    const resolved = new Set(this.requested.flatMap(nav => this.matches(nav).map(m => m.host.target)));
    for (const h of this.hosts.values()) {
      if (h.child) {
        // A reachable host that serves none of the pins is closed and rechecked later.
        if (this.fresh(h) && !resolved.has(h.target)) { h.idleSince ||= this.now(); if (this.now() - h.idleSince > 30000) { this.stopHost(h); h.next = this.now() + 300000; } }
        else h.idleSince = 0;
        if (h.at && this.now() - h.at > 12000) this.stopHost(h);
        continue;
      }
      if (this.now() >= h.next) this.startHost(h);
    }
  }
  startHost(h) {
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];
    if (h.knownHosts) args.push('-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${h.knownHosts}`, '-o', `GlobalKnownHostsFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`);
    args.push(h.target, 'sh -s');
    let child;
    try { child = this.spawnSsh('ssh', args, {stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true}); }
    catch { h.failures++; h.next = this.now() + Math.min(300000, 10000 * 2 ** h.failures); return; }
    h.child = child; h.at = 0; let buffer = '', lines = [], ok = false;
    child.stdout.on('data', b => {
      buffer += b; if (buffer.length > 1048576) { this.stopHost(h); return; }
      let i; while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        if (line === 'MAB1-END') { h.sessions = parseProbe(lines); h.at = this.now(); lines = []; ok = true; h.failures = 0; }
        else if (lines.length < 2000) lines.push(line);
      }
    });
    child.stdin.on('error', () => {}); child.on('error', () => {});
    child.on('exit', () => {
      if (h.child !== child) return;
      h.child = null; h.at = 0; h.sessions = [];
      if (!ok) { h.failures++; h.next = Math.max(h.next, this.now() + Math.min(300000, 10000 * 2 ** h.failures)); }
      else h.next = Math.max(h.next, this.now() + 5000);
    });
    child.stdin.end(PROBE);
  }
  stopHost(h) { const child = h.child; h.child = null; h.at = 0; h.sessions = []; h.idleSince = 0; try { child?.kill(); } catch { /* Gone. */ } }
  // null means this task is not a remote session pin; the caller keeps its own state.
  state(task) {
    if (!this.requested.includes(task?.navId)) return null;
    const found = this.matches(task.navId);
    if (found.length === 1) {
      this.lastHost.set(task.navId, found[0].host.target);
      return STATUS[found[0].session.status] ?? 'unknown';
    }
    if (found.length > 1) return 'unknown';
    const host = this.hosts.get(this.lastHost.get(task.navId));
    return host && !this.fresh(host) ? 'disconnected' : null;
  }
  close() { this.closed = true; for (const h of this.hosts.values()) this.stopHost(h); }
}
