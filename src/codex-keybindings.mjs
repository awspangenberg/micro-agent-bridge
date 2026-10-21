// Opt-in: gives Codex commands that have no keyboard shortcut an otherwise unused one, so the
// bridge can trigger them while Codex is in front. Entries go into Codex's own
// keybindings.json ([{command, key}]); the bridge records exactly what it added, never changes
// or removes anyone else's entries, and removes its own on request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const keybindingsPath = (env = process.env, home = os.homedir()) => path.join(env.CODEX_HOME || path.join(home, '.codex'), 'keybindings.json');
const ownedPath = stateDirectory => path.join(stateDirectory, 'codex-keybindings-owned.json');

// Function keys F13-F24 have no physical key on most keyboards, so these chords collide with nothing.
export const POOL = ['Ctrl+Alt+Shift', 'Ctrl+Shift', 'Alt+Shift', 'Ctrl+Alt'].flatMap(m => Array.from({length: 12}, (_, i) => `${m}+F${13 + i}`));

function readJson(file, fallback) {
  try { const text = fs.readFileSync(file, 'utf8'); return text.trim() ? JSON.parse(text) : fallback; } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}
const same = (a, b) => a.command === b.command && a.key === b.key;

export function readBindings(file = keybindingsPath()) {
  const value = readJson(file, []);
  if (!Array.isArray(value)) throw Error('Codex keybindings.json is not a list; leaving it alone');
  return value.filter(e => e && typeof e.command === 'string');
}

/** The Windows chord that triggers a command now: the person's own binding, else Codex's default. */
export function chordFor(command, catalog, bindings) {
  const own = bindings.filter(e => e.command === command);
  if (own.length) return own.find(e => typeof e.key === 'string' && e.key)?.key?.replace(/CmdOrCtrl|CommandOrControl/g, 'Ctrl') ?? null;
  return catalog.commands.find(c => c.id === command)?.keys[0] ?? null;
}

/** Make `commands` triggerable. Adds a pool chord for each command without one; removes the
 * bridge's earlier entries for commands no longer needed. Returns what changed. */
export function sync(commands, catalog, stateDirectory, {file = keybindingsPath()} = {}) {
  const bindings = readBindings(file);
  const owned = readJson(ownedPath(stateDirectory), {file, entries: []});
  const mine = owned.entries.filter(o => bindings.some(b => same(b, o)));
  const wanted = new Set(commands);
  // Drop our entries that are no longer needed, or that a person has since re-bound.
  const keep = mine.filter(o => wanted.has(o.command) && bindings.filter(b => b.command === o.command).length === 1);
  let next = bindings.filter(b => !mine.some(o => same(b, o)) || keep.some(o => same(b, o)));
  const used = new Set([...next.map(b => b.key), ...catalog.commands.flatMap(c => c.keys)]);
  const added = [];
  for (const command of wanted) {
    if (chordFor(command, catalog, next)) continue;
    const key = POOL.find(k => !used.has(k));
    if (!key) break;
    used.add(key); const entry = {command, key, version: 1};
    next.push(entry); keep.push({command, key}); added.push(entry);
  }
  const removed = mine.filter(o => !keep.some(k => same(k, o)));
  if (added.length || removed.length) writeAtomic(file, next);
  writeAtomic(ownedPath(stateDirectory), {file, entries: keep});
  return {added, removed, file};
}

/** Remove every entry the bridge added (only those still exactly as it wrote them). */
export function removeAll(stateDirectory, {file} = {}) {
  const owned = readJson(ownedPath(stateDirectory), null);
  if (!owned) return {removed: []};
  const target = file ?? owned.file ?? keybindingsPath();
  const bindings = readBindings(target);
  const next = bindings.filter(b => !owned.entries.some(o => same(b, o)));
  if (next.length !== bindings.length) writeAtomic(target, next);
  fs.rmSync(ownedPath(stateDirectory), {force: true});
  return {removed: owned.entries};
}

export function ownedEntries(stateDirectory) { return readJson(ownedPath(stateDirectory), {entries: []}).entries; }
