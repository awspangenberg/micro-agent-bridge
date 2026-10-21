// Colour says what a task is doing; animation says how urgent it is.
// Effects: 1 solid, 2 snake (ambient only), 4 breath, 6 shallow breath.
export const PROVIDER = {codex: 0x0066ff, claude: 0xff9900};
const FAST = {e: 4, s: 1}, SLOW = {e: 6, s: .3}, SOLID = {e: 1, s: 0};
export const PALETTE = {
  approval: {c: 0xff3300, b: .6, ...FAST},
  question: {c: 0xff00ff, b: .6, ...FAST},
  planning: {c: 0x8a2be2, b: .5, ...SLOW},
  testing: {c: 0xffd000, b: .5, ...SLOW},
  command: {c: 0x00ccff, b: .5, ...SLOW},
  editing: {c: 0x00ffaa, b: .5, ...SLOW},
  working: {c: null, b: .55, ...SLOW},
  completed: {c: 0x00ff00, b: .5, ...SOLID},
  error: {c: 0xff0000, b: .5, ...SOLID},
  disconnected: {c: 0xff0000, b: .35, ...SLOW},
  inactive: {c: null, b: .15, ...SOLID},
};
const ALIAS = {awaiting_input: 'approval', idle: 'inactive', unknown: 'inactive'};
export const ACTIVE = ['planning', 'testing', 'command', 'editing', 'working'];
export const WAITS = ['approval', 'question'];
export const normalize = state => ALIAS[state] ?? (PALETTE[state] ? state : state === 'empty' ? 'empty' : 'inactive');

// ---- Person's colours -------------------------------------------------------------------
// The palette above is the default. A person can override any part of it in controls.json:
//   lights: {providers: {codex: '#rrggbb'}, keys: {<state>: {c, b, e, s}}, ring: {<situation>: {c, b, e, s}}}
// c is '#rrggbb' (or null where "the app's colour" applies), b brightness 0 to .65 (the
// device's limit), e the animation and s its speed 0 to 1. Only what was changed is stored.
export const KEY_STATES = Object.keys(PALETTE);
export const KEY_EFFECTS = [0, 1, 4, 6];
// The ring: what it shows when something waits for you, errs, works, or nothing happens.
export const RING_STATES = ['approval', 'question', 'error', 'working', 'both', 'idle'];
export const RING_EFFECTS = [0, 1, 2, 4, 6];
const RING = {
  approval: {c: PALETTE.approval.c, b: .6, e: 4, s: 1}, question: {c: PALETTE.question.c, b: .6, e: 4, s: 1},
  error: {c: PALETTE.error.c, b: .45, e: 4, s: .3}, working: {c: null, b: .45, e: 2, s: .3},
  both: {c: 0xffffff, b: .45, e: 2, s: .3}, idle: {c: 0, b: 0, e: 0, s: 0},
};
// Where null means the app's colour.
const PROVIDER_COLOURED = {keys: ['working', 'inactive'], ring: ['working']};

const hex = /^#[0-9a-f]{6}$/i;
function style(value, effects, nullable) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  if (value.c === null && nullable) out.c = null;
  else if (typeof value.c === 'string' && hex.test(value.c)) out.c = value.c.toLowerCase();
  if (Number.isFinite(value.b) && value.b >= 0 && value.b <= .65) out.b = Math.round(value.b * 1000) / 1000;
  if (effects.includes(value.e)) out.e = value.e;
  if (Number.isFinite(value.s) && value.s >= 0 && value.s <= 1) out.s = Math.round(value.s * 100) / 100;
  return Object.keys(out).length ? out : null;
}
/** The valid part of a person's colour overrides; anything else is dropped. */
export function normalizeLights(value) {
  const out = {providers: {}, keys: {}, ring: {}};
  if (!value || typeof value !== 'object') return out;
  for (const p of Object.keys(PROVIDER)) if (typeof value.providers?.[p] === 'string' && hex.test(value.providers[p])) out.providers[p] = value.providers[p].toLowerCase();
  for (const k of KEY_STATES) { const v = style(value.keys?.[k], KEY_EFFECTS, PROVIDER_COLOURED.keys.includes(k)); if (v) out.keys[k] = v; }
  for (const k of RING_STATES) { const v = style(value.ring?.[k], RING_EFFECTS, PROVIDER_COLOURED.ring.includes(k)); if (v) out.ring[k] = v; }
  return out;
}
const toInt = c => typeof c === 'string' ? parseInt(c.slice(1), 16) : c;
/** Defaults with the person's overrides applied, colours as integers. */
export function resolveLights(overrides) {
  const o = normalizeLights(overrides);
  const merge = (base, over) => { const m = {...base, ...over}; return {c: toInt(m.c), b: m.b, e: m.e, s: m.s}; };
  return {
    providers: Object.fromEntries(Object.entries(PROVIDER).map(([p, c]) => [p, toInt(o.providers[p]) ?? c])),
    keys: Object.fromEntries(KEY_STATES.map(k => [k, merge(PALETTE[k], o.keys[k])])),
    ring: Object.fromEntries(RING_STATES.map(k => [k, merge(RING[k], o.ring[k])])),
  };
}
export const DEFAULT_LIGHTS = resolveLights(null);

export function slotLight(state, provider, id, lights = DEFAULT_LIGHTS) {
  const kind = normalize(state);
  if (kind === 'empty') return {id, c: 0, b: 0, e: 0, s: 0, sk: 0, sa: 0};
  const st = lights.keys[kind];
  if (st.e === 0) return {id, c: 0, b: 0, e: 0, s: 0, sk: 0, sa: 0};
  // The app's colour for working/inactive (unless set); gray if a slot has no known provider.
  const c = st.c ?? lights.providers[provider] ?? 0x606060;
  const dim = kind === 'inactive' && !lights.providers[provider] && st.c == null;
  return {id, c, b: dim ? Math.min(st.b, .2) : st.b, e: st.e, s: st.s, sk: 0, sa: 0};
}

// The ring summarizes the most urgent task across every owned slot.
export function ambientLight(tasks, lights = DEFAULT_LIGHTS) {
  const kinds = tasks.filter(t => t && t.state !== 'empty').map(t => ({kind: normalize(t.state), provider: t.provider}));
  const ring = (st, c = st.c) => st.e === 0 ? {e: 0, b: 0, s: 0, m: 0, c: 0} : {e: st.e, b: st.b, s: st.s, m: 0, c: c ?? 0xffffff};
  for (const wait of WAITS) if (kinds.some(k => k.kind === wait)) return ring(lights.ring[wait]);
  if (kinds.some(k => k.kind === 'error')) return ring(lights.ring.error);
  const working = [...new Set(kinds.filter(k => ACTIVE.includes(k.kind)).map(k => k.provider))];
  if (working.length > 1) return ring(lights.ring.both);
  if (working.length) return ring(lights.ring.working, lights.ring.working.c ?? lights.providers[working[0]]);
  return ring(lights.ring.idle);
}
