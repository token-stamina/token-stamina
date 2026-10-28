// Status line segment, ported from scripts/statusline.js.
//
// The original read `input.rate_limits` / `input.context_window` (the classic statusLine hook's
// JSON stdin shape) and `pace.readState()`/`pace.writeState()` (state.json on disk). Per
// PLAN-0.5-mods.md §3, the mods replacement is `$.session.usage().rateLimits` / `.context` and
// `$.ui.status` for display -- a different API shape entirely. Rather than guess that shape
// (unverified on this PC, desktop-only), this port keeps `buildState`/`segment` taking the same
// legacy shape as the original (`rate_limits`/`context_window` with `used_percentage`/
// `resets_at`/`current_usage` etc.), and leaves the `$.session.usage()` -> legacy-shape adapter,
// plus the actual `$.ui.status` write, to register.ts. Whether `$.ui.status` even renders inline
// in the desktop status line is an open PLAN §7 question -- flagged, not assumed.
//
// `pace.thresholds(cfg)` became `thresholds(cfg, user)` in pacer.ts (see that file's header), so
// `segment` now also takes an explicit `user` parameter.

import { assess, fmt1, fmtReset, fmtClock, thresholds, type PaceConfig, type PaceState } from './pacer.ts';
import { tokLabel } from './boundary.ts';

export const ICON: Record<string, string> = { green: '🟢', yellow: '🟡', red: '🔴' };

export interface ContextWindow {
  current_usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  total_input_tokens?: number;
  used_percentage?: number;
}

// Current context size: current_usage (input + cache read + cache creation), else total_input_tokens.
export function contextTokens(cw: ContextWindow | null | undefined): number {
  if (!cw) return 0;
  const u = cw.current_usage;
  if (u && typeof u === 'object') {
    const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (n > 0) return n;
  }
  return typeof cw.total_input_tokens === 'number' && cw.total_input_tokens > 0 ? cw.total_input_tokens : 0;
}

export interface RateLimitWindow { used_percentage?: number; resets_at?: number }
export interface StatuslineInput {
  rate_limits?: { seven_day?: RateLimitWindow; five_hour?: RateLimitWindow };
  context_window?: ContextWindow;
}
export interface BuildStateResult { state: PaceState; changed: boolean }

export function buildState(input: StatuslineInput | null | undefined, prev: PaceState | null | undefined, now: number): BuildStateResult {
  const rl = input && input.rate_limits;
  const next: PaceState = Object.assign({}, prev || {});
  let changed = false;
  if (rl) {
    for (const k of ['seven_day', 'five_hour'] as const) {
      const w = rl[k];
      if (w && typeof w.used_percentage === 'number' && typeof w.resets_at === 'number') {
        (next as any)[k] = { pct: w.used_percentage, resets_at: w.resets_at, recorded_at: now };
        changed = true;
      }
    }
  }
  if (changed) {
    // A window this render did not carry keeps the time it was really measured (W7 R1: never refresh an old value).
    // Unknown time (no own stamp, as 0.4.8 wrote, or a stamp >120 s ahead) drops the window. Mirror of statusline.js.
    const p: any = prev || {};
    for (const k of ['seven_day', 'five_hour'] as const) {
      const w: any = (next as any)[k];
      if (!w || w !== p[k]) continue;
      const t = w.recorded_at;
      if (typeof t !== 'number' || !isFinite(t) || t > now + 120) delete (next as any)[k];
    }
    (next as any).recorded_at = now; (next as any).source = 'statusline';
  }
  return { state: next, changed };
}

export interface StatuslineCfg extends PaceConfig {
  lang?: string;
  fiveHourShowAt?: number;
  turnCostYellowTokens?: number;
  wrap?: string;
}

// Pure. `user` is the raw (not merged-with-defaults) user config.json object, forwarded to
// pacer.ts's `thresholds(cfg, user)` -- see pacer.ts header for why this stays separate from `cfg`.
export function segment(
  input: StatuslineInput | null | undefined,
  state: PaceState | null | undefined,
  now: number,
  cfg: StatuslineCfg,
  user: Record<string, unknown> | undefined,
): string {
  const lang = cfg.lang || 'en';
  const L =
    ({
      ko: { today: '오늘 몫', reset: '리셋', empty: '소진 예상', turn: '턴' },
      ja: { today: '今日の枠', reset: 'リセット', empty: '枯渇予想', turn: 'ターン' },
    } as Record<string, { today: string; reset: string; empty: string; turn: string }>)[lang] ||
    { today: 'today', reset: 'reset', empty: 'empty', turn: 'turn' };
  const parts: string[] = [];
  const a = assess(state, now, cfg);
  if (a.d7) {
    parts.push(`7d ${Math.round(a.d7.used)}%`);
    parts.push(`${L.today} ${fmt1(a.quota as number)}% ${ICON[a.grade as string] || ''}`.trim());
    parts.push(`${L.reset} ${fmtReset(a.d7.resetsAt, lang)}`);
  } else if (a.h5) {
    parts.push(`${ICON[a.grade as string] || ''}`);
  }
  if (a.h5 && (a.h5.used >= (cfg.fiveHourShowAt || 80) || a.exhaust5h)) {
    let s = `5h ${Math.round(a.h5.used)}%`;
    if (a.exhaust5h) s += ` → ${fmtClock(a.exhaust5h)} ${L.empty} · ${L.reset} ${fmtClock(a.h5.resetsAt)}`;
    parts.push(s);
  }
  const cw = input && input.context_window;
  const ctx = cw && cw.used_percentage;
  const tok = contextTokens(cw);
  let c = '';
  if (typeof ctx === 'number') c = `ctx ${Math.round(ctx)}%`;
  if (tok) {
    // ASCII unit on purpose: some terminals mis-measure the width of 만 in the status line and garble it.
    const per = `${tokLabel(tok, 'en')}/${L.turn}`;
    c = c ? `${c} (${per})` : `ctx (${per})`;
    if (tok >= thresholds(cfg, user).compactAt) c += ' 🔴';
    else if (tok >= (cfg.turnCostYellowTokens || 100000)) c += ' 🟡';
  }
  if (c) parts.push(c);
  return parts.filter(Boolean).join(' · ');
}

// NOTE: the original module's impure `run(raw)` (reads stdin, pace.readState/writeState,
// optionally spawns `cfg.wrap` as a child process and merges its stdout) is NOT ported here.
// Whether child-process spawning (`cfg.wrap`) is even reachable from a mods hook is an open
// question beyond PLAN §7 -- flagged for desktop verification, not assumed either way.
