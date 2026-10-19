import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {RemoteClaudeStatus, remoteHosts, sshConfigHosts, tailscaleHosts, parseProbe} from '../src/standalone-remotes.mjs';
import {StandaloneRuntime} from '../src/standalone-runtime.mjs';
import {parseArguments, supervise, recoverable} from '../src/standalone-control.mjs';

const SID = '33333333-3333-4333-8333-333333333333';
const remoteTask = {provider: 'claude', host: 'local', nativeId: null, navId: 'session_remote1', title: 'Remote', state: 'unknown'};
const localTask = {provider: 'claude', host: 'local', nativeId: '11111111-1111-4111-8111-111111111111', navId: 'local_11111111-1111-4111-8111-111111111111', title: 'Local', state: 'unknown'};

function fakeSsh() {
  const spawned = [];
  const spawnSsh = (cmd, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.args = args; child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', null); };
    child.report = lines => child.stdout.write(lines.map(l => l + '\n').join('') + 'MAB1-END\n');
    spawned.push(child); return child;
  };
  return {spawned, spawnSsh};
}
const flush = () => new Promise(r => setImmediate(r));

test('targets, SSH config and Tailscale discovery are validated and never become SSH options', () => {
  assert.deepEqual(remoteHosts(['buildbox', 'me@dev.example']).map(h => h.target), ['buildbox', 'me@dev.example']);
  for (const bad of ['-oProxyCommand=calc', 'host name', 'a;b', '']) assert.throws(() => remoteHosts([bad]), /SSH alias/);
  assert.throws(() => remoteHosts(['box', 'box']), /Duplicate/);
  assert.deepEqual(sshConfigHosts('Host dev box2\n  User me\nHost *\nHost github.com\nHost *.corp !bad -oX\nhost lower'), ['dev', 'box2', 'lower']);
  const status = {Peer: {a: {Online: true, OS: 'linux', DNSName: 'ai.tail.ts.net.', sshHostKeys: ['ssh-ed25519 AAAAC3Nza=', 'bad key; rm']},
    b: {Online: false, OS: 'linux', DNSName: 'off.ts.net.', sshHostKeys: ['ssh-ed25519 AAAA']}, c: {Online: true, OS: 'windows', DNSName: 'win.ts.net.', sshHostKeys: ['ssh-ed25519 AAAA']},
    d: {Online: true, OS: 'linux', DNSName: 'nokeys.ts.net.'}}};
  assert.deepEqual(tailscaleHosts(status), [{target: 'ai.tail.ts.net', hostKeys: ['ssh-ed25519 AAAAC3Nza=']}]);
  assert.deepEqual(parseArguments(['start', '--remote', 'box', '--no-remote-discovery', '--supervise']).remotes, ['box']);
  assert.throws(() => parseArguments(['status', '--supervise']), /only valid with start/);
  assert.throws(() => parseArguments(['start', '--remote', '-oX']), /Missing value/);
});

test('probe output keeps only identifiers, status and liveness; malformed lines are ignored', () => {
  assert.deepEqual(parseProbe([`MAB1 ${SID} cse_abc busy 1`, `MAB1 ${SID} - - 0`, 'MAB1 ../x session_a busy 1', `MAB1 ${SID} session_b busy 1 extra`, 'noise']),
    [{sessionId: SID, bridge: 'session_abc', status: 'busy', alive: true}, {sessionId: SID, bridge: null, status: null, alive: false}]);
});

test('only unresolved bridge pins start probes; one live session reports its state; idle stays quiet', async () => {
  let now = 0;
  const {spawned, spawnSsh} = fakeSsh(), status = new RemoteClaudeStatus({targets: ['box'], discoverHosts: false, spawnSsh, now: () => now});
  status.update([localTask]); status.tick();
  assert.equal(spawned.length, 0, 'no remote pins, no SSH');
  status.update([remoteTask, localTask, null, {provider: 'codex', navId: 'session_x'}]); status.tick();
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes('BatchMode=yes') && spawned[0].args.at(-2) === 'box' && spawned[0].args.at(-1) === 'sh -s');
  assert.equal(status.state(localTask), null);
  assert.equal(status.state(remoteTask), null, 'no answer yet keeps the local state');
  spawned[0].report([`MAB1 ${SID} session_remote1 busy 1`]); await flush();
  assert.equal(status.state(remoteTask), 'working');
  spawned[0].report([`MAB1 ${SID} session_remote1 waiting 1`]); await flush();
  assert.equal(status.state(remoteTask), 'awaiting_input');
  spawned[0].report([`MAB1 ${SID} session_remote1 busy 0`]); await flush();
  assert.equal(status.state(remoteTask), null, 'a stale registry entry is never trusted');
  now += 9000;
  assert.equal(status.state(remoteTask), 'disconnected', 'a silent known host shows disconnected');
  status.close(); assert.equal(spawned[0].killed, true);
});

