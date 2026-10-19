// Preview-only stand-in for the app shell, used when a page is opened in a plain browser.
// Add ?sim=busy, ?sim=twice or ?sim=linked to preview failure paths.
const scenario = new URLSearchParams(location.search).get('sim') ?? '';
const wait = ms => new Promise(r => setTimeout(r, ms));
const start = Date.now();
let configured = false, codexOpen = true, hooks = false, host = 'running', keyTimer;
const ok = value => ({code: 0, stdout: JSON.stringify(value), stderr: ''});
const fail = text => ({code: 1, stdout: '', stderr: text});

const tasks = {
  codex: ['Refactor the HID transport', 'Fix flaky disconnect test', 'Ship Windows installer', 'Profile restore edge cases'],
  claude: ['Draft onboarding copy', 'Review pairing flow', 'Tray icon states', 'Release notes for rc.4', 'Audit hook removal'],
};
const states = ['working', 'planning', 'approval', 'testing', 'completed', 'inactive', 'editing', 'question', 'command'];
function snapshot() {
  const t = Math.floor((Date.now() - start) / 4000);
  const slot = (provider, title, i) => title ? {provider, title, state: states[(i + t) % states.length]} : null;
  const six = (provider, list) => Array.from({length: 6}, (_, i) => slot(provider, list[i], i));
  const mixed = Array.from({length: 6}, (_, i) => i % 2 ? slot('claude', tasks.claude[i >> 1], i + 2) : slot('codex', tasks.codex[i >> 1], i + 1));
  return {layers: [{layer: 1, slots: six('codex', tasks.codex), waiting: 0}, {layer: 2, slots: six('claude', tasks.claude), waiting: 2}, {layer: 3, slots: mixed, waiting: 3}], errors: {}};
}
let ticker;

// A preview of the controls report, shaped like `standalone-control.mjs controls`.
let controlSettings = {version: 1, target: 'foreground', layers: {codex: {followCodex: true, overrides: {}}, claude: {followCodex: true, overrides: {}}, mixed: {followCodex: true, overrides: {}}}};
const ACTION_SPECS = {
  none: ['Nothing', true, true], approve: ['Approve', true, true, true], reject: ['Reject', true, true, true], stop: ['Stop the running turn', true, false],
  newTask: ['New task', true, true], dictate: ['Dictate while held', true, false], back: ['Back', true, true], forward: ['Forward', true, true],
  sidebar: ['Show or hide the sidebar', true, true], nextAttention: ['Next task needing you', true, true], prevTask: ['Previous pinned task', true, true],
  nextTask: ['Next pinned task', true, true], openTask: ['Open the selected task', true, true], openApp: ['Open the app', true, true],
  planMode: ['Toggle plan mode', false, false], fast: ['Cycle speed', false, false], fork: ['Fork the task', false, false],
};
const CODEX_SAYS = {bolt: 'fast', check: 'approve', cross: 'reject', branch: 'fork', mic: 'dictate', app: 'openApp', knobLeft: 'prevTask', knobRight: 'nextTask', knobPress: 'openTask', up: 'planMode', right: 'forward', down: 'sidebar', left: 'back'};
const BRIDGE_DEFAULTS = {bolt: 'stop', check: 'approve', cross: 'reject', branch: 'newTask', mic: 'dictate', app: 'openApp', knobLeft: 'prevTask', knobRight: 'nextTask', knobPress: 'openTask', knobHold: 'nextAttention', up: 'prevTask', down: 'nextTask', left: 'back', right: 'forward'};
function previewControls() {
  const actions = Object.fromEntries(Object.entries(ACTION_SPECS).map(([id, [label, claude, codex, guarded]]) => [id, {label, claude: id !== 'none' && claude, codex: id !== 'none' && codex, guarded: !!guarded}]));
  const mapping = {};
  for (const [i, layer] of ['codex', 'claude', 'mixed'].entries()) {
    const providers = i === 0 ? ['codex'] : i === 1 ? ['claude'] : ['claude', 'codex'], conf = controlSettings.layers[layer];
    mapping[layer] = {};
    for (const control of Object.keys(BRIDGE_DEFAULTS)) {
      let action = BRIDGE_DEFAULTS[control], source = 'default';
      const says = CODEX_SAYS[control];
      if (conf.followCodex && says) { if (providers.some(p => actions[says][p])) { action = says; source = 'codex'; } else source = 'default-for-unsupported'; }
      if (conf.overrides[control]) { action = conf.overrides[control]; source = 'override'; }
      mapping[layer][control] = {action, source, codexAction: says ?? null, runs: Object.fromEntries(providers.map(p => [p, actions[action][p]]))};
    }
  }
  return {settings: controlSettings, codexSettingsFound: true, mapping, controls: Object.keys(BRIDGE_DEFAULTS), actions};
}

