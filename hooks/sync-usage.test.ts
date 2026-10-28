// Mirrors the pure cases of test/v11.test.js (sync-usage): fromUsage / merge in hooks/core/sync-usage.ts.
import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { fromUsage, merge } from './core/sync-usage.ts';

const NOW = Math.floor(Date.parse('2026-10-27T12:00:00Z') / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const W5 = (o: any = {}) => ({ label: '5-hour limit', percentUsed: 2, resetsAt: iso(NOW + 3 * 3600), ...o });
const W7 = (o: any = {}) => ({ label: 'Weekly · all models', percentUsed: 25, resetsAt: iso(NOW + 5 * 86400), ...o });
const WF = () => ({ label: 'Weekly · Fable', percentUsed: 2, resetsAt: iso(NOW + 5 * 86400) });
const ok = (...ws: any[]) => ({ plan: { status: 'ok', windows: ws } });

test('sync: ok response -> both windows, epoch seconds, source, extra', () => {
  const r = fromUsage(ok(W5(), W7(), WF()), NOW);
  assert.equal(r.state!.seven_day!.pct, 25);
  assert.equal(r.state!.five_hour!.pct, 2);
  assert.equal(r.state!.seven_day!.resets_at, NOW + 5 * 86400);
  assert.equal(r.state!.source, 'get_usage');
  assert.equal(r.state!.recorded_at, NOW);
  assert.deepEqual(r.extra, [{ label: 'Weekly · Fable', pct: 2 }]);
});

test('sync: non-ok status -> null with reason', () => {
  assert.equal(fromUsage({ plan: { status: 'not_applicable' } }, NOW).state, null);
  assert.equal(fromUsage({ plan: { status: 'not_applicable' } }, NOW).reason, 'status:not_applicable');
  assert.equal(fromUsage({ plan: { status: 'unavailable' } }, NOW).reason, 'status:unavailable');
});

test('sync: label variants match; Fable-only weekly gives no seven_day', () => {
  const r = fromUsage(ok(W5({ label: '5-Hour Limit' }), W7({ label: 'weekly - ALL MODELS' })), NOW);
  assert.ok(r.state!.five_hour && r.state!.seven_day);
  const f = fromUsage(ok(W5(), WF()), NOW);
  assert.ok(f.state!.five_hour);
  assert.equal(f.state!.seven_day, undefined);
});

test('sync: past reset rejects that window only', () => {
  const r = fromUsage(ok(W5(), W7({ resetsAt: iso(NOW - 3600) })), NOW);
  assert.equal(r.state!.seven_day, undefined);
  assert.ok(r.state!.five_hour);
  assert.deepEqual(r.rejected, ['seven_day']);
});

test('sync: out-of-range / non-number pct rejected, not clamped', () => {
  for (const p of [101, -1, '25', NaN, null]) {
    const r = fromUsage(ok(W7({ percentUsed: p })), NOW);
    assert.equal(r.state, null, String(p));
  }
});

test('sync: reset beyond the cap rejected (7d: +9d, 5h: +6h)', () => {
  assert.equal(fromUsage(ok(W7({ resetsAt: iso(NOW + 9 * 86400) })), NOW).state, null);
  assert.equal(fromUsage(ok(W5({ resetsAt: iso(NOW + 6 * 3600) })), NOW).state, null);
});

test('sync: flat format is recorded as given', () => {
  const r = fromUsage({ seven_day: { pct: 30, resets_at: NOW + 86400 }, five_hour: { pct: 4, resets_at: NOW + 3600 } }, NOW);
  assert.equal(r.state!.seven_day!.pct, 30);
  assert.equal(r.state!.five_hour!.resets_at, NOW + 3600);
});

test('sync: garbage -> null', () => {
  assert.equal(fromUsage(null, NOW).state, null);
  assert.equal(fromUsage('x', NOW).state, null);
});

test('sync merge: fresher statusline record blocks, old or get_usage record does not', () => {
  const next = fromUsage(ok(W5(), W7()), NOW).state;
  const a = merge({ recorded_at: NOW - 30 }, next, NOW);
  assert.equal(a.written, false);
  assert.equal(a.reason, 'fresher_exists');
  assert.equal(merge({ recorded_at: NOW - 61 }, next, NOW).written, true);
  assert.equal(merge({ recorded_at: NOW - 30, source: 'get_usage' }, next, NOW).written, true);
});

test('sync merge: per-window overwrite keeps a fresh other window of prev, with its own measured time', () => {
  // 0.5 states stamp every window (L3: an unstamped window's time is unknown and is dropped, see the r1 C mirror below)
  const prev = { seven_day: { pct: 10, resets_at: NOW + 100 }, five_hour: { pct: 50, resets_at: NOW + 200, recorded_at: NOW - 2 * 3600 }, recorded_at: NOW - 2 * 3600 };
  const next = fromUsage(ok(W7()), NOW).state;
  const m = merge(prev, next, NOW);
  assert.equal(m.written, true);
  assert.equal(m.state!.seven_day!.pct, 25);
  assert.equal(m.state!.seven_day!.recorded_at, NOW);
  assert.deepEqual(m.state!.five_hour, Object.assign({}, prev.five_hour, { recorded_at: NOW - 2 * 3600 }));
});

test('W7 R1 sync merge: a stale window the response did not carry is dropped, never re-stamped as fresh', () => {
  const prev = { seven_day: { pct: 94, resets_at: NOW + 3 * 86400 }, five_hour: { pct: 50, resets_at: NOW - 100 }, recorded_at: NOW - 3 * 86400 };
  const next = fromUsage(ok(W5()), NOW).state;
  const m = merge(prev, next, NOW, 21600);
  assert.equal(m.written, true);
  assert.equal(m.state!.seven_day, undefined);
  assert.deepEqual(m.dropped, ['seven_day']);
  assert.equal(m.state!.five_hour!.recorded_at, NOW);
  // own recorded_at wins over the state's: a window measured 7 h ago stays out even when the state was written just now
  const prev2 = { seven_day: { pct: 94, resets_at: NOW + 86400, recorded_at: NOW - 7 * 3600 }, recorded_at: NOW - 120, source: 'get_usage' };
  assert.equal(merge(prev2, next, NOW, 21600).state!.seven_day, undefined);
});

// ---- re-review mirrors: M1 clock going back, L1 per-window sync hint, L2 measured_at, L3 legacy state (r1 C, D, F, G) ----
import { createRequire } from 'node:module';
import { assess } from './core/pacer.ts';
import { buildState } from './core/statusline.ts';
import { syncHint, syncAgeSec } from './core/nudge.ts';
import { accountOf, measured7d } from './core/board.ts';
const rq = createRequire(import.meta.url);
const suJs = rq('../scripts/sync-usage.js');
const paceJs = rq('../scripts/pace.js');
const slJs = rq('../scripts/statusline.js');
const nudgeJs = rq('../scripts/nudge.js');
const boardJs = rq('../scripts/board.js');
const HR = 3600;
const W5n = (p: number) => ({ label: '5-hour', percentUsed: p, resetsAt: NOW + 4 * HR });
const W7n = (p: number) => ({ label: 'Weekly · all models', percentUsed: p, resetsAt: NOW + 3 * 86400 });

const CASES: Record<string, any> = {
  C_legacy048: { seven_day: { pct: 94, resets_at: NOW + 2 * 86400 }, five_hour: { pct: 3, resets_at: NOW + 4 * HR }, recorded_at: NOW - 600 },
  D_future: { seven_day: { pct: 94, resets_at: NOW + 3 * 86400, recorded_at: NOW + 86400 }, recorded_at: NOW + 86400, source: 'get_usage' },
  F_futureSl: { seven_day: { pct: 94, resets_at: NOW + 3 * 86400, recorded_at: NOW + 86400 }, recorded_at: NOW + 86400, source: 'statusline' },
};

test('M1/L3 sync-usage.ts merge == JS on r1 C/D/F: unknown 7d time dropped, future statusline record does not block', () => {
  for (const [name, prev] of Object.entries(CASES)) {
    const usage = name === 'F_futureSl' ? ok(W7n(20), W5n(3)) : ok(W5n(3));
    const ts = merge(prev, fromUsage(usage, NOW).state, NOW);
    const js = suJs.merge(prev, suJs.fromUsage(usage, NOW).state, NOW);
    assert.deepEqual(ts, js, name);
    if (name === 'F_futureSl') { assert.equal(ts.written, true); assert.equal(ts.state!.seven_day!.pct, 20); }
    else { assert.equal(ts.state!.seven_day, undefined, name); assert.deepEqual(ts.dropped, ['seven_day']); }
  }
});

test('M1 (r1 G) pacer.ts assess == JS: future stamp is stale; statusline.ts drops unknown-time carried 7d', () => {
  const st = CASES.D_future;
  assert.equal(assess(st, NOW + 7 * HR, {}).stale, true);
  assert.deepEqual(assess(st, NOW + 7 * HR, {}), paceJs.assess(st, NOW + 7 * HR, {}));
  const rl = { rate_limits: { five_hour: { used_percentage: 3, resets_at: NOW + 4 * HR } } };
  for (const prev of [CASES.C_legacy048, CASES.D_future]) {
    const b = buildState(rl, prev, NOW);
    assert.equal((b.state as any).seven_day, undefined);
    assert.deepEqual(b, slJs.buildState(rl, prev, NOW));
  }
});

test('L1 nudge.ts syncHint == JS: fresh 5h + stale/missing 7d asks for a sync; syncAgeSec uses the 7d stamp', () => {
  const st = { five_hour: { pct: 3, resets_at: NOW + 4 * HR, recorded_at: NOW }, seven_day: { pct: 50, resets_at: NOW + 2 * 86400, recorded_at: NOW - 10 * HR }, recorded_at: NOW };
  const DESK = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' };
  for (const s of [st, { five_hour: st.five_hour, recorded_at: NOW }]) {
    const a: any = assess(s, NOW, {}); a.ageSec = syncAgeSec(s, NOW);
    assert.equal(a.ageSec, nudgeJs.syncAgeSec(s, NOW));
    const ts = syncHint({ hook_event_name: 'SessionStart' }, a, { lang: 'ko' }, NOW, {}, DESK, '/r');
    const js = nudgeJs.syncHint({ hook_event_name: 'SessionStart' }, a, { lang: 'ko' }, NOW, {}, DESK, '/r');
    assert.deepEqual(ts, js);
    assert.ok(['stale_7d', 'no_7d'].includes(ts.reason), ts.reason);
    assert.ok(ts.text && ts.text.includes('(7d)'));
  }
});

test('L2 board.ts accountOf == JS: measured_at is the 7d window stamp (null when missing / future)', () => {
  const st = { seven_day: { pct: 40, resets_at: NOW + 2 * 86400, recorded_at: NOW - 5 * HR }, five_hour: { pct: 3, resets_at: NOW + 4 * HR, recorded_at: NOW }, recorded_at: NOW };
  const a = assess(st, NOW, {});
  assert.equal(accountOf(st, a, NOW).measured_at, iso(NOW - 5 * HR));
  assert.deepEqual(accountOf(st, a, NOW), boardJs.accountOf(st, a, NOW));
  assert.equal(measured7d({ seven_day: { recorded_at: NOW + 86400 } }, NOW), null);
  assert.equal(measured7d({ recorded_at: NOW }, NOW), null);
});
