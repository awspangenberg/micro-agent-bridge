import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StandaloneProfile, LOWER_CONTROLS } from '../src/standalone-profile.mjs';

function original({ missing = false, linkedApps = [] } = {}) {
  return Buffer.from(JSON.stringify({
    linkedApps, linkedMetadata: { application: 'keep me' },
    profiles: [
      { id: 0, name: 'Personal', layers: (missing ? [0] : [0, 1, 2]).map(id => ({
        id, name: `Personal ${id}`, color: 123 + id,
        layout: {
          keymap: [['KC_A', 'KC_B'], ['KC_C', 'KC_D', 'KC_E', 'KC_F'], ['KC_G', 'KC_H', 'KC_I', 'KC_J'], ['KC_K', 'KC_L', 'KC_M']],
          encoders: [['KC_LEFT', 'KC_RIGHT', 'KC_ENTER']],
          joystick: { type: 'RADIAL', sectors: [{ k: 'KC_UP', a1: 0, a2: 0.5 }] },
        },
      })) },
      { id: 9, layers: [{ id: 0, name: 'Other profile', layout: { keymap: [['KC_ESC']] } }] },
    ],
  }, null, 2) + '\n');
}

function fixture(t, initial = original()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-standalone-profile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = {
    directory, bytes: Buffer.from(initial), calls: [], readReply: null, beforeWrite: null,
    failOffset: null, failFinal: false, inPlace: false, committedWrites: 0, inFlight: 0, maximumInFlight: 0,
  };
  let writing = Buffer.alloc(0);
  f.rpc = async (method, params) => {
    f.inFlight++; f.maximumInFlight = Math.max(f.maximumInFlight, f.inFlight);
    try {
      await Promise.resolve();
      f.calls.push({ method, params });
      assert.equal(params.file, 'keymap.json');
      if (method === 'fs.readbin') {
        if (f.readReply) return f.readReply(params);
        return { total_size: f.bytes.length, data: f.bytes.subarray(params.offset, params.offset + params.len).toString('base64') };
      }
      assert.equal(method, 'fs.writebin');
      f.beforeWrite?.(params);
      const fragment = Buffer.from(params.data, 'base64');
      assert.ok(fragment.length > 0 && fragment.length <= 128);
      assert.equal(params.append, true);
      if (params.offset === 0) writing = Buffer.alloc(0);
      assert.equal(params.offset, writing.length);
      writing = Buffer.concat([writing, fragment]);
      // Exercise firmware which exposes partially written files after a disconnect.
      f.bytes = f.inPlace ? Buffer.concat([writing, f.bytes.subarray(writing.length)]) : Buffer.from(writing);
      if (f.failOffset === params.offset || (f.failFinal && params.completed)) {
        f.failOffset = null; f.failFinal = false; throw Error('simulated disconnect');
      }
      if (params.completed) { f.bytes = Buffer.from(writing); f.committedWrites++; }
      return { ok: 1 };
    } finally { f.inFlight--; }
  };
  f.host = (deviceKey = 'usb:device-123') => new StandaloneProfile({ rpc: f.rpc, stateDirectory: directory, deviceKey });
  f.writes = () => f.calls.filter(c => c.method === 'fs.writebin');
  f.readState = () => JSON.parse(fs.readFileSync(path.join(directory, 'standalone-profile-ownership.json')));
  f.edit = action => { const value = JSON.parse(f.bytes); action(value); f.bytes = Buffer.from(JSON.stringify(value)); };
  return f;
}

