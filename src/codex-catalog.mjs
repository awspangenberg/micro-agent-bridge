// Codex's Micro catalog, read from the installed Codex app so the options match its version:
// every app command (id, English title, default Windows shortcuts) and the keycap presets
// Codex offers for the action keys. Read-only; cached per Codex version in the state directory.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);

// Used when Codex isn't installed or its bundle can't be read.
export const FALLBACK = {version: null, commands: [
  {id: 'approval.approve', title: 'Approve', keys: ['Enter']}, {id: 'approval.decline', title: 'Decline', keys: ['Escape']},
  {id: 'navigateBack', title: 'Back', keys: ['Ctrl+[']}, {id: 'navigateForward', title: 'Forward', keys: ['Ctrl+]']},
  {id: 'toggleSidebar', title: 'Toggle sidebar', keys: ['Ctrl+B']}, {id: 'newTask', title: 'New task', keys: ['Ctrl+N']},
  {id: 'nextThreadNeedingAttention', title: 'Next chat needing attention', keys: ['Ctrl+Alt+A']},
  {id: 'composer.togglePlanMode', title: 'Toggle plan mode', keys: []}, {id: 'composer.toggleFastMode', title: 'Cycle speed', keys: []},
  {id: 'composer.increaseReasoningEffort', title: 'Increase reasoning effort', keys: []},
  {id: 'composer.decreaseReasoningEffort', title: 'Decrease reasoning effort', keys: []},
  {id: 'forkThread', title: 'Fork chat', keys: []}, {id: 'composer.submit', title: 'Send message', keys: []},
], keycaps: []};

/** Electron accelerators as Windows chords: CmdOrCtrl is Ctrl; macOS-only and mouse keys are dropped. */
export function windowsKey(key) {
  if (typeof key !== 'string' || /\b(?:Command|Cmd|Super|Meta|Mouse\w*)\b/.test(key.replace(/CmdOrCtrl/g, ''))) return null;
  return key.replace(/CmdOrCtrl|CommandOrControl/g, 'Ctrl').replace(/Option/g, 'Alt');
}

// "composer.togglePlanMode" -> "Toggle plan mode" when Codex ships no English title.
const humanize = id => { const s = id.split('.').pop().replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase(); return s[0].toUpperCase() + s.slice(1); };

function readAsar(file, wanted) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12)); fs.readSync(fd, json, 0, json.length, 16);
    const header = JSON.parse(json.toString()), base = 8 + head.readUInt32LE(4), found = {};
    (function walk(node, prefix) {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const p = prefix + '/' + name;
        if (entry.files) { walk(entry, p); continue; }
        const key = Object.keys(wanted).find(k => !found[k] && wanted[k].test(p));
        if (!key || entry.unpacked || entry.size > 64e6) continue;
        const buffer = Buffer.alloc(entry.size); fs.readSync(fd, buffer, 0, entry.size, base + Number(entry.offset));
        found[key] = buffer.toString('utf8');
      }
    })(header, '');
    return found;
  } finally { fs.closeSync(fd); }
}

// Command objects look like {id:`x`,titleIntlId:`...`,...,electron:{defaultKeybindings:[{key:`Ctrl+B`}],...}}.
export function parseCommands(registry, messages = '') {
  const titles = {};
  for (const m of messages.matchAll(/\{defaultMessage:`([^`]*)`,id:`codex\.command\.([A-Za-z0-9_.+-]+)`\}/g)) titles[m[2]] ??= m[1];
  const commands = new Map();
  const starts = [...registry.matchAll(/\{id:`([A-Za-z0-9_.+-]+)`,titleIntlId:`codex\.command\./g)];
  for (const [i, m] of starts.entries()) {
    if (commands.has(m[1])) continue;
    let body = registry.slice(m.index, starts[i + 1]?.index ?? m.index + 2000).slice(0, 2000);
    // Stop at the end of this command object so a neighbour's shortcuts are never attributed to it.
    let depth = 0;
    for (let j = 0; j < body.length; j++) {
      if (body[j] === '`') { j = body.indexOf('`', j + 1); if (j < 0) break; continue; }
      if (body[j] === '{') depth++;
      else if (body[j] === '}' && --depth === 0) { body = body.slice(0, j + 1); break; }
    }
    const keys = new Set();
    // A key such as `Ctrl+]` contains a bracket, so match whole {key:`...`} entries.
    for (const list of body.matchAll(/(?:defaultKeybindings|default):\[((?:\{key:`[^`]*`[^{}]*\},?)*)\]/g))
      for (const k of list[1].matchAll(/key:`([^`]+)`/g)) { const w = windowsKey(k[1]); if (w) keys.add(w); }
    commands.set(m[1], {id: m[1], title: titles[m[1]] ?? humanize(m[1]), keys: [...keys]});
  }
  return [...commands.values()];
}

// Keycap presets: {id:`FAST`,icon:`...`,size:`single`,action:{type:`command`,command:`composer.toggleFastMode`}}.
export function parseKeycaps(layout) {
  const keycaps = [];
  for (const m of layout.matchAll(/\{id:`([A-Z0-9+-]+)`,icon:`[^`]*`,size:`(single|double)`,action:\{type:`([a-z-]+)`(?:,command:`([^`]+)`)?(?:,label:`([^`]*)`)?(?:,(?:text|url):`([^`]*)`)?\}\}/g))
    keycaps.push({id: m[1], size: m[2], type: m[3], command: m[4] ?? null, label: m[5] ?? null, text: m[3] === 'composer-text' ? m[6] : null});
  return keycaps;
}

export async function codexInstall() {
  if (process.platform !== 'win32') return null;
  const {stdout} = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$p = Get-AppxPackage OpenAI.Codex | Select-Object -First 1; if ($p) { $p.Version; $p.InstallLocation }'], {windowsHide: true, timeout: 15000});
  const [version, location] = stdout.trim().split(/\r?\n/);
  return version && location ? {version: version.trim(), asar: path.join(location.trim(), 'app', 'resources', 'app.asar')} : null;
}

/** The catalog for the installed Codex, from the cache when the version matches. */
export async function loadCatalog(stateDirectory, {install = codexInstall} = {}) {
  const cacheFile = stateDirectory && path.join(stateDirectory, 'codex-catalog.json');
  let found = null;
  try { found = await install(); } catch { found = null; }
  if (!found) return FALLBACK;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached?.version === found.version && cached.commands?.length) return cached;
  } catch { /* Build it. */ }
  try {
    const files = readAsar(found.asar, {registry: /\/webview\/assets\/app-initial-[^/]*\.js$/, messages: /settings-search-documents-[^/]*\.js$/, layout: /\/codex-micro-layout-[^/]*\.js$/});
    const catalog = {version: found.version, commands: parseCommands(files.registry ?? '', files.messages ?? ''), keycaps: parseKeycaps(files.layout ?? '')};
    if (!catalog.commands.length) return FALLBACK;
    if (cacheFile) { fs.mkdirSync(stateDirectory, {recursive: true}); fs.writeFileSync(cacheFile, JSON.stringify(catalog)); }
    return catalog;
  } catch { return FALLBACK; }
}
