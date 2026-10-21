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
const layerConf = () => ({followCodex: true, agentKeys: 'pinned', knobMode: null, overrides: {}});
let controlSettings = {version: 2, target: 'foreground', codexShortcuts: false, lights: {providers: {}, keys: {}, ring: {}}, layers: {codex: layerConf(), claude: layerConf(), mixed: layerConf()}};
// [id, label, runs in Claude, has a Codex shortcut]
const ACTION_SPECS = [
  ['none', 'Nothing', false, false], ['ptt', 'Push to talk (hold)', true, false], ['stop', 'Stop the running turn', true, false],
  ['prevTask', 'Previous task on this layer', true, true], ['nextTask', 'Next task on this layer', true, true], ['openTask', 'Open the selected task', true, true],
  ['nextAttention', 'Next task needing you', true, true], ['openApp', 'Open the app (Codex, Claude, or the one that last needed you)', true, true],
  ['scrollUp', 'Scroll the conversation up', true, false], ['scrollDown', 'Scroll the conversation down', true, false],
  ['cmd:approval.approve', 'Approve', true, true], ['cmd:approval.decline', 'Decline', true, true], ['cmd:newTask', 'New task', true, true],
  ['cmd:navigateBack', 'Back', true, true], ['cmd:navigateForward', 'Forward', true, true], ['cmd:toggleSidebar', 'Toggle sidebar', true, true],
  ['cmd:composer.togglePlanMode', 'Toggle plan mode', true, false], ['cmd:composer.toggleFastMode', 'Cycle speed', true, false],
  ['cmd:composer.increaseReasoningEffort', 'Increase reasoning effort', true, false], ['cmd:composer.decreaseReasoningEffort', 'Decrease reasoning effort', true, false],
  ['cmd:forkThread', 'Fork chat', false, false], ['cmd:toggleTerminal', 'Toggle terminal', false, true], ['cmd:openSettings', 'Open settings', false, true],
  ['text::yolo:', 'Write :yolo:', false, true], ['url:https://developers.openai.com', 'Open https://developers.openai.com', true, true],
];
const CODEX_SAYS = {bolt: 'cmd:composer.toggleFastMode', check: 'cmd:approval.approve', cross: 'cmd:approval.decline', branch: 'cmd:forkThread', mic: 'ptt', app: 'openApp',
  knobLeft: 'prevTask', knobRight: 'nextTask', knobPress: 'openTask', up: 'cmd:composer.togglePlanMode', right: 'cmd:navigateForward', down: 'cmd:toggleSidebar', left: 'cmd:navigateBack'};
const BRIDGE_DEFAULTS = {bolt: 'stop', check: 'cmd:approval.approve', cross: 'cmd:approval.decline', branch: 'cmd:newTask', mic: 'ptt', app: 'openApp',
  knobLeft: 'prevTask', knobRight: 'nextTask', knobPress: 'openTask', knobHold: 'nextAttention', up: 'prevTask', down: 'nextTask', left: 'cmd:navigateBack', right: 'cmd:navigateForward'};
const KNOB = {'composer-navigation': {knobLeft: 'prevTask', knobRight: 'nextTask', knobPress: 'openTask'},
  reasoning: {knobLeft: 'cmd:composer.increaseReasoningEffort', knobRight: 'cmd:composer.decreaseReasoningEffort'}, 'conversation-scroll': {knobLeft: 'scrollUp', knobRight: 'scrollDown'}};