test('ambiguous matches stay unknown; unmatched hosts close and failures back off; pinned keys are strict', async () => {
  let now = 0;
  const {spawned, spawnSsh} = fakeSsh();
  const status = new RemoteClaudeStatus({targets: ['one'], spawnSsh, now: () => now, discoverer: async () => [{target: 'two', knownHosts: 'C:/state/known/two'}, {target: 'three'}]});
  status.update([remoteTask]); status.tick(); await flush(); status.tick();
  assert.deepEqual(spawned.map(c => c.args.at(-2)), ['one', 'two', 'three']);
  assert.ok(spawned[1].args.includes('StrictHostKeyChecking=yes') && spawned[1].args.includes('UserKnownHostsFile=C:/state/known/two'));
  spawned[0].report([`MAB1 ${SID} session_remote1 busy 1`]);
  spawned[1].report([`MAB1 44444444-4444-4444-8444-444444444444 session_remote1 idle 1`]);
  spawned[2].report([`MAB1 ${SID} session_other idle 1`]); await flush();
  assert.equal(status.state(remoteTask), 'unknown', 'two live matches are ambiguous');
  spawned[1].report([]); await flush();
  assert.equal(status.state(remoteTask), 'working');
  for (const step of [1, 31000]) { now += step; spawned[0].report([`MAB1 ${SID} session_remote1 busy 1`]); spawned[2].report([]); spawned[1].report([]); await flush(); status.tick(); }
  assert.equal(spawned[2].killed, true, 'a host serving no pins is closed after 30 s');
  assert.equal(spawned[0].killed, false);
  const failing = fakeSsh(), lone = new RemoteClaudeStatus({targets: ['down'], discoverHosts: false, spawnSsh: failing.spawnSsh, now: () => now});
  lone.update([remoteTask]); lone.tick(); failing.spawned[0].emit('exit', 255); lone.tick();
  assert.equal(failing.spawned.length, 1, 'a failed host waits before retrying');
  now += 25000; lone.tick();
  assert.equal(failing.spawned.length, 2);
  lone.close(); status.close();
});

test('runtime paints remote state for a remote pin and keeps local working authoritative', async () => {
  const transport = new EventEmitter(); transport.calls = []; transport.closed = false;
  transport.rpc = async (method, params) => { transport.calls.push({method, params}); return {}; };
  transport.close = async () => { transport.closed = true; };
  const codex = {connect() {}, update() {}, state() { return 'idle'; }, close() {}};
  const {spawned, spawnSsh} = fakeSsh(), remote = new RemoteClaudeStatus({targets: ['box'], discoverHosts: false, spawnSsh});
  const runtime = new StandaloneRuntime({transport, codex, remote, inventory: async () => ({codex: [], claude: [remoteTask, {...localTask, state: 'working'}], errors: {}}), topology: async () => {}, openTask: async () => {}, pollMs: 60000});
  await runtime.start();
  spawned[0].report([`MAB1 ${SID} session_remote1 busy 1`]); await flush();
  const claude = runtime.snapshot().layers[1].slots.filter(Boolean);
  assert.deepEqual(claude.map(s => [s.title, s.state]).sort(), [['Local', 'working'], ['Remote', 'working']]);
  await runtime.stop(); assert.equal(spawned[0].killed, true);
});

test('supervise restarts only for the same Micro after link failures and stops on profile problems or Ctrl+C', async () => {
  const signals = new EventEmitter(), logs = [], device = [{key: 'same', path: 'p'}];
  let runs = 0, scans = [device, [{key: 'other', path: 'q'}], device, device];
  const run = async (devices, options, context) => {
    runs++; assert.equal(devices[0].key, 'same');
    if (runs === 1) { assert.equal(options.configureProfile, true); throw Error('Micro disconnected (zero-length HID read).'); }
    assert.equal(options.configureProfile, false, 'profile setup runs only once');
    signals.emit('SIGINT');
  };
  await supervise(device, {configureProfile: true}, {}, {run, signals, log: m => logs.push(m), wait: async () => {}, enumerate: async () => scans.shift() ?? device});
  assert.equal(runs, 2);
  assert.ok(logs.some(m => /waiting for the same Micro/.test(m)));
  await assert.rejects(supervise(device, {}, {}, {run: async () => { throw Error('Profile ownership device identity mismatch'); }, signals, log: () => {}, wait: async () => {}, enumerate: async () => device}), /identity mismatch/);
  assert.equal(recoverable(Error('Exclusive Micro open failed: Exclusive HID open failed (32)')), true);
  assert.equal(recoverable(Error('Host paused or system resumed; explicitly restart the Micro host.')), true);
  assert.equal(recoverable(Error('Profile changed before write; refusing overwrite')), false);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});
