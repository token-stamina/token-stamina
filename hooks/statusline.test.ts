// Ported from test/pacer.test.js's statusline fixtures (lines 172-198). The legacy
// `statusline.run(raw)` is impure (reads stdin, pace.readState/writeState, optionally spawns
// `cfg.wrap` as a child process) -- NOT ported here (register.ts's job, desktop-only, unverified
// on this PC; whether `cfg.wrap` child-process spawning is even reachable from a mods hook is an
// open question beyond PLAN §7, flagged in statusline.ts's header, not assumed either way).
//
// This port's pure core is `buildState(input, prev, now)` (replaces the read-state + merge half
// of `run`) and `segment(input, state, now, cfg, user)` (replaces the rendering half; `segment`
// gained an explicit trailing `user` param -- see pacer.ts's `thresholds(cfg, user)` header for
// why). Each legacy `statusline.run(raw)` call is ported as `segment(JSON.parse(raw), state, ...)`
// where `state` is whatever `buildState` would have produced and written in the original -- i.e.
// the "records rate_limits and prints segment" test checks `buildState(...).state` directly where
// the legacy test checked `pace.readState()` after the fact, and the "wrap command output is
// kept" test is not portable at all (no fs/process-spawn equivalent in the pure core) and is
// skipped for that reason, same exclusion rationale as nudge.test.ts's run()-persistence test.

import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { buildState, segment, contextTokens, type StatuslineCfg, type StatuslineInput } from './core/statusline.ts';

const cfg: StatuslineCfg = {
  yellowMargin: 10,
  redAt: 90,
  floors: { '5h': { yellow: 25, red: 50 }, '7d': { yellow: 0, red: 0 } },
  fiveHourShowAt: 80,
  lang: 'en',
  turnCostYellowTokens: 100000,
};

test('statusline: no rate_limits => context only, no state change', () => {
  const input: StatuslineInput = { context_window: { used_percentage: 41.3 } };
  const b = buildState(input, null, 0);
  assert.equal(b.changed, false);
  const out = segment(input, b.state, 0, cfg, {});
  assert.equal(out, 'ctx 41%');
});

test('statusline: records rate_limits and prints segment', () => {
  const now = 1_800_000_000;
  const input: StatuslineInput = {
    context_window: { used_percentage: 10 },
    rate_limits: {
      seven_day: { used_percentage: 80, resets_at: now + Math.round(7 * 86400 * 0.5) },
      five_hour: { used_percentage: 85, resets_at: now + Math.round(5 * 3600 * 0.5) },
    },
  };
  const b = buildState(input, null, now);
  assert.equal(b.changed, true);
  assert.equal(b.state.seven_day?.pct, 80);
  assert.equal(b.state.recorded_at, now);
  const out = segment(input, b.state, now, cfg, {});
  assert.ok(out.startsWith('7d 80%'));
  assert.ok(out.includes('🔴') && out.includes('5h 85%') && out.includes('ctx 10%'));
});

test('contextTokens: current_usage sum wins over total_input_tokens; falls back when absent/zero', () => {
  assert.equal(contextTokens(undefined), 0);
  assert.equal(contextTokens({ current_usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } }), 35);
  assert.equal(contextTokens({ current_usage: { input_tokens: 0 }, total_input_tokens: 500 }), 500);
  assert.equal(contextTokens({ total_input_tokens: 0 }), 0);
});

// NOTE: the legacy "statusline: wrap command output is kept" test (pacer.test.js line 192) spawns
// a child process via `cfg.wrap` and is not portable here -- register.ts's job, and whether it's
// even reachable from a mods hook is an open PLAN §7-adjacent question (see statusline.ts header).

test('W7 R1 statusline buildState: a window the render did not carry keeps its old measured time (stays stale)', async () => {
  const { assess } = await import('./core/pacer.ts');
  const now = 1_800_000_000;
  const prev: any = { seven_day: { pct: 94, resets_at: now + 3 * 86400, recorded_at: now - 3 * 86400 }, recorded_at: now - 3 * 86400 };
  const b = buildState({ rate_limits: { five_hour: { used_percentage: 3, resets_at: now + 3600 } } } as any, prev, now);
  assert.equal((b.state as any).seven_day.recorded_at, now - 3 * 86400);
  assert.equal((b.state as any).five_hour.recorded_at, now);
  const a = assess(b.state, now, {});
  assert.equal(a.grade, 'green');
  assert.equal(a.d7, null);
  assert.deepEqual(a.staleWindows, ['7d']);
  // L3: an unstamped (0.4.8) 7d has an unknown time -> dropped, never re-stamped with the top-level time
  const legacy: any = { seven_day: { pct: 94, resets_at: now + 3 * 86400 }, recorded_at: now - 3 * 86400 };
  const b2 = buildState({ rate_limits: { five_hour: { used_percentage: 3, resets_at: now + 3600 } } } as any, legacy, now);
  assert.equal((b2.state as any).seven_day, undefined);
});
