import {CodexStatus} from './codex-ipc.mjs';

// Commands are classified in memory only; the text is never stored or emitted.
const TEST = /(^|[\s;&|/\\"'(])(pytest|jest|vitest|mocha|ava|tap|phpunit|rspec|ctest|unittest|nox|tox|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|mvn\s+(?:\S+\s+)*test|gradlew?\s+(?:\S+\s+)*test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S*)?|node\s+--test|deno\s+test|swift\s+test|make\s+(?:check|test))(?=$|[\s;&|"')])/i;
export const isTestCommand = command => typeof command === 'string' && command.length <= 16384 && TEST.test(command);

const commandText = item => {
  const c = item?.command ?? item?.cmd ?? item?.parsedCmd;
  return Array.isArray(c) ? c.filter(x => typeof x === 'string').join(' ') : c;
};
export function itemActivity(item) {
  const type = item?.type;
  if (type === 'commandExecution' || type === 'localShellCall' || type === 'exec') return isTestCommand(commandText(item)) ? 'testing' : 'command';
  if (type === 'fileChange' || type === 'patch' || type === 'applyPatch') return 'editing';
  if (type === 'reasoning' || type === 'plan' || type === 'todoList' || type === 'planUpdate') return 'planning';
  return null;
}
const RUNNING = new Set(['inProgress', 'in_progress', 'running', 'pending', 'started']);
const summarize = item => ({activity: itemActivity(item), running: RUNNING.has(item?.status) || item?.status === undefined && item?.completed === false});
const clearTurnItems = (items, turnId) => {
  for (const coordinate of items.keys()) if (coordinate.startsWith(turnId + '/')) items.delete(coordinate);
};
const replaceTurnItems = (items, turnId, collection) => {
  clearTurnItems(items, turnId);
  if (collection && typeof collection === 'object')
    for (const [coordinate, item] of Object.entries(collection)) items.set(`${turnId}/${coordinate}`, summarize(item));
};

// Codex detail adds what the active turn is doing to the shared live status. The
// mirror holds only type/status summaries at the stream's turn/item coordinates.
export class CodexActivity extends CodexStatus {
  constructor(options) { super(options); this.activity = new Map(); this.plan = new Map(); this.refreshAt = new Map(); }
  message(x) {
    const accepted = super.message(x);
    if (accepted) {
      try { this.track(x); } catch { /* Detail is advisory; accepted live status is authoritative. */ }
    }
    return accepted;
  }
  track(x) {
    if (x?.type !== 'broadcast' || x.method !== 'thread-stream-state-changed') return;
    const p = x.params ?? {}, t = this.tasks.find(t => t.hostId === p.hostId && t.nativeId === p.conversationId);
    if (!t) return;
    const key = `${t.host}:${t.nativeId}`, c = p.change ?? {};
    if (c.type === 'snapshot') {
      const v = c.conversationState ?? {};
      this.plan.set(key, v.latestCollaborationMode?.mode === 'plan');
      const turns = v.turnHistory?.history?.entitiesByKey ?? {};
      const items = new Map();
      for (const [turnId, turn] of Object.entries(turns)) {
        if (turn?.status !== 'inProgress') continue;
        replaceTurnItems(items, turnId, turn.items);
      }
      this.activity.set(key, items);
      return;
    }
    if (c.type !== 'patches') return;
    const items = this.activity.get(key) ?? new Map();
    for (const patch of c.patches ?? []) {
      const path = patch.path ?? [];
      if (path[0] === 'latestCollaborationMode' && (path.length === 1 || path[1] === 'mode'))
        this.plan.set(key, (path.length === 1 ? patch.value?.mode : patch.value) === 'plan');
      if (path[0] !== 'turnHistory' || path[1] !== 'history' || path[2] !== 'entitiesByKey') continue;
      const turnId = path[3];
      if (path.length === 4) {
        replaceTurnItems(items, turnId, patch.op !== 'remove' && patch.value?.status === 'inProgress' ? patch.value.items : null);
        continue;
      }
      if (path.length === 5 && path[4] === 'status' && patch.value !== 'inProgress')
        clearTurnItems(items, turnId);
      if (path[4] !== 'items') continue;
      if (path.length === 5) {
        replaceTurnItems(items, turnId, patch.op === 'remove' ? null : patch.value);
      } else if (path.length === 6) {
        const id = `${turnId}/${path[5]}`;
        if (patch.op === 'remove') items.delete(id); else items.set(id, summarize(patch.value));
      } else if (path.length === 7 && path[6] === 'status') {
        const id = `${turnId}/${path[5]}`, old = items.get(id);
        if (old) items.set(id, {...old, running: RUNNING.has(patch.value)});
        else this.resync(t, key);
      } else if (path.length >= 7 && ['command', 'cmd', 'parsedCmd', 'type'].includes(path[6])) {
        // Partial updates of fields that change the category: take a fresh snapshot.
        this.resync(t, key);
      }
    }
    this.activity.set(key, items);
  }
  resync(t, key) {
    if (Date.now() - (this.refreshAt.get(key) ?? 0) < 3000) return;
    this.refreshAt.set(key, Date.now()); this.follow(t, false); this.follow(t, true);
  }
  // Refines the shared state; never invents activity for an inactive or unknown task.
  detail(t) {
    const base = this.state(t), key = `${t.host}:${t.nativeId}`, live = this.live.get(key);
    if (base === 'awaiting_input') {
      const flags = live?.runtime?.activeFlags ?? [];
      if (flags.some(f => /waitingOnApproval/.test(f))) return 'approval';
      return flags.some(f => /waitingOnUserInput/.test(f)) ? 'question' : 'approval';
    }
    if (base !== 'working') return base;
    const running = [...(this.activity.get(key)?.values() ?? [])].filter(i => i.running && i.activity);
    for (const activity of ['testing', 'command', 'editing', 'planning']) if (running.some(i => i.activity === activity)) return activity;
    return this.plan.get(key) ? 'planning' : 'working';
  }
}