export async function call(cmd, args, emit) {
  await wait(cmd === 'doctor' ? 500 : 250);
  switch (cmd) {
    case 'env': return {version: 'preview', onboarded: false, startup: true, alerts: true, hooks, codexInstalled: true, claudeInstalled: true, policy: null, hostRunning: false};
    case 'doctor': {
      const elapsed = Date.now() - start;
      const devices = elapsed < 5000 ? [] : scenario === 'twice' ? [{key: 'a', transport: 'usb'}, {key: 'b', transport: 'bluetooth'}] : [{key: 'a', product: 'Codex Micro', transport: 'bluetooth'}];
      // A Claude task gets pinned a few seconds in, to preview live updates.
      return ok({platform: 'win32', devices, pins: {codex: 0, claude: elapsed < 7000 ? 0 : 1, errors: {}}});
    }
    case 'running': return {codex: codexOpen ? 1 : 0, input: 0};
    case 'quit': await wait(900); codexOpen = false; return 0;
    case 'bluetooth': case 'openCodex': case 'link': case 'openSetup': return true;
    case 'status':
      await wait(900);
      if (scenario === 'busy' || codexOpen) return fail('Exclusive Micro open failed: Windows error 32. Quit Codex and Work Louder Input, start the host from a separate terminal, then reopen Codex.');
      return ok({exclusive: true, transport: 'bluetooth', device: {status: 'connected'}, firmware: {version: '0.6.2'}, profile: {configured, pending: false}});
    case 'configure':
      await wait(1600);
      if (scenario === 'linked') return fail('Automatic application mapping (linkedApps) prevents profile configuration');
      configured = true;
      return ok({profile: {configured: true, changed: true, backupPath: 'C:\\Users\\you\\AppData\\Local\\Micro Agent Bridge\\standalone\\backups\\keymap-original.json'}});
    case 'keyTestStart': {
      emit({event: 'keytest', data: {type: 'ready', keys: 18}});
      const presses = [[1, 3], [2, 1], [3, 5]];
      let n = 0;
      clearInterval(keyTimer);
      keyTimer = setInterval(() => {
        const [layer, slot] = presses[n++];
        emit({event: 'keytest', data: {type: 'layer', layerIndex: layer - 1}});
        emit({event: 'keytest', data: {type: 'press', key: 'AG' + String((layer - 1) * 6 + slot - 1).padStart(2, '0'), layer, slot, layersDone: n}});
        if (n === 3) { clearInterval(keyTimer); emit({event: 'keytest', data: {type: 'done', result: 'complete', layers: [1, 2, 3], keys: 3}}); }
      }, 1800);
      return true;
    }
    case 'keyTestStop': clearInterval(keyTimer); return true;
    case 'hooks': hooks = !!args.enable; return hooks;
    case 'startup': case 'alerts': return !!args.enable;
    case 'finish': location.href = 'dashboard.html?welcome=1'; return true;
    case 'restore': await wait(1500); return ok({restored: true, changed: true});
    case 'hostState':
      clearInterval(ticker);
      ticker = setInterval(() => host === 'running' && emit({event: 'host', data: {type: 'state', snapshot: snapshot()}}), 4000);
      return {status: host, message: 'Running over Bluetooth', transport: 'bluetooth', state: {snapshot: snapshot()}};
    case 'hostStop': host = 'stopped'; emit({event: 'status', status: 'stopped', message: ''}); return true;
    case 'hostStart':
      host = 'starting'; emit({event: 'status', status: 'starting', message: ''});
      await wait(1200); host = 'running';
      emit({event: 'status', status: 'running', message: 'Running over Bluetooth', state: {snapshot: snapshot()}});
      return true;
    case 'controls': return ok(previewControls());
    case 'controlsSet': controlSettings = args.settings; return true;
    default: throw new Error('Simulator has no ' + cmd);
  }
}
