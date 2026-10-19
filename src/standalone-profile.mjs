import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const MAX_PROFILE_BYTES = 100000;
const READ_BYTES = 3072;
const WRITE_BYTES = 128;
const ownershipQueues = new Map();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function decodeBase64(value, limit, label) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw Error(`Invalid ${label} base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== value) throw Error(`Invalid ${label} size or base64`);
  return bytes;
}

function readBounded(file, limit) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limit) throw Error('Profile state file exceeds its size bound');
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > limit) throw Error('Profile state file exceeds its size bound');
    return bytes;
  } finally { fs.closeSync(descriptor); }
}

function writeDurable(file, bytes) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function parseProfile(bytes, rejectLinkedApps = false) {
  let source;
  try { source = JSON.parse(bytes.toString('utf8')); }
  catch { throw Error('Invalid profile JSON'); }
  if (!source || !Array.isArray(source.profiles) ||
      source.profiles.some(p => !p || !Number.isInteger(p.id)) ||
      new Set(source.profiles.map(p => p.id)).size !== source.profiles.length) {
    throw Error('Invalid profile list');
  }
  if (rejectLinkedApps && source.linkedApps !== undefined &&
      (!Array.isArray(source.linkedApps) || source.linkedApps.length !== 0)) {
    throw Error('Automatic application mapping (linkedApps) prevents profile configuration');
  }
  const profile = source.profiles.find(p => p.id === 0);
  if (!profile || !Array.isArray(profile.layers) ||
      profile.layers.some(layer => !layer || !Number.isInteger(layer.id)) ||
      new Set(profile.layers.map(layer => layer.id)).size !== profile.layers.length) {
    throw Error('Invalid profile 0 layers');
  }
  return { source, profile };
}

function validateLayout(layer) {
  const keys = layer?.layout?.keymap;
  if (!Array.isArray(keys) || keys.length < 2 || keys[0]?.length !== 2 || keys[1]?.length !== 4 ||
      keys.some(row => !Array.isArray(row) || row.some(key => typeof key !== 'string'))) {
    throw Error('Profile task rows must contain two and four keys');
  }
}

// Lower controls on the Claude and Mixed layers: action keys, microphone, last key, knob and
// joystick send the same KV_OAI codes on both layers; the host tells them apart by the current
// layer. Codex's own layer keeps its native codes. See docs/micro-controls.md.
export const LOWER_CONTROLS = Object.freeze({
  rows: [['KV_OAI_ACT13', 'KV_OAI_ACT14', 'KV_OAI_ACT15', 'KV_OAI_ACT16'], ['KV_OAI_ACT17', 'KV_OAI_ACT18', 'KV_OAI_ACT19']],
  encoders: [['KV_OAI_ACT00', 'KV_OAI_ACT01', 'KV_OAI_ACT02']],
  joystick: { type: 'RADIAL', sectors: [
    { k: 'KV_OAI_ACT04', a1: 0.875, a2: 0.125 }, { k: 'KV_OAI_ACT05', a1: 0.125, a2: 0.375 },
    { k: 'KV_OAI_ACT20', a1: 0.375, a2: 0.625 }, { k: 'KV_OAI_ACT03', a1: 0.625, a2: 0.875 },
  ] },
});
export const MAPPING_VERSION = 2;
const lowerOf = layer => ({ rows: layer.layout.keymap.slice(2, 4), encoders: layer.layout.encoders, joystick: layer.layout.joystick });
const blank = key => key === 'KC_NONE' || key === undefined;
// Only an unused lower region is taken over; a person's own lower mappings are left alone.
const lowerIsBlank = layer => {
  const rows = layer.layout.keymap.slice(2, 4), encoders = layer.layout.encoders;
  return rows.length === 2 && rows[0]?.length === 4 && rows[1]?.length === 3 && rows.flat().every(blank) &&
    (encoders === undefined || (Array.isArray(encoders) && encoders.flat().every(blank)));
};
function applyLower(layer) {
  const lower = structuredClone(LOWER_CONTROLS);
  layer.layout.keymap.splice(2, 2, ...lower.rows);
  layer.layout.encoders = lower.encoders;
  layer.layout.joystick = lower.joystick;
}

function mappingPlan(original, version = MAPPING_VERSION) {
  if (version !== 1 && version !== 2) throw Error('Unsupported profile mapping version');
  const { source, profile } = parseProfile(original, true);
  const native = profile.layers.find(layer => layer.id === 0);
  validateLayout(native);
  // Copy the native template before assigning bank 0, so new layers start blank.
  const template = structuredClone(native);
  const layers = [];
  for (const id of [0, 1, 2]) {
    let layer = profile.layers.find(value => value.id === id);
    const created = !layer;
    if (created) {
      layer = structuredClone(template);
      layer.id = id;
      layer.name = id === 1 ? 'Claude' : 'Mixed';
      layer.layout.keymap = layer.layout.keymap.map(row => row.map(() => 'KC_NONE'));
      layer.layout.encoders = [['KC_NONE', 'KC_NONE', 'KC_NONE']];
      layer.layout.joystick = { type: 'RADIAL', sectors: [] };
      profile.layers.push(layer);
    }
    validateLayout(layer);
    const originalRows = created ? null : structuredClone(layer.layout.keymap.slice(0, 2));
    const key = number => `KV_OAI_AG${String(number).padStart(2, '0')}`;
    const start = id * 6;
    const mappedRows = [[key(start), key(start + 1)], [key(start + 2), key(start + 3), key(start + 4), key(start + 5)]];
    layer.layout.keymap.splice(0, 2, ...mappedRows);
    // Version 2 also maps the lower controls of a created layer, and of the Claude layer when unused.
    let originalLower = null, mappedLower = null;
    if (version >= 2 && id > 0 && (created || (id === 1 && lowerIsBlank(layer)))) {
      if (!created) originalLower = structuredClone(lowerOf(layer));
      applyLower(layer);
      if (!created) mappedLower = structuredClone(lowerOf(layer));
    }
    layers.push({ id, created, originalRows, mappedRows, originalLower, mappedLower, mappedLayer: created ? structuredClone(layer) : null });
  }
  const mapped = isDeepStrictEqual(source, JSON.parse(original.toString('utf8'))) ? original : Buffer.from(JSON.stringify(source));
  if (mapped.length > MAX_PROFILE_BYTES) throw Error('Mapped profile exceeds its size bound');
  return { mapped, layers };
}

function checkOwnedRows(profile, layers) {
  for (const owned of layers) {
    const layer = profile.layers.find(value => value.id === owned.id);
    const matches = owned.created ? isDeepStrictEqual(layer, owned.mappedLayer) :
      isDeepStrictEqual(layer?.layout?.keymap?.slice(0, 2), owned.mappedRows) &&
      (!owned.mappedLower || (layer && isDeepStrictEqual(JSON.parse(JSON.stringify(lowerOf(layer))), owned.mappedLower)));
    if (!matches) throw Error(`Profile layer ${owned.id} was edited; owned region conflict`);
  }
}

function restoreTarget(current, original, plan) {
  if (current.equals(plan.mapped) || current.equals(original)) return original;
  const { source, profile } = parseProfile(current);
  // Validate every owned region before making any change, including removals.
  checkOwnedRows(profile, plan.layers);
  for (const owned of plan.layers) {
    const index = profile.layers.findIndex(layer => layer.id === owned.id);
    if (owned.created) profile.layers.splice(index, 1);
    else {
      const layout = profile.layers[index].layout;
      layout.keymap.splice(0, 2, ...structuredClone(owned.originalRows));
      if (owned.originalLower) {
        const lower = structuredClone(owned.originalLower);
        layout.keymap.splice(2, 2, ...lower.rows);
        for (const name of ['encoders', 'joystick']) {
          if (lower[name] === undefined) delete layout[name]; else layout[name] = lower[name];
        }
      }
    }
  }
  const target = Buffer.from(JSON.stringify(source));
  if (target.length > MAX_PROFILE_BYTES) throw Error('Restored profile exceeds its size bound');
  return target;
}

function recognizedInterruptedBytes(current, transaction) {
  const { fromBytes: from, toBytes: to, attempted } = transaction;
  if (current.equals(from) || current.equals(to)) return true;
  if (attempted === 0) return false;
  // Some firmware truncates at the first chunk; others overwrite in place.
  if (current.length <= attempted && (current.length % WRITE_BYTES === 0 || current.length === to.length) &&
      current.equals(to.subarray(0, current.length))) return true;
  for (let offset = 0; offset < attempted; offset += WRITE_BYTES) {
    const end = Math.min(offset + WRITE_BYTES, to.length);
    if (current.length === Math.max(from.length, end) && current.subarray(0, end).equals(to.subarray(0, end)) &&
        current.subarray(end).equals(from.subarray(end))) return true;
  }
  return false;
}

/** Owns the first two task-key rows of existing profile-0 layers and, from mapping 2, the unused
 * lower controls of the Claude layer.
 * The caller owns the device connection and must prevent competing host processes.
 * All public operations for a state directory are serialized in this process.
 */
export class StandaloneProfile {
  constructor({ rpc, stateDirectory, deviceKey } = {}) {
    if (typeof rpc !== 'function') throw TypeError('Profile RPC function is required');
    if (typeof stateDirectory !== 'string' || !stateDirectory.trim()) throw TypeError('Profile state directory is required');
    if (typeof deviceKey !== 'string' || !deviceKey.trim() || deviceKey.length > 1024) throw TypeError('Stable device identity is required');
    this.rpc = rpc;
    this.stateDirectory = path.resolve(stateDirectory);
    this.deviceKey = deviceKey;
    this.ownershipPath = path.join(this.stateDirectory, 'standalone-profile-ownership.json');
  }

  #serial(action) {
    const previous = ownershipQueues.get(this.ownershipPath) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    ownershipQueues.set(this.ownershipPath, result);
    const clear = () => { if (ownershipQueues.get(this.ownershipPath) === result) ownershipQueues.delete(this.ownershipPath); };
    result.then(clear, clear);
    return result;
  }

  #save(record, initial = false) {
    const data = Buffer.from(JSON.stringify(record));
    if (initial) { writeDurable(this.ownershipPath, data); return; }
    const temporary = `${this.ownershipPath}.${randomUUID()}.tmp`;
    try { writeDurable(temporary, data); fs.renameSync(temporary, this.ownershipPath); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }

  #load() {
    let raw;
    try { raw = readBounded(this.ownershipPath, 1024 * 1024); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let record;
    try { record = JSON.parse(raw.toString('utf8')); }
    catch { throw Error('Invalid profile ownership record'); }
    if (!record || record.version !== 1 || !['pending', 'configured', 'restored'].includes(record.state)) {
      throw Error('Invalid profile ownership record');
    }
    if (record.deviceKey !== this.deviceKey) throw Error('Profile ownership device identity mismatch');
    if (!record.backup || !/^standalone-profile-backup-[a-f0-9-]+\.bin$/.test(record.backup.file)) {
      throw Error('Invalid profile backup reference');
    }
    const backupPath = path.join(this.stateDirectory, record.backup.file);
    const original = readBounded(backupPath, MAX_PROFILE_BYTES);
    if (!original.length || sha256(original) !== record.backup.sha256) throw Error('Profile backup integrity mismatch');
    // Records written before lower-control mapping existed carry no version and use mapping 1.
    const plan = mappingPlan(original, record.mapping ?? 1);
    if (sha256(plan.mapped) !== record.mappedSha256) throw Error('Profile mapping integrity mismatch');
    let transaction;
    if (record.state === 'pending') {
      const value = record.transaction;
      if (!value || !['configure', 'restore'].includes(value.operation)) throw Error('Invalid pending profile transaction');
      const fromBytes = decodeBase64(value.from, MAX_PROFILE_BYTES, 'transaction source');
      const toBytes = decodeBase64(value.to, MAX_PROFILE_BYTES, 'transaction target');
      if (!toBytes.length || sha256(fromBytes) !== value.fromSha256 || sha256(toBytes) !== value.toSha256 ||
          !Number.isInteger(value.attempted) || value.attempted < 0 || value.attempted > toBytes.length ||
          (value.attempted !== toBytes.length && value.attempted % WRITE_BYTES !== 0)) {
        throw Error('Invalid pending profile transaction integrity');
      }
      if (value.operation === 'configure' && (!fromBytes.equals(original) || !toBytes.equals(plan.mapped))) {
        throw Error('Invalid pending profile configuration');
      }
      transaction = { ...value, fromBytes, toBytes };
    } else if (record.transaction !== undefined) throw Error('Unexpected profile transaction');
    return { record, original, plan, backupPath, transaction };
  }

  async #readProfile(allowEmpty = false) {
    let offset = 0, total;
    const fragments = [];
    do {
      const response = await this.rpc('fs.readbin', { file: 'keymap.json', offset, len: READ_BYTES });
      if (!response || !Number.isInteger(response.total_size) || response.total_size < (allowEmpty ? 0 : 1) ||
          response.total_size > MAX_PROFILE_BYTES) throw Error('Invalid profile total size');
      if (total !== undefined && total !== response.total_size) throw Error('Profile size changed during read');
      total = response.total_size;
      const fragment = decodeBase64(response.data, READ_BYTES, 'profile fragment');
      if (fragment.length > total - offset || (!fragment.length && total !== 0)) throw Error('Invalid profile fragment length');
      fragments.push(fragment);
      offset += fragment.length;
    } while (offset < total);
    return Buffer.concat(fragments, total);
  }

  async #unchanged(bytes, allowEmpty = false) {
    if (!(await this.#readProfile(allowEmpty)).equals(bytes)) throw Error('Profile changed before write; refusing overwrite');
  }

  #begin(record, operation, from, to) {
    record.state = 'pending';
    record.transaction = {
      operation, from: from.toString('base64'), fromSha256: sha256(from),
      to: to.toString('base64'), toSha256: sha256(to), attempted: 0,
    };
  }

  #finish(record, state) {
    record.state = state;
    delete record.transaction;
    this.#save(record);
  }

  async #writeProfile(record, target) {
    for (let offset = 0; offset < target.length; offset += WRITE_BYTES) {
      const fragment = target.subarray(offset, offset + WRITE_BYTES);
      // Persist the possible write before sending it; a disconnect can lose its reply.
      record.transaction.attempted = Math.max(record.transaction.attempted, offset + fragment.length);
      this.#save(record);
      await this.rpc('fs.writebin', {
        file: 'keymap.json', data: fragment.toString('base64'), append: true,
        offset, completed: offset + fragment.length === target.length,
      });
    }
    if (!(await this.#readProfile()).equals(target)) throw Error('Profile readback verification mismatch');
  }

  async configure({ consent = false } = {}) {
    if (consent !== true) throw Error('Explicit profile configuration consent is required');
    return this.#serial(async () => {
      let owned = this.#load();
      // An older mapping is upgraded by restoring it, then configuring afresh; later edits outside
      // the owned rows are preserved by restore, and every earlier backup is kept.
      if (owned?.record.state === 'configured' && (owned.record.mapping ?? 1) < MAPPING_VERSION) {
        await this.#restore(owned);
        owned = this.#load();
      }
      if (owned && owned.record.state !== 'restored') {
        const { record, plan, transaction, backupPath } = owned;
        if (transaction?.operation === 'restore') throw Error('Pending profile restore must be completed before configuration');
        const current = await this.#readProfile(Boolean(transaction?.attempted));
        if (!transaction) {
          checkOwnedRows(parseProfile(current, true).profile, plan.layers);
          return { configured: true, changed: false, backupPath, sha256: sha256(current) };
        }
        if (!recognizedInterruptedBytes(current, transaction)) throw Error('Pending profile bytes changed; recovery conflict');
        const changed = !current.equals(transaction.toBytes);
        if (changed) {
          await this.#unchanged(current, Boolean(transaction.attempted));
          await this.#writeProfile(record, transaction.toBytes);
        }
        this.#finish(record, 'configured');
        return { configured: true, changed, backupPath, sha256: sha256(transaction.toBytes) };
      }
      const original = await this.#readProfile();
      const plan = mappingPlan(original);
      fs.mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
      const backupFile = `standalone-profile-backup-${randomUUID()}.bin`;
      const backupPath = path.join(this.stateDirectory, backupFile);
      writeDurable(backupPath, original);
      await this.#unchanged(original);
      const record = {
        version: 1, mapping: MAPPING_VERSION, deviceKey: this.deviceKey, state: 'configured',
        backup: { file: backupFile, sha256: sha256(original) }, mappedSha256: sha256(plan.mapped),
      };
      const changed = !original.equals(plan.mapped);
      if (changed) this.#begin(record, 'configure', original, plan.mapped);
      this.#save(record, !owned);
      if (changed) {
        await this.#writeProfile(record, plan.mapped);
        this.#finish(record, 'configured');
      }
      return { configured: true, changed, backupPath, sha256: sha256(plan.mapped) };
    });
  }

  restore() {
    return this.#serial(async () => {
      const owned = this.#load();
      if (!owned || owned.record.state === 'restored') return { restored: true, changed: false, backupPath: owned?.backupPath };
      return this.#restore(owned);
    });
  }

  // Callers hold the serial queue.
  async #restore(owned) {
    {
      const { record, original, plan, backupPath, transaction } = owned;
      const current = await this.#readProfile(Boolean(transaction?.attempted));
      let target;
      if (transaction) {
        if (!recognizedInterruptedBytes(current, transaction)) throw Error('Pending profile bytes changed; recovery conflict');
        target = transaction.operation === 'restore' ? transaction.toBytes : original;
      } else target = restoreTarget(current, original, plan);
      const changed = !current.equals(target);
      if (changed) {
        await this.#unchanged(current, Boolean(transaction?.attempted));
        if (transaction?.operation !== 'restore') {
          this.#begin(record, 'restore', current, target);
          this.#save(record);
        }
        await this.#writeProfile(record, target);
      }
      this.#finish(record, 'restored');
      return { restored: true, changed, backupPath, sha256: sha256(target), preservedLaterEdits: !target.equals(original) };
    }
  }

  verify() {
    return this.#serial(async () => {
      const owned = this.#load();
      if (!owned || owned.record.state === 'restored') return { configured: false };
      if (owned.record.state === 'pending') throw Error('Pending profile transaction requires recovery before verification');
      const current = await this.#readProfile();
      checkOwnedRows(parseProfile(current, true).profile, owned.plan.layers);
      return { configured: true, backupPath: owned.backupPath, sha256: sha256(current) };
    });
  }

  inspect() {
    return this.#serial(() => {
      const owned = this.#load();
      return {
        deviceKey: this.deviceKey, state: owned?.record.state ?? 'unconfigured',
        configured: owned?.record.state === 'configured', pending: owned?.record.state === 'pending',
        backupPath: owned?.backupPath, banks: [0, 6, 12],
        // Setup offers to upgrade a configured profile whose lower controls are not mapped yet.
        mapping: owned ? owned.record.mapping ?? 1 : null, upgradable: owned?.record.state === 'configured' && (owned.record.mapping ?? 1) < MAPPING_VERSION,
        lowerControls: owned ? owned.plan.layers.filter(l => l.mappedLower || (l.created && l.id > 0 && (owned.record.mapping ?? 1) >= 2)).map(l => l.id) : [],
      };
    });
  }
}
