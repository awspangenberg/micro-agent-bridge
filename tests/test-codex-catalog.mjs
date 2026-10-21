import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseCommands, parseKeycaps, windowsKey, FALLBACK, loadCatalog} from '../src/codex-catalog.mjs';
import {sync, removeAll, chordFor, readBindings, ownedEntries, POOL} from '../src/codex-keybindings.mjs';
import {normalizeSettings, validAction, migrate} from '../src/standalone-controls.mjs';

test('Codex commands keep only their own Windows shortcuts and English titles', () => {
  const registry = 'x={id:`navigateForward`,titleIntlId:`codex.command.navigateForward`,electron:{defaultKeybindings:[{key:`CmdOrCtrl+]`},{key:`Command+Shift+]`}]}},' +
    '{id:`toggleSidebar`,titleIntlId:`codex.command.toggleSidebar`,electron:{defaultKeybindings:[{key:`CmdOrCtrl+B`}],other:{a:`}`}}},' +
    '{id:`composer.togglePlanMode`,titleIntlId:`codex.command.composer.togglePlanMode`,web:{default:[{key:`Shift+Tab`}]}},' +
    '{id:`newTask`,titleIntlId:`codex.command.newTask`,electron:{defaultKeybindings:[{key:`CmdOrCtrl+Shift+E`}]}}';
  const messages = '{defaultMessage:`Toggle sidebar`,id:`codex.command.toggleSidebar`}';
  const commands = Object.fromEntries(parseCommands(registry, messages).map(c => [c.id, c]));
  assert.deepEqual(commands.navigateForward.keys, ['Ctrl+]'], 'macOS-only chords are dropped; a ] inside a key is kept');
  assert.deepEqual(commands.toggleSidebar, {id: 'toggleSidebar', title: 'Toggle sidebar', keys: ['Ctrl+B']}, "a neighbour's keys are never attributed");
  assert.deepEqual(commands['composer.togglePlanMode'], {id: 'composer.togglePlanMode', title: 'Toggle plan mode', keys: ['Shift+Tab']});
  assert.equal(windowsKey('Option+Super+K'), null);
  assert.equal(windowsKey('CmdOrCtrl+Option+K'), 'Ctrl+Alt+K');
  const keycaps = parseKeycaps('[{id:`FAST`,icon:`bolt`,size:`single`,action:{type:`command`,command:`composer.toggleFastMode`}},' +
    '{id:`YOLO`,icon:`y`,size:`single`,action:{type:`composer-text`,label:`YOLO`,text:`:yolo:`}},{id:`MIC`,icon:`m`,size:`double`,action:{type:`push-to-talk`}}]');
  assert.deepEqual(keycaps.map(k => [k.id, k.type, k.command ?? k.text]), [['FAST', 'command', 'composer.toggleFastMode'], ['YOLO', 'composer-text', ':yolo:'], ['MIC', 'push-to-talk', null]]);
});

test('the catalog falls back without Codex and is cached per Codex version', async () => {
  assert.equal(await loadCatalog(null, {install: async () => null}), FALLBACK);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mab-catalog-'));
  const cached = {version: '1.2.3', commands: [{id: 'x', title: 'X', keys: []}], keycaps: []};
  fs.writeFileSync(path.join(dir, 'codex-catalog.json'), JSON.stringify(cached));
  assert.deepEqual(await loadCatalog(dir, {install: async () => ({version: '1.2.3', asar: path.join(dir, 'missing.asar')})}), cached);
  assert.equal(await loadCatalog(dir, {install: async () => ({version: '9.9.9', asar: path.join(dir, 'missing.asar')})}), FALLBACK, 'unreadable bundle');
});

test('Codex shortcut registration adds only what is missing and removes only its own entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mab-keys-')), file = path.join(dir, 'keybindings.json');
  const mine = {command: 'forkThread', key: 'Ctrl+Alt+F', version: 1};
  fs.writeFileSync(file, JSON.stringify([mine]));
  const first = sync(['composer.togglePlanMode', 'navigateBack', 'forkThread'], FALLBACK, dir, {file});
  assert.deepEqual(first.added, [{command: 'composer.togglePlanMode', key: POOL[0], version: 1}], 'Back has a default and Fork the person\'s own');
  assert.equal(chordFor('composer.togglePlanMode', FALLBACK, readBindings(file)), POOL[0]);
  assert.equal(chordFor('forkThread', FALLBACK, readBindings(file)), 'Ctrl+Alt+F');
  // A second sync with the same commands changes nothing; dropping one removes the bridge's entry.
  assert.deepEqual(sync(['composer.togglePlanMode', 'forkThread'], FALLBACK, dir, {file}).added, []);
  const second = sync(['composer.toggleFastMode'], FALLBACK, dir, {file});
  assert.deepEqual([second.added.map(e => e.key), second.removed.map(e => e.command)], [[POOL[0]], ['composer.togglePlanMode']]);
  assert.deepEqual(ownedEntries(dir), [{command: 'composer.toggleFastMode', key: POOL[0]}]);
  removeAll(dir, {file});
  assert.deepEqual(readBindings(file), [mine], "the person's entry survives");
  fs.writeFileSync(file, '{"not": "a list"}');
  assert.throws(() => sync(['forkThread'], FALLBACK, dir, {file}), /not a list/);
});

test('settings migrate old action names and reject invalid values', () => {
  const s = normalizeSettings({codexShortcuts: true, target: 'nowhere', layers: {
    codex: {agentKeys: 'recent', knobMode: 'reasoning', overrides: {check: 'approve', mic: 'dictate', bolt: 'rm -rf', app: 'url:http://x', branch: 'text:hi'}},
    claude: {agentKeys: 'everything', knobMode: 'spin'}}});
  assert.equal(s.codexShortcuts, true);
  assert.equal(s.target, normalizeSettings(null).target);
  assert.deepEqual([s.layers.codex.agentKeys, s.layers.codex.knobMode, s.layers.claude.agentKeys, s.layers.claude.knobMode], ['recent', 'reasoning', 'pinned', null]);
  assert.deepEqual(s.layers.codex.overrides, {check: 'cmd:approval.approve', mic: 'ptt', branch: 'text:hi'});
  assert.equal(migrate('sidebar'), 'cmd:toggleSidebar');
  assert.ok(validAction('url:https://example.com/a') && !validAction('cmd:bad id') && !validAction('text:a\nb'));
});
