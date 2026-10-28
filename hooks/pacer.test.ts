// Ported from test/pacer.test.js (pace.assess/exhaustAt/dailyQuota/windowStats fixtures) and
// test/v03b.test.js (pace.thresholds/pace.attributed fixtures) and test/v03.test.js
// (pace.skipHook fixtures). Only the pure math is ported here -- register.ts/run()-orchestration
// fixtures (nudge.run persists state, statusline.run reads stdin) are desktop-only and not
// portable to a hooks/core/*.ts unit test.
//
// NOTE on `thresholds(cfg, user)`: the ported signature splits the original single `cfg` argument
// into `cfg` (participates in compactWindowTokens scaling) and `user` (explicit per-key overrides,
// checked FIRST, before window scaling -- see pacer.ts's `pick()`). The legacy test's single `cfg`
// object played both roles at once (it was config.json's own merged contents). To reproduce the
// exact legacy precedence here, each legacy call is ported as `thresholds(cfg, cfg)` (same object
// passed twice) EXCEPT where a case specifically wants to prove the override-vs-scaling precedence,
// which is ported as `thresholds({compactWindowTokens}, {compactAtTokens})` (override isolated into
// `user`) to show the override wins even when window-scaling would otherwise apply.

import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { assess, exhaustAt, thresholds, attributed, shouldSkipHook, WEEK, FIVE, type PaceConfig } from './core/pacer.ts';

const NOW = 1_800_000_000;
// Mirrors config.default.json's effective defaults (pace.loadConfig() with no config.json on
// disk) -- the 5h floors in particular matter for the "5h floors stop early-window red" fixture.
const cfg: PaceConfig = {
  yellowMargin: 10,
  redAt: 90,
  floors: { '5h': { yellow: 25, red: 50 }, '7d': { yellow: 0, red: 0 } },
  stateMaxAgeSec: 21600,
};
// 7d window, fraction `e` elapsed, used `u`.
const week = (u: number, e: number) => ({ pct: u, resets_at: NOW + Math.round(WEEK * (1 - e)) });
const five = (u: number, e: number) => ({ pct: u, resets_at: NOW + Math.round(FIVE * (1 - e)) });
const st = (d7?: unknown, h5?: unknown) => ({ seven_day: d7, five_hour: h5, recorded_at: NOW });

test('pace: grades by margin against elapsed', () => {
  assert.equal(assess(st(week(40, 0.5)) as any, NOW, cfg).grade, 'green');
  assert.equal(assess(st(week(55, 0.5)) as any, NOW, cfg).grade, 'yellow');
  assert.equal(assess(st(week(61, 0.5)) as any, NOW, cfg).grade, 'red');
  assert.equal(assess(st(week(90, 0.99)) as any, NOW, cfg).grade, 'red'); // u >= 90
});

test('pace: window just started (e ~ 0)', () => {
  const a = assess(st(week(0, 0.0)) as any, NOW, cfg);
  assert.equal(a.grade, 'green');
  assert.ok(Math.abs((a.d7 as any).elapsedPct) < 0.01);
  assert.equal(assess(st(week(5, 0.0)) as any, NOW, cfg).grade, 'yellow');
});

test('pace: reset already passed => window ignored', () => {
  const s = st({ pct: 95, resets_at: NOW - 10 }, null);
  assert.equal(assess(s as any, NOW, cfg).grade, null);
});

test('pace: missing fields and null state', () => {
  assert.equal(assess(null, NOW, cfg).grade, null);
  assert.equal(assess({} as any, NOW, cfg).grade, null);
  assert.equal(assess({ seven_day: { pct: 'x' } } as any, NOW, cfg).grade, null);
  assert.equal(assess({ seven_day: { pct: 50 } } as any, NOW, cfg).grade, null);
});

test('pace: worse window wins, calm 5h never upgrades', () => {
  const a = assess(st(week(80, 0.5), five(1, 0.5)) as any, NOW, cfg);
  assert.equal(a.grade, 'red');
  assert.equal(a.worst, '7d');
  const b = assess(st(week(10, 0.5), five(90, 0.5)) as any, NOW, cfg);
  assert.equal(b.grade, 'red');
  assert.equal(b.worst, '5h');
});

test('pace: 5h floors stop early-window red', () => {
  // 5% used 10 minutes into the 5h window is far ahead of linear pace but not a real risk.
  assert.equal(assess(st(week(10, 0.5), five(5, 10 / 300)) as any, NOW, cfg).grade, 'green');
  assert.equal(assess(st(week(10, 0.5), five(30, 0.05)) as any, NOW, cfg).grade, 'yellow');
  assert.equal(assess(st(week(10, 0.5), five(55, 0.2)) as any, NOW, cfg).grade, 'red');
  // 7d keeps no floor: 11% one hour after reset is still red.
  assert.equal(assess(st(week(11, 1 / 168)) as any, NOW, cfg).grade, 'red');
});

test('pace: daily quota and 5h exhaust projection', () => {
  const a = assess(st(week(50, 0.5)) as any, NOW, cfg);
  assert.ok(Math.abs((a.quota as number) - 50 / 3.5) < 0.01);
  // 50% used with half the window gone => hits 100% exactly at reset => null
  assert.equal(exhaustAt(five(50, 0.5), FIVE, NOW), null);
  const t = exhaustAt(five(80, 0.5), FIVE, NOW) as number;
  assert.ok(t > NOW && t < NOW + FIVE / 2);
  assert.equal(exhaustAt(five(0, 0.5), FIVE, NOW), null);
});

test('thresholds: defaults, scaled from window, explicit key wins', () => {
  const base: PaceConfig = {};
  assert.deepEqual(thresholds(base, base), { compactAt: 150000, newAt: 400000, gateAt: 200000 });
  const w600: PaceConfig = { compactWindowTokens: 600000 };
  assert.deepEqual(thresholds(w600, w600), { compactAt: 240000, newAt: 570000, gateAt: 300000 });
  const w400: PaceConfig = { compactWindowTokens: 400000 };
  assert.deepEqual(thresholds(w400, w400), { compactAt: 160000, newAt: 380000, gateAt: 200000 });
  // Explicit override isolated in `user`: wins over window-scaling even though the window is set.
  assert.equal(thresholds({ compactWindowTokens: 400000 }, { compactAtTokens: 123000 }).compactAt, 123000);
  // Same override, legacy-equivalent shape (cfg and user are the same merged config.json object):
  // this is the shape that matches the original single-argument `pace.thresholds(cfg)` exactly.
  const merged: PaceConfig = { compactWindowTokens: 400000, compactAtTokens: 123000 };
  assert.equal(thresholds(merged, merged).compactAt, 123000);
});

test('model-facing lines tell Claude to name Token Stamina when relaying (v0.3.6)', () => {
  const ko = attributed('Token Stamina: x', 'ko');
  assert.ok(ko.startsWith('Token Stamina: x') && ko.includes('"Token Stamina 알림:"'));
  assert.ok(attributed('Token Stamina: x', 'en').includes('start with "Token Stamina:"'));
  assert.ok(attributed('y', undefined).includes('Token Stamina:'));
});

test('skipHook: headless entrypoint and excluded cwd', () => {
  assert.equal(shouldSkipHook('sdk-cli', 'C:\Work'), true);
  assert.equal(shouldSkipHook('cli', 'C:\Work'), false);
  assert.equal(shouldSkipHook('cli', 'C:\Temp\Botwork', ['botwork']), true);
  assert.equal(shouldSkipHook('cli', 'C:\Work', ['botwork']), false);
});
