import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {enumerateMicroDevices, enumerateMicroTopology, WindowsHidHandle, MicroHidTransport, connectionGuard} from './standalone-hid.mjs';
import {StandaloneProfile} from './standalone-profile.mjs';
import {StandaloneRuntime, readWindowsInventory} from './standalone-runtime.mjs';
import {acquireLock} from './lock.mjs';
import {RemoteClaudeStatus, remoteHosts} from './standalone-remotes.mjs';
import {clearFrame} from './micro-protocol.mjs';
import {CONTROLS, ACTIONS, effectiveMapping, readSettings, readCodexLayout, supported} from './standalone-controls.mjs';
export {session as runSession};

const help = `Windows standalone Micro host

  node src/standalone-control.mjs doctor
  node src/standalone-control.mjs status
  node src/standalone-control.mjs setup-profile --consent
  node src/standalone-control.mjs start
  node src/standalone-control.mjs restore-profile
  node src/standalone-control.mjs test-keys
  node src/standalone-control.mjs watch-input [--seconds N]
  node src/standalone-control.mjs controls

doctor enumerates only; status opens exclusively and reads device.status.
setup-profile backs up and maps task rows on layers 1, 2, 3. --consent is required.
start owns HID until Ctrl+C; lower action controls are not implemented.
restore-profile restores owned task rows while preserving unrelated later edits.
test-keys lights the configured task keys and reports presses until each layer
has one, then clears them (setup verification; opens no task).

Options: --state <directory>, --python <executable>, --home <directory>,
         --ndjson (start, test-keys): one JSON event per line on stdout,
         --stdin-control (start, test-keys): a "stop" line or closed stdin
         stops like Ctrl+C (for a supervising app),
         --claude-data <directory>, --configure-profile --consent (with start),
         --remote <ssh-alias|user@host> (with start, repeatable): extra hosts
         for pinned remote Claude sessions; hosts are otherwise discovered from
         ~/.ssh/config and Tailscale (--no-remote-discovery disables that),
         --supervise (with start): after a disconnect or sleep, wait for the
         same Micro and start again with a fresh verified connection,
         --wait-for-device (with start): wait for exactly one Micro to be
         connected instead of failing (for start at sign-in).

Use one Micro over one transport. If exclusive open fails, quit Codex/Input,
start this host from a separate terminal, then reopen Codex. Keep the connection
unchanged while running; reconnect and sleep require an explicit restart.
`;
export function parseArguments(args) {
  const options = {command: args[0] || 'doctor'};
  if (['--help', '-h', 'help'].includes(options.command)) return {command: 'help'};
  if (!['doctor', 'status', 'setup-profile', 'start', 'restore-profile', 'test-keys', 'watch-input', 'controls'].includes(options.command)) throw Error('Unknown command; use --help');
  for (let i = 1; i < args.length; i++) {
    const name = args[i];
    if (name === '--consent') options.consent = true;
    else if (name === '--ndjson') options.ndjson = true;
    else if (name === '--stdin-control') options.stdinControl = true;
    else if (name === '--configure-profile') options.configureProfile = true;
    else if (name === '--no-remote-discovery') options.remoteDiscovery = false;
    else if (name === '--supervise') options.supervise = true;
    else if (name === '--wait-for-device') options.waitForDevice = true;
    else if (name === '--seconds') {
      const seconds = Number(args[++i]);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw Error('--seconds takes 1 to 3600');
      options.seconds = seconds;
    }
    else if (name === '--remote') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw Error('Missing value for --remote');
      (options.remotes ??= []).push(args[++i]);
    } else if (['--state', '--python', '--home', '--claude-data'].includes(name)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value for ${name}`);
      options[{'--state': 'stateDirectory', '--python': 'python', '--home': 'home', '--claude-data': 'claudeData'}[name]] = args[++i];
    } else throw Error(`Unknown option: ${name}`);
  }
  if ((options.command === 'setup-profile' || options.configureProfile) && !options.consent) throw Error('Profile setup requires --consent');
  if (options.configureProfile && options.command !== 'start') throw Error('--configure-profile is only valid with start');
  if ((options.remotes || options.remoteDiscovery === false || options.supervise || options.waitForDevice) && options.command !== 'start') throw Error('--remote, --no-remote-discovery, --supervise and --wait-for-device are only valid with start');
  if ((options.ndjson || options.stdinControl) && !['start', 'test-keys', 'watch-input'].includes(options.command)) throw Error('--ndjson and --stdin-control are only valid with start, test-keys or watch-input');
  if (options.seconds && options.command !== 'watch-input') throw Error('--seconds is only valid with watch-input');
  if (options.remotes) remoteHosts(options.remotes);
  return options;
}

// Text for a person at a terminal, or one typed JSON event per line for a supervising app.
export function reporter(ndjson, write = line => process.stdout.write(line + '\n')) {
  return (type, payload = {}, text) => {
    if (ndjson) { write(JSON.stringify({type, ...payload})); return; }
    if (text !== undefined) (['notice', 'waiting', 'error'].includes(type) ? console.error : console.log)(text);
    else console.log(JSON.stringify(type === 'state' ? payload.snapshot : payload));
  };
}
let report = reporter(false);

// Bluetooth LE HID paths carry the HID-over-GATT service UUID; USB paths carry VID/PID.
export const transportOf = devicePath => /bthle|00001812-0000-1000-8000-00805f9b34fb/i.test(devicePath ?? '') ? 'bluetooth' : /usb|vid_303a/i.test(devicePath ?? '') ? 'usb' : 'unknown';

// A supervising app stops the host by writing "stop" or by closing stdin (it exited).
function stdinControl() {
  let buffer = '', stopped = false;
  const stop = () => { if (!stopped) { stopped = true; process.emit('SIGINT'); } };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buffer = (buffer + chunk).slice(-1024); if (/(^|\n)stop\r?\n/.test(buffer)) stop(); });
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  return () => { process.stdin.pause(); process.stdin.unref?.(); };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.command === 'help') { console.log(help); return; }
  report = reporter(!!options.ndjson);
  if (process.platform !== 'win32') throw Error('This standalone host requires Windows');
  const releaseStdin = options.stdinControl ? stdinControl() : () => {};
  try { await command(options); } finally { releaseStdin(); }
}

async function command(options) {
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Micro Agent Bridge');
  const stateDirectory = path.resolve(options.stateDirectory || path.join(base, 'standalone'));
  if (options.command === 'controls') {
    // What each lower control does on each layer, for the dashboard. Opens no device.
    const settings = readSettings(stateDirectory), codexLayout = readCodexLayout(options.home);
    console.log(JSON.stringify({settings, codexSettingsFound: Boolean(codexLayout), mapping: effectiveMapping(settings, codexLayout),
      controls: CONTROLS, actions: Object.fromEntries(Object.entries(ACTIONS).map(([id, a]) => [id, {label: a.label,
        claude: supported(id, 'claude'), codex: supported(id, 'codex'), guarded: a.guard === 'approval'}]))}));
    return;
  }
  let devices = await enumerateMicroDevices();
  if (options.waitForDevice && devices.length !== 1) { devices = await waitForDevice(devices); if (!devices) return; }
  const inventory = () => readWindowsInventory({...options, stateDirectory});
  if (options.command === 'doctor') {
    let pins;
    try { const data = await inventory(); pins = {codex: data.codex.length, claude: data.claude.length, errors: data.errors}; }
    catch (error) { pins = {error: error.code || 'inventory-unavailable', message: 'Python inventory could not run; use --python with Python 3.10+.'}; }
    console.log(JSON.stringify({platform: process.platform, devices: devices.map(({path: p, serialNumber: _, ...d}) => ({...d, transport: transportOf(p)})),
      exclusiveOpenTested: false, stateDirectory, pins,
      next: devices.length === 1 ? 'Run status to test exclusive access and read device status.' : 'Connect exactly one Codex Micro RPC interface.'}, null, 2));
    if (devices.length !== 1 || pins.error) process.exitCode = 1;
    return;
  }
  if (devices.length !== 1) throw Object.assign(Error(`Expected one Codex Micro RPC interface; found ${devices.length}. Use one device and one connection (USB or Bluetooth).`), {code: devices.length ? 'multiple-devices' : 'no-device'});
  fs.mkdirSync(base, {recursive: true}); fs.mkdirSync(stateDirectory, {recursive: true});
  // Global per-user lock prevents parallel hosts using different state directories.
  const release = acquireLock(path.join(base, 'standalone.pid'));
  try {
    if (options.command !== 'start' || !options.supervise) { await session(devices, options, {stateDirectory, inventory}); return; }
    await supervise(devices, options, {stateDirectory, inventory});
  } finally { release(); }
}

// At sign-in a Bluetooth Micro may connect after the host starts. Waits without opening anything;
// returns null when stopped first.
export async function waitForDevice(devices, {enumerate = enumerateMicroDevices, wait = ms => new Promise(r => setTimeout(r, ms)), signals = process} = {}) {
  let stopped = false, last = '';
  const onStop = () => { stopped = true; };
  signals.once('SIGINT', onStop); signals.once('SIGTERM', onStop);
  try {
    while (!stopped) {
      const code = devices.length ? 'multiple-devices' : 'no-device';
      if (code !== last) {
        report('waiting', {code, message: devices.length ? 'More than one Micro connection found; keep only one.' : 'Waiting for your Micro to connect.'},
          devices.length ? 'More than one Micro connection found; keep only one. Waiting…' : 'Waiting for your Micro to connect. Ctrl+C to quit.');
        last = code;
      }
      await wait(2000);
      if (stopped) break;
      devices = await enumerate().catch(() => []);
      if (devices.length === 1) return devices;
    }
    return null;
  } finally { signals.removeListener('SIGINT', onStop); signals.removeListener('SIGTERM', onStop); }
}

// Profile, identity and consent problems need a person; link problems can recover.
export const recoverable = error => !!error && !/profile|ownership|identity|consent|pending|configured rows|linkedApps/i.test(error.message);

// Each recovery is a complete fresh start: new exclusive open, topology guard,
// profile verification and repaint. Nothing from the previous connection is replayed.
export async function supervise(devices, options, context, {enumerate = enumerateMicroDevices, run = session, wait = ms => new Promise(r => setTimeout(r, ms)), signals = process, log = message => report('waiting', {message}, message)} = {}) {
  const key = devices[0].key;
  let interrupted = false, current = devices, first = true, lastMessage = '';
  const onSignal = () => { interrupted = true; context.stopCurrent?.(); };
  signals.on('SIGINT', onSignal); signals.on('SIGTERM', onSignal);
  try {
    while (!interrupted) {
      const error = await run(current, {...options, configureProfile: first && options.configureProfile}, context, {handleSignals: false}).then(() => null, e => e);
      first = false;
      if (interrupted || (!error && context.userStopped)) return;
      if (error && !recoverable(error)) throw error;
      const message = `Micro host stopped (${error?.message ?? 'device released'}); waiting for the same Micro to reconnect. Ctrl+C to quit.`;
      if (message !== lastMessage) log(message);
      lastMessage = message;
      let notice = 0;
      for (;;) {
        if (interrupted) return;
        await wait(1000);
        const found = await enumerate().catch(() => []);
        if (found.length === 1 && found[0].key === key) { await wait(2000); current = await enumerate().catch(() => []); if (current.length === 1 && current[0].key === key) break; }
        if (found.length === 1 && found[0].key !== key && Date.now() - notice > 60000) { notice = Date.now(); log('A Micro with a different identity is connected; waiting for the original. Use a separate --state for a new pairing.'); }
      }
    }
  } finally { signals.removeListener('SIGINT', onSignal); signals.removeListener('SIGTERM', onSignal); }
}

async function session(devices, options, shared, {handleSignals = true} = {}) {
  const {stateDirectory, inventory} = shared;
  let transport, runtime;
  shared.userStopped = false;
  const topology = connectionGuard(enumerateMicroTopology, devices[0].path);
  try {
    const handle = await WindowsHidHandle.open(devices, devices[0].path).catch(error => {
      throw Object.assign(Error(`Exclusive Micro open failed: ${error.message}. Quit Codex and Work Louder Input, start the host from a separate terminal, then reopen Codex.`), {code: 'exclusive-open'});
    });
    transport = new MicroHidTransport(handle, {beforeRequest: topology});
    await topology();
    const profile = new StandaloneProfile({rpc: (method, params) => transport.rpc(method, params), stateDirectory, deviceKey: devices[0].key});
    if (options.command === 'status') {
      const device = await transport.rpc('device.status');
      // Firmware identification is informational; older firmware may not answer it.
      const firmware = await transport.rpc('sys.version').catch(() => null);
      console.log(JSON.stringify({exclusive: true, transport: transportOf(devices[0].path), device, firmware, profile: await profile.inspect()}, null, 2)); return;
    }
    if (options.command === 'watch-input') { await watchInput(transport, {seconds: options.seconds ?? 120}); return; }
    if (options.command === 'restore-profile') { console.log(JSON.stringify(await profile.restore(), null, 2)); return; }
    if (options.command === 'setup-profile' || options.configureProfile) {
      const result = await profile.configure({consent: options.consent});
      report('profile', {profile: result}, JSON.stringify({profile: result}, null, 2));
      if (options.command === 'setup-profile') return;
    }
    const current = await profile.inspect();
    if (current.pending) throw Error('Profile transaction pending. Retry setup-profile --consent or restore-profile before starting.');
    if (current.configured) await profile.verify();
    if (options.command === 'test-keys') {
      if (!current.configured) throw Error('Task keys are not configured; run setup-profile --consent first.');
      const result = await keyTest(transport, {handleSignals});
      if (result !== 'complete' && handleSignals) process.exitCode = 1;
      return;
    }
    if (!current.configured) report('notice', {code: 'profile-unconfigured'}, 'Profile is unchanged. Task keys require existing AG00–AG17 mappings; use setup-profile --consent to configure them.');
    const remote = new RemoteClaudeStatus({targets: options.remotes ?? [], discoverHosts: options.remoteDiscovery !== false, stateDirectory});
    runtime = new StandaloneRuntime({transport, inventory, topology, stateDirectory, remote});
    let previous, failure = null;
    runtime.on('state', snapshot => { const text = JSON.stringify(snapshot); if (text !== previous) { report('state', {snapshot}); previous = text; } });
    runtime.on('notice', message => report('notice', {message}, message));
    runtime.on('selected', selected => report('selected', {selected}));
    runtime.on('action', action => report('action', {action}));
    runtime.on('layer', layerIndex => { if (options.ndjson) report('layer', {layerIndex}); });
    const finished = new Promise(resolve => runtime.once('stopped', error => { failure = error; if (error) { report('error', {message: error.message}, error.message); if (handleSignals) process.exitCode = 1; } resolve(); }));
    const stop = () => { shared.userStopped = true; void runtime.stop(); };
    shared.stopCurrent = stop;
    if (handleSignals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
    try {
      await runtime.start();
      report('running', {transport: transportOf(devices[0].path), configured: current.configured}, 'Micro host running with exclusive HID access. Ctrl+C stops and releases the device.');
      await finished;
      // Supervision decides whether a failure can recover; the CLI already printed it.
      if (failure && !handleSignals) throw failure;
    } finally { shared.stopCurrent = null; if (handleSignals) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); } }
  } finally {
    if (runtime) await runtime.stop();
    await transport?.close();
  }
}

// Diagnostic: print every device notification (keys, knob, joystick, layer) with a timestamp,
// for mapping controls. Ends after `seconds`, on Ctrl+C or disconnect.
export async function watchInput(transport, {seconds = 120, signals = process, now = Date.now} = {}) {
  const start = now();
  // The Micro reports input to a host that is driving it, as the bridge does: read the status
  // and blank the bridge's own key lights (the only write; layer profiles are untouched).
  const status = await transport.rpc('device.status');
  for (const bank of [0, 6, 12]) await transport.rpc('v.oai.thstatus', clearFrame(bank));
  report('ready', {seconds, status}, `Watching Micro input for ${seconds} s (device ${JSON.stringify(status)}). Press controls; Ctrl+C ends.`);
  const reason = await new Promise(resolve => {
    const finish = why => {
      clearTimeout(timer); transport.removeListener('notification', onNote); transport.removeListener('closed', onClosed);
      signals.removeListener('SIGINT', onStop); signals.removeListener('SIGTERM', onStop); resolve(why);
    };
    const onNote = note => report('notification', {ms: now() - start, ...note}, `${String(now() - start).padStart(7)} ms  ${note.method}  ${JSON.stringify(note.params)}`);
    const onClosed = () => finish('disconnected'), onStop = () => finish('stopped');
    const timer = setTimeout(() => finish('timeout'), seconds * 1000);
    transport.on('notification', onNote); transport.once('closed', onClosed);
    signals.once('SIGINT', onStop); signals.once('SIGTERM', onStop);
  });
  report('done', {result: reason}, `Stopped watching (${reason}).`);
  return reason;
}

// Verification for onboarding: light every task key, report each press, and finish
// once a key on each of the three layers was pressed. Opens no task.
export const KEY_TEST = {waiting: {c: 0xffffff, b: .4, e: 6, s: .3}, pressed: {c: 0x00ff66, b: .6, e: 1, s: 0}};
export async function keyTest(transport, {handleSignals = true, timeoutMs = 180000, signals = process} = {}) {
  const pressed = new Set(), layers = new Set();
  const frame = bank => Array.from({length: 6}, (_, i) => ({id: bank + i, ...KEY_TEST[pressed.has(bank + i) ? 'pressed' : 'waiting'], sk: 0, sa: 0}));
  const paint = async banks => { for (const bank of banks) await transport.rpc('v.oai.thstatus', frame(bank)); };
  await paint([0, 6, 12]);
  report('ready', {keys: 18}, 'Press any lit task key on each of the three layers. Ctrl+C ends the test.');
  const result = await new Promise(resolve => {
    let done = false;
    const finish = reason => {
      if (done) return; done = true; clearTimeout(timer);
      transport.removeListener('input', onInput); transport.removeListener('layer', onLayer); transport.removeListener('closed', onClosed);
      if (handleSignals) { signals.removeListener('SIGINT', onStop); signals.removeListener('SIGTERM', onStop); }
      resolve(reason);
    };
    const onInput = event => {
      if (event.act !== 1 || !/^AG(?:0[0-9]|1[0-7])$/.test(event.key)) return;
      const id = Number(event.key.slice(2)), fresh = !pressed.has(id);
      pressed.add(id); layers.add(Math.floor(id / 6));
      report('press', {key: event.key, layer: Math.floor(id / 6) + 1, slot: id % 6 + 1, layersDone: layers.size},
        `Layer ${Math.floor(id / 6) + 1}, key ${id % 6 + 1} works (${layers.size}/3 layers).`);
      if (layers.size === 3) finish('complete');
      else if (fresh) void paint([Math.floor(id / 6) * 6]).catch(() => finish('disconnected'));
    };
    const onLayer = event => report('layer', {layerIndex: event.layerIndex}, `Layer ${event.layerIndex + 1} selected.`);
    const onClosed = () => finish('disconnected');
    const onStop = () => finish('stopped');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    transport.on('input', onInput); transport.on('layer', onLayer); transport.once('closed', onClosed);
    if (handleSignals) { signals.once('SIGINT', onStop); signals.once('SIGTERM', onStop); }
  });
  if (!transport.closed) for (const bank of [0, 6, 12]) await transport.rpc('v.oai.thstatus', clearFrame(bank)).catch(() => {});
  report('done', {result, layers: [...layers].sort().map(l => l + 1), keys: pressed.size},
    result === 'complete' ? 'All three layers respond. Setup is verified.' : `Key test ended: ${result}.`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { report('fatal', {message: error.message, code: error.code ?? null}, error.message); process.exitCode = 1; });
}