test('configure requires literal consent before any I/O', async t => {
  const f = fixture(t);
  for (const options of [undefined, {}, { consent: false }, { consent: 'true' }]) {
    await assert.rejects(f.host().configure(options), /consent/i);
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('configure backs up exact original bytes before serial verified task-row mapping', async t => {
  const baseline = original(), f = fixture(t, baseline), host = f.host();
  f.beforeWrite = () => {
    const state = f.readState();
    assert.equal(state.state, 'pending');
    assert.equal(state.deviceKey, 'usb:device-123');
    assert.deepEqual(fs.readFileSync(path.join(f.directory, state.backup.file)), baseline);
  };
  const result = await host.configure({ consent: true });
  assert.equal(result.configured, true);
  assert.equal(result.changed, true);
  const actual = JSON.parse(f.bytes), expected = JSON.parse(baseline);
  expected.profiles[0].layers[0].layout.keymap[0] = ['KV_OAI_AG00', 'KV_OAI_AG01'];
  expected.profiles[0].layers[0].layout.keymap[1] = ['KV_OAI_AG02', 'KV_OAI_AG03', 'KV_OAI_AG04', 'KV_OAI_AG05'];
  expected.profiles[0].layers[1].layout.keymap[0] = ['KV_OAI_AG06', 'KV_OAI_AG07'];
  expected.profiles[0].layers[1].layout.keymap[1] = ['KV_OAI_AG08', 'KV_OAI_AG09', 'KV_OAI_AG10', 'KV_OAI_AG11'];
  expected.profiles[0].layers[2].layout.keymap[0] = ['KV_OAI_AG12', 'KV_OAI_AG13'];
  expected.profiles[0].layers[2].layout.keymap[1] = ['KV_OAI_AG14', 'KV_OAI_AG15', 'KV_OAI_AG16', 'KV_OAI_AG17'];
  assert.deepEqual(actual, expected);
  const writes = f.writes();
  assert.ok(writes.length > 1);
  assert.deepEqual(writes.map(c => c.params.offset), writes.map((_, i) => i * 128));
  assert.deepEqual(writes.map(c => c.params.completed), writes.map((_, i) => i === writes.length - 1));
  assert.equal(f.maximumInFlight, 1);
  assert.equal(f.calls.at(-1).method, 'fs.readbin');
  assert.equal((await host.inspect()).state, 'configured');
  assert.deepEqual(fs.readFileSync(result.backupPath), baseline);
});

test('configure is idempotent and does not replace backups or unrelated later edits', async t => {
  const f = fixture(t), host = f.host();
  const first = await host.configure({ consent: true });
  f.edit(p => { p.profiles[0].layers[1].layout.keymap[2][0] = 'KC_F12'; p.linkedMetadata.later = true; });
  const before = Buffer.from(f.bytes), count = f.writes().length;
  const second = await f.host().configure({ consent: true });
  assert.equal(second.changed, false);
  assert.equal(second.backupPath, first.backupPath);
  assert.equal(f.writes().length, count);
  assert.deepEqual(f.bytes, before);
});

test('restore returns exact original bytes and preserves the original backup', async t => {
  const baseline = original(), f = fixture(t, baseline), host = f.host();
  const setup = await host.configure({ consent: true });
  const result = await host.restore();
  assert.equal(result.restored, true);
  assert.deepEqual(f.bytes, baseline);
  assert.deepEqual(fs.readFileSync(setup.backupPath), baseline);
  assert.equal((await host.inspect()).state, 'restored');
  const count = f.writes().length;
  assert.equal((await host.restore()).changed, false);
  assert.equal(f.writes().length, count);
});

test('restore preserves later edits outside the owned rows', async t => {
  const baseline = original(), f = fixture(t, baseline), host = f.host();
  await host.configure({ consent: true });
  const edit = p => {
    p.profiles[0].name = 'New profile name';
    p.profiles[0].layers[0].name = 'New layer name';
    p.profiles[0].layers[1].layout.keymap[2][1] = 'KC_F20';
    p.profiles[0].layers[2].layout.encoders[0][0] = 'KC_F21';
    p.profiles[0].layers[2].layout.joystick.sectors = [];
    p.profiles[1].layers[0].name = 'Other later edit';
    p.linkedMetadata.later = 'keep this too';
  };
  f.edit(edit);
  const result = await host.restore();
  const expected = JSON.parse(baseline); edit(expected);
  assert.deepEqual(JSON.parse(f.bytes), expected);
  assert.equal(result.preservedLaterEdits, true);
});

test('owned-row conflicts refuse restoration without partially restoring other layers', async t => {
  const f = fixture(t), host = f.host();
  await host.configure({ consent: true });
  f.edit(p => { p.profiles[0].layers[2].layout.keymap[0][0] = 'KC_USER'; });
  const before = Buffer.from(f.bytes), count = f.writes().length;
  await assert.rejects(host.restore(), /conflict|edited/i);
  await assert.rejects(host.configure({ consent: true }), /conflict|edited/i);
  assert.deepEqual(f.bytes, before);
  assert.equal(f.writes().length, count);
});

test('missing layers get the bridge lower controls and are removed on restore', async t => {
  const baseline = original({ missing: true }), f = fixture(t, baseline), host = f.host();
  await host.configure({ consent: true });
  const layers = JSON.parse(f.bytes).profiles[0].layers;
  assert.deepEqual(layers.map(l => [l.id, l.name]), [[0, 'Personal 0'], [1, 'Claude'], [2, 'Mixed']]);
  for (const layer of layers.slice(1)) {
    assert.deepEqual(layer.layout.keymap.slice(2), LOWER_CONTROLS.rows);
    assert.deepEqual(layer.layout.encoders, LOWER_CONTROLS.encoders);
    assert.deepEqual(layer.layout.joystick, LOWER_CONTROLS.joystick);
  }
  assert.deepEqual(await host.inspect().then(s => [s.mapping, s.upgradable, s.lowerControls]), [2, false, [1, 2]]);
  await host.restore();
  assert.deepEqual(f.bytes, baseline);
});

// A Claude layer whose lower controls send nothing, as the earlier setup left it.
function blankClaudeLayer() {
  const value = JSON.parse(original());
  Object.assign(value.profiles[0].layers[1].layout, {
    keymap: [['KC_A', 'KC_B'], ['KC_C', 'KC_D', 'KC_E', 'KC_F'], Array(4).fill('KC_NONE'), Array(3).fill('KC_NONE')],
    encoders: [['KC_NONE', 'KC_NONE', 'KC_NONE']], joystick: { type: 'RADIAL', sectors: [{ k: 'KI_X', a1: 0.1875, a2: 0.3125 }] },
  });
  return Buffer.from(JSON.stringify(value));
}

test('an unused Claude-layer lower region is mapped, verified and restored exactly', async t => {
  const baseline = blankClaudeLayer(), f = fixture(t, baseline), host = f.host();
  await host.configure({ consent: true });
  const [native, claude, mixed] = JSON.parse(f.bytes).profiles[0].layers;
  assert.deepEqual(claude.layout.keymap.slice(2), LOWER_CONTROLS.rows);
  assert.deepEqual(claude.layout.encoders, LOWER_CONTROLS.encoders);
  assert.deepEqual(claude.layout.joystick, LOWER_CONTROLS.joystick);
  // Codex's layer and a Mixed layer with its own lower controls are not touched.
  assert.deepEqual(native.layout.keymap.slice(2), [['KC_G', 'KC_H', 'KC_I', 'KC_J'], ['KC_K', 'KC_L', 'KC_M']]);
  assert.deepEqual(mixed.layout.encoders, [['KC_LEFT', 'KC_RIGHT', 'KC_ENTER']]);
  assert.deepEqual((await host.verify()).configured, true);
  f.edit(p => { p.profiles[0].layers[1].layout.encoders = [['KC_A', 'KC_B', 'KC_C']]; });
  await assert.rejects(host.verify(), /conflict|edited/i);
  f.edit(p => { p.profiles[0].layers[1].layout.encoders = structuredClone(LOWER_CONTROLS.encoders); });
  await host.restore();
  assert.deepEqual(f.bytes, baseline);
});

test('lower controls a person assigned are never taken over', async t => {
  const f = fixture(t), host = f.host();
  await host.configure({ consent: true });
  const claude = JSON.parse(f.bytes).profiles[0].layers[1];
  assert.deepEqual(claude.layout.keymap.slice(2), [['KC_G', 'KC_H', 'KC_I', 'KC_J'], ['KC_K', 'KC_L', 'KC_M']]);
  assert.deepEqual((await host.inspect()).lowerControls, []);
});

test('a mapping-1 record upgrades by restoring and configuring again, keeping its backup', async t => {
  const baseline = blankClaudeLayer(), f = fixture(t, baseline), host = f.host();
  await host.configure({ consent: true });
  // Rewrite the device and record as mapping 1 (task rows only), as rc.5 and earlier left them.
  await host.restore();
  const value = JSON.parse(baseline);
  for (const [i, layer] of value.profiles[0].layers.entries()) {
    layer.layout.keymap.splice(0, 2, ...[[0, 1], [2, 3, 4, 5]].map(row => row.map(n => `KV_OAI_AG${String(i * 6 + n).padStart(2, '0')}`)));
  }
  f.bytes = Buffer.from(JSON.stringify(value));
  const state = f.readState();
  const crypto = await import('node:crypto');
  Object.assign(state, { state: 'configured', mappedSha256: crypto.createHash('sha256').update(f.bytes).digest('hex') });
  delete state.mapping;
  fs.writeFileSync(path.join(f.directory, 'standalone-profile-ownership.json'), JSON.stringify(state));
  const backups = () => fs.readdirSync(f.directory).filter(n => n.startsWith('standalone-profile-backup-'));
  const before = backups();
  assert.deepEqual(await host.inspect().then(s => [s.mapping, s.upgradable]), [1, true]);
  await host.configure({ consent: true });
  assert.deepEqual(JSON.parse(f.bytes).profiles[0].layers[1].layout.encoders, LOWER_CONTROLS.encoders);
  assert.deepEqual(await host.inspect().then(s => [s.mapping, s.upgradable, s.configured]), [2, false, true]);
  assert.ok(before.every(name => backups().includes(name)));
  await host.restore();
  assert.deepEqual(f.bytes, baseline);
});

test('restore refuses to remove a created layer with later user edits', async t => {
  const f = fixture(t, original({ missing: true })), host = f.host();
  await host.configure({ consent: true });
  f.edit(p => { p.profiles[0].layers[1].name = 'Keep my layer'; });
  const count = f.writes().length, before = Buffer.from(f.bytes);
  await assert.rejects(host.restore(), /conflict|edited/i);
  assert.equal(f.writes().length, count);
  assert.deepEqual(f.bytes, before);
});

test('automatic application mappings refuse configuration', async t => {
  const f = fixture(t, original({ linkedApps: [{ profile: 0 }] }));
  await assert.rejects(f.host().configure({ consent: true }), /automatic|linkedApps/i);
  assert.equal(f.writes().length, 0);
});

test('ownership identity mismatch refuses configure and restore before device I/O', async t => {
  const f = fixture(t);
  await f.host().configure({ consent: true });
  const count = f.calls.length;
  await assert.rejects(f.host('usb:other-device').configure({ consent: true }), /identity|device/i);
  await assert.rejects(f.host('usb:other-device').restore(), /identity|device/i);
  await assert.rejects(f.host('usb:other-device').verify(), /identity|device/i);
  assert.equal(f.calls.length, count);
});

test('interrupted configure keeps a recoverable pending record and exact backup', async t => {
  const baseline = original(), f = fixture(t, baseline);
  f.failOffset = 128;
  await assert.rejects(f.host().configure({ consent: true }), /disconnect/i);
  assert.equal(f.readState().state, 'pending');
  assert.equal(f.bytes.length, 256);
  const result = await f.host().restore();
  assert.equal(result.restored, true);
  assert.deepEqual(f.bytes, baseline);
});

test('interrupted configure can resume only with explicit consent', async t => {
  const f = fixture(t);
  f.failOffset = 128;
  await assert.rejects(f.host().configure({ consent: true }), /disconnect/i);
  const count = f.writes().length;
  await assert.rejects(f.host().configure(), /consent/i);
  assert.equal(f.writes().length, count);
  await f.host().configure({ consent: true });
  assert.equal(f.readState().state, 'configured');
  assert.equal(JSON.parse(f.bytes).profiles[0].layers[2].layout.keymap[1][3], 'KV_OAI_AG17');
});

test('interrupted restore resumes its preserved-later-edits target', async t => {
  const baseline = original(), f = fixture(t, baseline);
  await f.host().configure({ consent: true });
  f.edit(p => { p.profiles[1].layers[0].name = 'Later external edit'; });
  f.failOffset = 128;
  await assert.rejects(f.host().restore(), /disconnect/i);
  await f.host().restore();
  const expected = JSON.parse(baseline); expected.profiles[1].layers[0].name = 'Later external edit';
  assert.deepEqual(JSON.parse(f.bytes), expected);
});

test('pending transactions refuse unknown device bytes', async t => {
  const f = fixture(t);
  f.failOffset = 128;
  await assert.rejects(f.host().configure({ consent: true }), /disconnect/i);
  f.bytes = Buffer.from('{"somebody":"else changed this"}');
  const count = f.writes().length;
  await assert.rejects(f.host().restore(), /conflict|changed|unknown/i);
  await assert.rejects(f.host().configure({ consent: true }), /conflict|changed|unknown/i);
  assert.equal(f.writes().length, count);
});

test('corrupt backup refuses writes instead of replacing the original', async t => {
  const f = fixture(t);
  const result = await f.host().configure({ consent: true });
  fs.writeFileSync(result.backupPath, 'damaged');
  const count = f.writes().length;
  await assert.rejects(f.host().restore(), /backup|integrity/i);
  assert.equal(f.writes().length, count);
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), 'damaged');
});

test('profile reads enforce size, fragment, base64, and stable-total bounds', async t => {
  const replies = [
    () => ({ total_size: 100001, data: 'e30=' }),
    () => ({ total_size: 0, data: '' }),
    () => ({ total_size: 8, data: '' }),
    () => ({ total_size: 2, data: Buffer.alloc(3).toString('base64') }),
    () => ({ total_size: 4000, data: Buffer.alloc(3073).toString('base64') }),
    () => ({ total_size: 2, data: '!!!!' }),
    ({ offset }) => ({ total_size: offset ? 4001 : 4000, data: Buffer.alloc(offset ? 928 : 3072).toString('base64') }),
  ];
  for (const reply of replies) {
    const f = fixture(t); f.readReply = reply;
    await assert.rejects(f.host().configure({ consent: true }), /profile|fragment|base64|size/i);
    assert.equal(f.writes().length, 0);
  }
});

test('readback mismatch does not claim configuration succeeded', async t => {
  const f = fixture(t);
  f.beforeWrite = params => {
    if (params.completed) f.readReply = () => ({ total_size: 2, data: Buffer.from('{}').toString('base64') });
  };
  await assert.rejects(f.host().configure({ consent: true }), /verification|readback/i);
  assert.equal(f.readState().state, 'pending');
});

test('a fresh configure after restore retains every previous backup', async t => {
  const f = fixture(t), host = f.host();
  const first = await host.configure({ consent: true });
  await host.restore();
  f.edit(p => { p.profiles[0].layers[0].layout.keymap[0][0] = 'KC_NEW'; });
  const nextOriginal = Buffer.from(f.bytes);
  const second = await host.configure({ consent: true });
  assert.notEqual(second.backupPath, first.backupPath);
  assert.deepEqual(fs.readFileSync(first.backupPath), original());
  assert.deepEqual(fs.readFileSync(second.backupPath), nextOriginal);
  await host.restore();
  assert.deepEqual(f.bytes, nextOriginal);
});

test('in-place final-chunk interruption can restore a longer original file', async t => {
  const baseline = original(), f = fixture(t, baseline);
  f.inPlace = true; f.failFinal = true;
  await assert.rejects(f.host().configure({ consent: true }), /disconnect/i);
  assert.equal(f.bytes.length, baseline.length);
  await f.host().restore();
  assert.deepEqual(f.bytes, baseline);
});

test('a profile changed after backup is never overwritten', async t => {
  const f = fixture(t);
  let reads = 0;
  f.readReply = ({ offset, len }) => {
    if (offset === 0 && ++reads === 2) f.edit(p => { p.profiles[0].name = 'Concurrent edit'; });
    return { total_size: f.bytes.length, data: f.bytes.subarray(offset, offset + len).toString('base64') };
  };
  await assert.rejects(f.host().configure({ consent: true }), /changed before write/i);
  assert.equal(f.writes().length, 0);
  assert.equal(JSON.parse(f.bytes).profiles[0].name, 'Concurrent edit');
  assert.equal(fs.existsSync(path.join(f.directory, 'standalone-profile-ownership.json')), false);
});

test('concurrent operations across instances sharing one directory remain serial', async t => {
  const baseline = original(), f = fixture(t, baseline);
  const [configured, restored] = await Promise.all([
    f.host().configure({ consent: true }), f.host().restore(),
  ]);
  assert.equal(configured.configured, true);
  assert.equal(restored.restored, true);
  assert.equal(f.maximumInFlight, 1);
  assert.deepEqual(f.bytes, baseline);
});

test('malformed task rows and duplicate layer IDs refuse writes', async t => {
  for (const edit of [
    p => { p.profiles[0].layers[0].layout.keymap[0].push('KC_EXTRA'); },
    p => { p.profiles[0].layers[1].layout = null; },
    p => { p.profiles[0].layers[1].id = 0; },
  ]) {
    const f = fixture(t); f.edit(edit);
    await assert.rejects(f.host().configure({ consent: true }), /profile|keys|layers/i);
    assert.equal(f.writes().length, 0);
  }
});

test('verify confirms configured rows without writing the device or ownership record', async t => {
  const f = fixture(t), host = f.host();
  await host.configure({ consent: true });
  const stateBefore = fs.readFileSync(path.join(f.directory, 'standalone-profile-ownership.json'));
  const filesBefore = fs.readdirSync(f.directory), writesBefore = f.writes().length;
  f.edit(p => { p.profiles[0].layers[1].layout.keymap[2][0] = 'KC_LATER'; });
  const profileBefore = Buffer.from(f.bytes), callsBefore = f.calls.length;
  assert.equal((await host.verify()).configured, true);
  assert.ok(f.calls.length > callsBefore, 'verification must read the current hardware profile');
  assert.equal(f.writes().length, writesBefore);
  assert.deepEqual(f.bytes, profileBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'standalone-profile-ownership.json')), stateBefore);
  assert.deepEqual(fs.readdirSync(f.directory), filesBefore);
});

