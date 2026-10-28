// Pure part of scripts/sync-usage.js (entry B): get_usage result -> accepted windows, and the window-wise merge.
// No fs/env/clock; `nowSec` and `prev` are passed in. Contract: DESIGN-v2-integrated.md 4.1.

export interface SyncWindow { pct: number; resets_at: number; recorded_at?: number }
export interface SyncState {
  seven_day?: SyncWindow;
  five_hour?: SyncWindow;
  recorded_at?: number;
  source?: string;
}
export interface FromUsageResult {
  state: SyncState | null;
  reason: string;
  extra: { label: string; pct: unknown }[];
  rejected: string[];
}
export interface MergeResult { state: SyncState | null; written: boolean; reason: string; dropped: string[] }

type Key = 'seven_day' | 'five_hour';
const RESET_MAX: Record<Key, number> = { seven_day: 8 * 86400, five_hour: 5 * 3600 + 600 };

function pctOf(x: unknown): number | null {
  return typeof x === 'number' && isFinite(x) && x >= 0 && x <= 100 ? x : null; // out of range: reject, never clamp
}

function resetOf(x: unknown): number | null {
  if (typeof x === 'number' && isFinite(x)) return Math.floor(x);
  if (typeof x === 'string') {
    const t = Date.parse(x);
    if (isFinite(t)) return Math.floor(t / 1000);
  }
  return null;
}

export function labelKey(label: unknown): Key | null | undefined {
  if (typeof label !== 'string') return null;
  if (/^5[\s-]*hour/i.test(label)) return 'five_hour';
  if (/^weekly/i.test(label) && /all models/i.test(label)) return 'seven_day';
  return undefined; // another window (per-model weekly etc.)
}

export function fromUsage(usage: any, nowSec: number): FromUsageResult {
  const out: FromUsageResult = { state: null, reason: 'parse', extra: [], rejected: [] };
  if (!usage || typeof usage !== 'object') return out;
  const found: Partial<Record<Key, { pct: unknown; resets: unknown }>> = {};
  if (usage.plan && typeof usage.plan === 'object') {
    if (usage.plan.status !== 'ok') { out.reason = 'status:' + usage.plan.status; return out; }
    const ws = Array.isArray(usage.plan.windows) ? usage.plan.windows : [];
    for (const w of ws) {
      if (!w || typeof w !== 'object') continue;
      const k = labelKey(w.label);
      if (k === undefined) {
        if (typeof w.label === 'string') out.extra.push({ label: w.label, pct: w.percentUsed });
      } else if (k && !found[k]) found[k] = { pct: w.percentUsed, resets: w.resetsAt };
    }
  } else if (usage.seven_day || usage.five_hour) {
    for (const k of ['seven_day', 'five_hour'] as const) {
      const w = usage[k];
      if (w && typeof w === 'object') found[k] = { pct: w.pct !== undefined ? w.pct : w.used_percentage, resets: w.resets_at };
    }
  } else { out.reason = 'no_window'; return out; }
  const keys = Object.keys(found) as Key[];
  if (!keys.length) { out.reason = 'no_window'; return out; }
  const state: SyncState = {};
  for (const k of keys) {
    const pct = pctOf(found[k]!.pct);
    const r = resetOf(found[k]!.resets);
    if (pct === null || r === null || !(r > nowSec) || r > nowSec + RESET_MAX[k]) { out.rejected.push(k); continue; }
    state[k] = { pct, resets_at: r };
  }
  if (!state.seven_day && !state.five_hour) { out.reason = 'invalid:' + out.rejected.join(','); return out; }
  state.recorded_at = nowSec;
  state.source = 'get_usage';
  out.state = state;
  out.reason = 'ok';
  return out;
}

// Every window carries its own recorded_at: a window this response did not update keeps the time it was really
// measured (never "now"), and is dropped when that time is older than maxAgeSec or unknown (W7 R1). Unknown includes
// a window without its own stamp (0.4.8 wrote only the top-level time) and a stamp more than FUTURE_SKEW_SEC ahead of
// now (clock went backwards). Mirror of scripts/sync-usage.js.
const MERGE_MAX_AGE = 21600;
export const FUTURE_SKEW_SEC = 120;
function windowTime(w: SyncWindow | undefined, nowSec: number): number | null {
  if (!w || typeof w.recorded_at !== 'number' || !isFinite(w.recorded_at)) return null;
  return w.recorded_at > nowSec + FUTURE_SKEW_SEC ? null : w.recorded_at;
}
export function merge(prev: SyncState | null | undefined, next: SyncState | null, nowSec: number, maxAgeSec?: number): MergeResult {
  if (!next) return { state: prev || null, written: false, reason: 'no_state', dropped: [] };
  if (prev && typeof prev.recorded_at === 'number' && prev.recorded_at > nowSec - 60 && prev.recorded_at <= nowSec + 60 && prev.source !== 'get_usage') {
    return { state: prev, written: false, reason: 'fresher_exists', dropped: [] };
  }
  const maxAge = typeof maxAgeSec === 'number' && isFinite(maxAgeSec) && maxAgeSec > 0 ? maxAgeSec : MERGE_MAX_AGE;
  const state: SyncState = Object.assign({}, prev || {});
  const dropped: string[] = [];
  for (const k of ['seven_day', 'five_hour'] as const) {
    const n = next[k];
    if (n) { state[k] = { pct: n.pct, resets_at: n.resets_at, recorded_at: nowSec }; continue; }
    const p = prev ? prev[k] : undefined;
    if (!prev || !p) { delete state[k]; continue; }
    const t = windowTime(p, nowSec);
    if (t === null || nowSec - t > maxAge) { delete state[k]; dropped.push(k); } else state[k] = Object.assign({}, p, { recorded_at: t });
  }
  state.recorded_at = nowSec;
  state.source = 'get_usage';
  return { state, written: true, reason: 'ok', dropped };
}
