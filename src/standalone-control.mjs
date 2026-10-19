import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {enumerateMicroDevices, enumerateMicroTopology, WindowsHidHandle, MicroHidTransport, connectionGuard} from './standalone-hid.mjs';
import {StandaloneProfile} from './standalone-profile.mjs';
import {StandaloneRuntime, readWindowsInventory} from './standalone-runtime.mjs';
import {acquireLock} from './lock.mjs';
import {RemoteClaudeStatus, remoteHosts} from './standalone-remotes.mjs';
export {session as runSession};

const help = `Windows standalone Micro host

  node src/standalone-control.mjs doctor
  node src/standalone-control.mjs status
  node src/standalone-control.mjs setup-profile --consent
  node src/standalone-control.mjs start
  node src/standalone-control.mjs restore-profile

doctor enumerates only; status opens exclusively and reads device.status.
setup-profile backs up and maps task rows on layers 1, 2, 3. --consent is required.
start owns HID until Ctrl+C; lower action controls are not implemented.
restore-profile restores owned task rows while preserving unrelated later edits.

Options: --state <directory>, --python <executable>, --home <directory>,
         --claude-data <directory>, --configure-profile --consent (with start),
         --remote <ssh-alias|user@host> (with start, repeatable): extra hosts
         for pinned remote Claude sessions; hosts are otherwise discovered from
         ~/.ssh/config and Tailscale (--no-remote-discovery disables that),
         --supervise (with start): after a disconnect or sleep, wait for the
         same Micro and start again with a fresh verified connection.

Use one Micro over one transport. If exclusive open fails, quit Codex/Input,
start this host from a separate terminal, then reopen Codex. Keep the connection
unchanged while running; reconnect and sleep require an explicit restart.
`;
export function parseArguments(args) {
  const options = {command: args[0] || 'doctor'};
  if (['--help', '-h', 'help'].includes(options.command)) return {command: 'help'};
  if (!['doctor', 'status', 'setup-profile', 'start', 'restore-profile'].includes(options.command)) throw Error('Unknown command; use --help');
  for (let i = 1; i < args.length; i++) {
    const name = args[i];
    if (name === '--consent') options.consent = true;
    else if (name === '--configure-profile') options.configureProfile = true;
    else if (name === '--no-remote-discovery') options.remoteDiscovery = false;
    else if (name === '--supervise') options.supervise = true;
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
  if ((options.remotes || options.remoteDiscovery === false || options.supervise) && options.command !== 'start') throw Error('--remote, --no-remote-discovery and --supervise are only valid with start');
  if (options.remotes) remoteHosts(options.remotes);
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.command === 'help') { console.log(help); return; }
  if (process.platform !== 'win32') throw Error('This standalone host requires Windows');
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Micro Agent Bridge');
  const stateDirectory = path.resolve(options.stateDirectory || path.join(base, 'standalone'));
  const devices = await enumerateMicroDevices();
  const inventory = () => readWindowsInventory({...options, stateDirectory});
  if (options.command === 'doctor') {
    let pins;
    try { const data = await inventory(); pins = {codex: data.codex.length, claude: data.claude.length, errors: data.errors}; }
    catch (error) { pins = {error: error.code || 'inventory-unavailable', message: 'Python inventory could not run; use --python with Python 3.10+.'}; }
    console.log(JSON.stringify({platform: process.platform, devices: devices.map(({path: _, serialNumber: __, ...d}) => d),
      exclusiveOpenTested: false, stateDirectory, pins,
      next: devices.length === 1 ? 'Run status to test exclusive access and read device status.' : 'Connect exactly one Codex Micro RPC interface.'}, null, 2));
    if (devices.length !== 1 || pins.error) process.exitCode = 1;
    return;
  }
  if (devices.length !== 1) throw Error(`Expected one Codex Micro RPC interface; found ${devices.length}. Use one device and one connection (USB or Bluetooth).`);
  fs.mkdirSync(base, {recursive: true}); fs.mkdirSync(stateDirectory, {recursive: true});
  // Global per-user lock prevents parallel hosts using different state directories.
  const release = acquireLock(path.join(base, 'standalone.pid'));
  try {
    if (options.command !== 'start' || !options.supervise) { await session(devices, options, {stateDirectory, inventory}); return; }
    await supervise(devices, options, {stateDirectory, inventory});
  } finally { release(); }
}

// Profile, identity and consent problems need a person; link problems can recover.
export const recoverable = error => !!error && !/profile|ownership|identity|consent|pending|configured rows|linkedApps/i.test(error.message);

// Each recovery is a complete fresh start: new exclusive open, topology guard,
// profile verification and repaint. Nothing from the previous connection is replayed.
export async function supervise(devices, options, context, {enumerate = enumerateMicroDevices, run = session, wait = ms => new Promise(r => setTimeout(r, ms)), signals = process, log = console.error} = {}) {
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
      throw Error(`Exclusive Micro open failed: ${error.message}. Quit Codex and Work Louder Input, start the host from a separate terminal, then reopen Codex.`);
    });
    transport = new MicroHidTransport(handle, {beforeRequest: topology});
    await topology();
    const profile = new StandaloneProfile({rpc: (method, params) => transport.rpc(method, params), stateDirectory, deviceKey: devices[0].key});
    if (options.command === 'status') {
      console.log(JSON.stringify({exclusive: true, device: await transport.rpc('device.status'), profile: await profile.inspect()}, null, 2)); return;
    }
    if (options.command === 'restore-profile') { console.log(JSON.stringify(await profile.restore(), null, 2)); return; }
    if (options.command === 'setup-profile' || options.configureProfile) {
      const result = await profile.configure({consent: options.consent});
      console.log(JSON.stringify({profile: result}, null, 2));
      if (options.command === 'setup-profile') return;
    }
    const current = await profile.inspect();
    if (current.pending) throw Error('Profile transaction pending. Retry setup-profile --consent or restore-profile before starting.');
    if (current.configured) await profile.verify();
    if (!current.configured) console.log('Profile is unchanged. Task keys require existing AG00–AG17 mappings; use setup-profile --consent to configure them.');
    const remote = new RemoteClaudeStatus({targets: options.remotes ?? [], discoverHosts: options.remoteDiscovery !== false, stateDirectory});
    runtime = new StandaloneRuntime({transport, inventory, topology, stateDirectory, remote});
    let previous, failure = null;
    runtime.on('state', snapshot => { const text = JSON.stringify(snapshot); if (text !== previous) { console.log(text); previous = text; } });
    runtime.on('notice', message => console.error(message));
    runtime.on('selected', selected => console.log(JSON.stringify({selected})));
    runtime.on('action', action => console.log(JSON.stringify({action})));
    const finished = new Promise(resolve => runtime.once('stopped', error => { failure = error; if (error) { console.error(error.message); if (handleSignals) process.exitCode = 1; } resolve(); }));
    const stop = () => { shared.userStopped = true; void runtime.stop(); };
    shared.stopCurrent = stop;
    if (handleSignals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
    try {
      await runtime.start();
      console.log('Micro host running with exclusive HID access. Ctrl+C stops and releases the device.');
      await finished;
      // Supervision decides whether a failure can recover; the CLI already printed it.
      if (failure && !handleSignals) throw failure;
    } finally { shared.stopCurrent = null; if (handleSignals) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); } }
  } finally {
    if (runtime) await runtime.stop();
    await transport?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