test('verify rejects changed owned rows, created layers, and application mapping without writes', async t => {
  for (const scenario of [
    { missing: false, edit: p => { p.profiles[0].layers[0].layout.keymap[0][0] = 'KC_LATER'; } },
    { missing: true, edit: p => { p.profiles[0].layers[1].name = 'Later layer rename'; } },
    { missing: false, edit: p => { p.linkedApps.push({ profile: 0 }); } },
  ]) {
    const f = fixture(t, original({ missing: scenario.missing })), host = f.host();
    await host.configure({ consent: true });
    f.edit(scenario.edit);
    const writesBefore = f.writes().length, before = Buffer.from(f.bytes);
    await assert.rejects(host.verify(), /conflict|edited|automatic|linkedApps/i);
    assert.equal(f.writes().length, writesBefore);
    assert.deepEqual(f.bytes, before);
  }
});

test('verify reports unconfigured and restored states without device I/O', async t => {
  const f = fixture(t), host = f.host();
  assert.equal((await host.verify()).configured, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  await host.configure({ consent: true });
  await host.restore();
  const callsBefore = f.calls.length;
  assert.equal((await host.verify()).configured, false);
  assert.equal(f.calls.length, callsBefore);
});

test('verify refuses pending recovery without device I/O or writes', async t => {
  const f = fixture(t);
  f.failOffset = 128;
  await assert.rejects(f.host().configure({ consent: true }), /disconnect/i);
  const callsBefore = f.calls.length, stateBefore = f.readState();
  await assert.rejects(f.host().verify(), /pending/i);
  assert.equal(f.calls.length, callsBefore);
  assert.deepEqual(f.readState(), stateBefore);
});