// The host's default lights (standalone-palette.mjs DEFAULT_LIGHTS) and its merge of overrides.
const DEFAULT_LIGHTS = {"providers":{"codex":26367,"claude":16750848},"keys":{"approval":{"c":16724736,"b":0.6,"e":4,"s":1},"question":{"c":16711935,"b":0.6,"e":4,"s":1},"planning":{"c":9055202,"b":0.5,"e":6,"s":0.3},"testing":{"c":16764928,"b":0.5,"e":6,"s":0.3},"command":{"c":52479,"b":0.5,"e":6,"s":0.3},"editing":{"c":65450,"b":0.5,"e":6,"s":0.3},"working":{"c":null,"b":0.55,"e":6,"s":0.3},"completed":{"c":65280,"b":0.5,"e":1,"s":0},"error":{"c":16711680,"b":0.5,"e":1,"s":0},"disconnected":{"c":16711680,"b":0.35,"e":6,"s":0.3},"inactive":{"c":null,"b":0.15,"e":1,"s":0}},"ring":{"approval":{"c":16724736,"b":0.6,"e":4,"s":1},"question":{"c":16711935,"b":0.6,"e":4,"s":1},"error":{"c":16711680,"b":0.45,"e":4,"s":0.3},"working":{"c":null,"b":0.45,"e":2,"s":0.3},"both":{"c":16777215,"b":0.45,"e":2,"s":0.3},"idle":{"c":0,"b":0,"e":0,"s":0}}};
function resolveLights(o) {
  const int = c => typeof c === 'string' ? parseInt(c.slice(1), 16) : c, out = structuredClone(DEFAULT_LIGHTS);
  for (const [p, c] of Object.entries(o.providers)) out.providers[p] = int(c);
  for (const part of ['keys', 'ring']) for (const [k, v] of Object.entries(o[part])) out[part][k] = {...out[part][k], ...v, c: v.c === undefined ? out[part][k].c : int(v.c)};
  return out;
}
function previewControls() {
  const spec = Object.fromEntries(ACTION_SPECS.map(([id, label, claude, codex]) => [id, {label, claude, codex}]));
  const runs = (id, p) => id !== 'none' && (p === 'claude' ? spec[id].claude : spec[id].codex || (controlSettings.codexShortcuts && id.startsWith('cmd:')));
  const actions = ACTION_SPECS.map(([id, label]) => ({id, label, claude: runs(id, 'claude'), codex: runs(id, 'codex'), registrable: id.startsWith('cmd:') && !spec[id].codex}));
  const mapping = {};
  for (const [i, layer] of ['codex', 'claude', 'mixed'].entries()) {
    const providers = i === 0 ? ['codex'] : i === 1 ? ['claude'] : ['claude', 'codex'], conf = controlSettings.layers[layer];
    mapping[layer] = {};
    for (const control of Object.keys(BRIDGE_DEFAULTS)) {
      let action = BRIDGE_DEFAULTS[control], source = 'default';
      const says = CODEX_SAYS[control];
      if (conf.followCodex && says) { if (providers.some(p => runs(says, p))) { action = says; source = 'codex'; } else source = 'default-for-unsupported'; }
      if (conf.knobMode && KNOB[conf.knobMode][control]) { action = KNOB[conf.knobMode][control]; source = 'knob-mode'; }
      if (conf.overrides[control]) { action = conf.overrides[control]; source = 'override'; }
      mapping[layer][control] = {action, source, codexAction: says ?? null, runs: Object.fromEntries(providers.map(p => [p, runs(action, p)]))};
    }
  }
  const now = Date.now();
  const recent = [{layer: 2, control: 'knobRight', action: 'nextTask', performed: true, reason: null, at: now - 42000},
    {layer: 2, control: 'check', action: 'cmd:approval.approve', performed: false, reason: 'task-not-bound', at: now - 30000},
    {layer: 1, control: 'up', action: 'cmd:composer.togglePlanMode', performed: false, reason: 'no-codex-shortcut', at: now - 9000}];
  const keycaps = [{id: 'FAST', size: 'single', action: 'cmd:composer.toggleFastMode'}, {id: 'APPR', size: 'single', action: 'cmd:approval.approve'},
    {id: 'TERM', size: 'single', action: 'cmd:toggleTerminal'}, {id: 'YOLO', size: 'single', action: 'text::yolo:'}, {id: 'MIC', size: 'double', action: 'ptt'}];
  return {settings: controlSettings, codexSettingsFound: true, codexVersion: '26.1016.6573.0', profileUpdate: false, recent, mapping, controls: Object.keys(BRIDGE_DEFAULTS),
    actions, keycaps, knobModes: Object.keys(KNOB), lights: {effective: resolveLights(controlSettings.lights), defaults: DEFAULT_LIGHTS}, shortcuts: {enabled: controlSettings.codexShortcuts, file: 'C:\Users\you\.codex\keybindings.json',
      registered: controlSettings.codexShortcuts ? [{command: 'composer.togglePlanMode', key: 'Ctrl+Alt+Shift+F13'}] : []}};
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
      ticker = setInterval(() => {
        if (host !== 'running') return;
        emit({event: 'host', data: {type: 'state', snapshot: snapshot()}});
        // Every so often, a knob turn on the layer shown, to preview live press feedback.
        if (Math.random() < 0.3) emit({event: 'host', data: {type: 'action', action: {layer: 2, control: 'knobRight', action: 'nextTask', performed: true, reason: null}}});
      }, 4000);
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
