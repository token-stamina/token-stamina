// Not a direct legacy port -- the only existing test touching scripts/agent-model.js (test/v04.test.js
// "handoff: clear restore records from_session; agent_model event carries tool_use_id", line ~177)
// exercises the impure `run(raw)` orchestration end-to-end (stdin JSON -> events.jsonl), which is
// register.ts's job on the ported side (desktop-only, unverified on this PC) and is not portable here.
// There is no legacy fixture that calls `decide()` directly with concrete inputs/outputs.
//
// decide() was already designed (in the original, carried over unchanged into hooks/core/agent-model.ts)
// to take an injectable `opts.definitionHasModel`, specifically so it stays pure and testable without
// touching the filesystem -- so this file exercises it directly against its own documented branches
// (mode off / has_model / fork / definition_model / no_state / stale_state / grade_<x> / judgment
// keyword / simple-keyword downgrade / suggest mode), mirroring the precedent set in lang.test.ts's
// 'isAuto/withLang' test for pure helpers with no standalone legacy unit test.

import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { decide, includesAny, output, type AgentModelCfg } from './core/agent-model.ts';

const NOW = 1_800_000_000;
const WEEK = 7 * 86400;
const week = (u: number, e: number) => ({ pct: u, resets_at: NOW + Math.round(WEEK * (1 - e)) });

const baseCfg: AgentModelCfg = {
  yellowMargin: 10,
  redAt: 90,
  floors: { '5h': { yellow: 25, red: 50 }, '7d': { yellow: 0, red: 0 } },
  stateMaxAgeSec: 21600,
  mode: 'inject',
  lang: 'ko',
  judgmentKeywords: ['설계', 'design'],
  simpleKeywords: ['정리', 'format'],
};
const redState = { seven_day: week(61, 0.5), recorded_at: NOW };
const greenState = { seven_day: week(40, 0.5), recorded_at: NOW };

test('includesAny: words are matched lowercase, but the original casing is returned; empty text/list is null', () => {
  // decide() always lowercases the haystack before calling this -- the needle is lowercased
  // internally here, so a mixed-case keyword list still matches a lowercase haystack.
  assert.equal(includesAny('please design the schema', ['DESIGN', 'format']), 'DESIGN');
  assert.equal(includesAny('just format this file', ['design', 'format']), 'format');
  assert.equal(includesAny('do the thing', ['design', 'format']), null);
  assert.equal(includesAny('anything', undefined), null);
});

test('decide: mode off always passes, regardless of state', () => {
  const r = decide({ tool_input: { subagent_type: 'general-purpose' } }, redState, { ...baseCfg, mode: 'off' }, NOW);
  assert.deepEqual(r, { action: 'pass', reason: 'mode_off' });
});

test('decide: an explicit model always wins, before any state/definition check', () => {
  const r = decide({ tool_input: { model: 'opus', subagent_type: 'general-purpose' } }, redState, baseCfg, NOW);
  assert.equal(r.action, 'pass');
  assert.equal(r.reason, 'has_model');
});

test('decide: subagent_type "fork" is exempt (inherits the parent model by design)', () => {
  const r = decide({ tool_input: { subagent_type: 'fork' } }, redState, baseCfg, NOW);
  assert.deepEqual(r, { action: 'pass', reason: 'fork' });
});

test('decide: an agent definition that already pins a model is left alone', () => {
  const r = decide(
    { tool_input: { subagent_type: 'code-reviewer' }, cwd: 'C:\\proj' },
    redState,
    baseCfg,
    NOW,
    { definitionHasModel: () => true },
  );
  assert.deepEqual(r, { action: 'pass', reason: 'definition_model' });
});

test('decide: no usable state at all passes quietly', () => {
  const r = decide({ tool_input: { subagent_type: 'general-purpose' } }, null, baseCfg, NOW, { definitionHasModel: () => false });
  assert.deepEqual(r, { action: 'pass', reason: 'no_state' });
});

test('decide: stale state (older than stateMaxAgeSec) passes quietly even if it would read red', () => {
  const stale = { seven_day: week(61, 0.5), recorded_at: NOW - 30000 }; // > 21600s old
  const r = decide({ tool_input: { subagent_type: 'general-purpose' } }, stale, baseCfg, NOW, { definitionHasModel: () => false });
  assert.deepEqual(r, { action: 'pass', reason: 'stale_state' });
});

test('decide: green/yellow pace is left alone, only red triggers a downgrade', () => {
  const r = decide({ tool_input: { subagent_type: 'general-purpose' } }, greenState, baseCfg, NOW, { definitionHasModel: () => false });
  assert.deepEqual(r, { action: 'pass', reason: 'grade_green' });
});

test('decide: judgment-keyword text is never forced, only suggested', () => {
  const r = decide(
    { tool_input: { subagent_type: 'general-purpose', description: 'design the new schema' } },
    redState,
    baseCfg,
    NOW,
    { definitionHasModel: () => false },
  );
  assert.equal(r.action, 'suggest');
  assert.equal(r.reason, 'judgment:design');
  assert.equal(r.grade, 'red');
  assert.ok(r.message && r.message.includes('모델을 강제하지 않았어요'));
});

test('decide: red + no keywords downgrades to sonnet; simple-keyword text downgrades to haiku', () => {
  const generic = decide({ tool_input: { subagent_type: 'general-purpose', description: 'investigate the bug' } }, redState, baseCfg, NOW, { definitionHasModel: () => false });
  assert.equal(generic.action, 'inject');
  assert.equal(generic.model, 'sonnet');
  assert.equal(generic.reason, 'red_downgrade');
  assert.ok(generic.message && generic.message.includes('model="sonnet"'));

  const simple = decide({ tool_input: { subagent_type: 'general-purpose', description: 'format this file' } }, redState, baseCfg, NOW, { definitionHasModel: () => false });
  assert.equal(simple.model, 'haiku');
});

test('decide: suggest mode never forces a model, even outside the judgment-keyword path', () => {
  const r = decide(
    { tool_input: { subagent_type: 'general-purpose', description: 'investigate the bug' } },
    redState,
    { ...baseCfg, mode: 'suggest' },
    NOW,
    { definitionHasModel: () => false },
  );
  assert.equal(r.action, 'suggest');
  assert.equal(r.reason, 'suggest_mode');
  assert.equal(r.model, 'sonnet');
  assert.ok(r.message && r.message.includes('고려하세요'));
});

test('output: inject updates tool_input.model and carries additionalContext; suggest/pass never touch tool_input', () => {
  const input = { tool_input: { subagent_type: 'general-purpose', prompt: 'x' } };
  const inj = output(input, { action: 'inject', reason: 'red_downgrade', model: 'sonnet', message: 'm' });
  assert.deepEqual(inj, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { subagent_type: 'general-purpose', prompt: 'x', model: 'sonnet' }, additionalContext: 'm' },
  });
  const sug = output(input, { action: 'suggest', reason: 'judgment:design', message: 'm2' });
  assert.deepEqual(sug, { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'm2' } });
  assert.equal(output(input, { action: 'pass', reason: 'has_model' }), null);
});

// ---- 0.4.9-fleet W4: fleet rows (DESIGN-v2 §5.3, TEST-PLAN-v2 §W4) ----
// The grid fixture is a snapshot of decide() taken before the fleet rows existed (shared with test/v13.test.js).
// TS/JS parity is checked by running scripts/agent-model.js side by side over every row and switch.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sanitizeFleet, fleetDist, T } from './core/agent-model.ts';

const grid = JSON.parse(readFileSync(new URL('../test/fixtures/agent-model/legacy-grid.json', import.meta.url), 'utf8'));
const jsAm = createRequire(import.meta.url)('../scripts/agent-model.js');
const GNOW: number = grid.now;
const noDef = { definitionHasModel: () => false };
const gin = (description: string, extra?: object) => ({ tool_input: { subagent_type: 'general-purpose', description, ...(extra || {}) } });
const gcfg = (over?: object): AgentModelCfg => ({ ...grid.cfg, mode: 'inject', lang: 'ko', ...(over || {}) });
const GARBAGE: unknown[] = ['3', { running: 'x' }, { running: -1 }, { running: NaN }, [], { running: Infinity }, { running: 2.5 }, 7, true];

test('fleet regression: no/null/garbage/below-warn fleet reproduces the pre-fleet snapshot (60 cases)', () => {
  assert.equal(grid.cases.length, 60);
  for (const c of grid.cases) {
    const i = gin(grid.inputs[c.input]);
    const cfg = gcfg({ mode: c.mode, lang: c.lang });
    const st = grid.states[c.state];
    assert.deepStrictEqual(decide(i, st, cfg, GNOW, noDef), c.expect);
    assert.deepStrictEqual(decide(i, st, cfg, GNOW, { ...noDef }), c.expect);
    assert.deepStrictEqual(decide(i, st, cfg, GNOW, { ...noDef, fleet: null }), c.expect);
    for (const g of GARBAGE) assert.deepStrictEqual(decide(i, st, cfg, GNOW, { ...noDef, fleet: g as never }), c.expect);
    for (const running of [0, 1, 2]) assert.deepStrictEqual(decide(i, st, cfg, GNOW, { ...noDef, fleet: { running, truncated: true } }), c.expect);
    for (const over of [{ fleet: false }, { fleetShowAt: 0 }]) {
      assert.deepStrictEqual(decide(i, st, gcfg({ mode: c.mode, lang: c.lang, ...over }), GNOW, { ...noDef, fleet: { running: 99 } }), c.expect);
    }
  }
});

test('fleet rows A..J pick the planned action/reason/model', () => {
  const S = grid.states;
  const r = (desc: string, st: unknown, running: number, over?: object) =>
    decide(gin(desc), st as never, gcfg(over), GNOW, { ...noDef, fleet: { running } });
  const arm = (d: ReturnType<typeof decide>) => [d.action, d.reason, d.model];
  assert.deepStrictEqual(arm(r('do the thing', S.stale, 3)), ['suggest', 'fleet_advise_nostate', undefined]);
  assert.deepStrictEqual(arm(r('do the thing', null, 3)), ['suggest', 'fleet_advise_nostate', undefined]);
  assert.deepStrictEqual(arm(r('collect logs', S.stale, 99)), ['suggest', 'fleet_advise_nostate', undefined]);
  assert.deepStrictEqual(arm(r('do the thing', S.green, 3)), ['suggest', 'fleet_advise_green', undefined]);
  assert.deepStrictEqual(arm(r('design review', S.yellow, 3)), ['suggest', 'judgment:design', undefined]);
  assert.deepStrictEqual(arm(r('collect logs', S.yellow, 3)), ['inject', 'fleet_yellow', 'haiku']);
  assert.deepStrictEqual(arm(r('do the thing', S.yellow, 3)), ['inject', 'fleet_yellow', 'sonnet']);
  assert.deepStrictEqual(arm(r('do the thing', S.yellow, 2)), ['pass', 'grade_yellow', undefined]);
  assert.deepStrictEqual(arm(r('security check', S.red, 99)), ['suggest', 'judgment:security', undefined]);
  assert.deepStrictEqual(arm(r('do the thing', S.red, 4)), ['inject', 'red_downgrade', 'sonnet']);
  assert.deepStrictEqual(arm(r('do the thing', S.red, 5)), ['inject', 'fleet_hard_downgrade', 'sonnet']);
  assert.deepStrictEqual(arm(r('do the thing', S.red, 5, { fleetModelFloor: 'haiku' })), ['inject', 'fleet_hard_downgrade', 'haiku']);
  assert.deepStrictEqual(arm(r('do the thing', S.red, 5, { mode: 'suggest' })), ['suggest', 'fleet_hard_downgrade', 'sonnet']);
  assert.deepStrictEqual(arm(r('collect logs', S.yellow, 3, { mode: 'suggest' })), ['suggest', 'fleet_yellow', 'haiku']);
  assert.deepStrictEqual(arm(r('do the thing', S.green, 3, { fleetAdvise: false })), ['pass', 'grade_green', undefined]);
  assert.deepStrictEqual(arm(r('do the thing', S.stale, 3, { fleetAdvise: false })), ['pass', 'stale_state', undefined]);
  assert.deepStrictEqual(arm(r('do the thing', S.yellow, 9, { fleetWarnAt: 0 })), ['pass', 'grade_yellow', undefined]);
  assert.ok(String(decide(gin('x'), S.yellow as never, gcfg(), GNOW, { ...noDef, fleet: { running: 3, truncated: true } }).message).includes('64'));
  for (const k of ['fleetAdvise', 'fleetInject', 'fleetSuggest', 'fleetSuffix', 'fleetTrunc'] as const) assert.equal(typeof T.ko[k], 'function');
  assert.deepStrictEqual(sanitizeFleet({ running: 1, models: { O: 1, S: 'x' }, items: [] }), { running: 1, models: { O: 1 } });
  assert.equal(fleetDist({ S: 1, O: 2 }), 'opus 2 · sonnet 1');
});

test('fleet parity: TS decide() equals scripts/agent-model.js decide() on every row and switch', () => {
  const fleets: unknown[] = [undefined, null, ...GARBAGE, { running: 0 }, { running: 2 }, { running: 3, models: { O: 2, S: 1 } },
    { running: 4 }, { running: 5, truncated: true }, { running: 99, models: { '?': 99 } }];
  const overs: object[] = [{}, { mode: 'suggest' }, { mode: 'off' }, { lang: 'en' }, { lang: 'ja' }, { fleetAdvise: false },
    { fleetWarnAt: 0 }, { fleetHardAt: 0 }, { fleetWarnAt: 5, fleetHardAt: 3 }, { fleetModelFloor: 'haiku' }, { fleetModelFloor: 'opus' },
    { fleet: false }, { fleetShowAt: 0 }];
  const inputs = [gin('collect logs'), gin('design review'), gin('do the thing'), gin('x', { model: 'opus' }), { tool_input: { subagent_type: 'fork' } }];
  let n = 0;
  for (const st of Object.values(grid.states)) for (const i of inputs) for (const f of fleets) for (const o of overs) {
    const cfg = gcfg(o);
    assert.deepStrictEqual(decide(i, st as never, cfg, GNOW, { ...noDef, fleet: f as never }),
      jsAm.decide(i, st, cfg, GNOW, { ...noDef, fleet: f }));
    n++;
  }
  assert.equal(n, 5 * 5 * 17 * 13);
});

// ---- 0.4.9-fleet W4b-1: explicit upper-tier model rows M..R (DESIGN-v2 §8.2, TEST-PLAN-v2 §W4b-1) ----
// Same cases as test/v13.test.js W4b-1 #1..#14 on the TS side, plus a TS/JS parity grid (#15). A missing
// explicitDowngrade is 'off' in decide(); the shipped 'suggest' default comes from config.default.json (W4b-3).
import { isUpperModel, descHash, hasKeepMarker, escalated, EXPLICIT_DEFAULTS } from './core/agent-model.ts';

const XS = { explicitDowngrade: 'suggest' };
const XI = { explicitDowngrade: 'inject' };
const xin = (model: string, description: string, extra?: object, top?: object) =>
  ({ session_id: 's1', tool_input: { subagent_type: 'general-purpose', description, model, ...(extra || {}) }, ...(top || {}) });
const xr = (model: string, desc: string, st: unknown, fleet: unknown, over?: object, o2?: object) =>
  decide(xin(model, desc), st as never, gcfg(over), GNOW, { ...noDef, fleet: fleet as never, ...(o2 || {}) });
const HAS = { action: 'pass', reason: 'has_model' };

test('W4b-1 regression rows M/N/O/P: has_model / no_state / stale_state exactly as before, never updatedInput', () => {
  const S = grid.states;
  const states = [S.red, S.yellow, S.green, S.stale, null];
  for (const over of [{ explicitDowngrade: 'off' }, {}]) for (const st of states) for (const m of ['opus', 'fable', 'sonnet', 'haiku'])
    for (const f of [null, { running: 3 }, { running: 5 }, { running: 0, sessions: 3 }]) assert.deepStrictEqual(xr(m, 'collect logs', st, f, over), HAS);
  for (const over of [XS, XI]) {
    for (const st of states) for (const m of ['sonnet', 'haiku', 'claude-sonnet-4-5']) assert.deepStrictEqual(xr(m, 'x', st, { running: 99, sessions: 9 }, over), HAS);
    assert.deepStrictEqual(xr('opus', 'collect logs', null, { running: 99, sessions: 9 }, over), { action: 'pass', reason: 'no_state' });
    assert.deepStrictEqual(xr('opus', 'collect logs', S.stale, { running: 99, sessions: 9 }, over), { action: 'pass', reason: 'stale_state' });
    assert.deepStrictEqual(xr('opus', 'x', S.green, { running: 99, sessions: 9 }, over), HAS);
    assert.deepStrictEqual(xr('opus', 'x', S.yellow, null, over), HAS);
    assert.deepStrictEqual(xr('opus', 'x', S.yellow, { running: 2, sessions: null }, over), HAS);
    assert.deepStrictEqual(xr('sonnet', 'x', S.red, { running: 9 }, over), HAS);
  }
  for (const tiers of [[], 'opus']) assert.deepStrictEqual(xr('opus', 'x', S.red, null, { ...XI, explicitDowngradeTiers: tiers }), HAS);
});

test('W4b-1 rows Q..R: keep_judgment > keep_marker > keep_escalation > explicit_downgrade/suggest', () => {
  const S = grid.states;
  const arm = (d: ReturnType<typeof decide>) => [d.action, d.reason, d.model];
  for (const m of ['opus', 'fable', 'claude-opus-4-7']) {
    const i = xin(m, 'collect logs', { prompt: 'p' });
    const d = decide(i, S.red, gcfg(XI), GNOW, noDef);
    assert.deepStrictEqual(arm(d), ['inject', 'explicit_downgrade', 'sonnet']);
    assert.equal(d.requested_model, m);
    assert.ok(String(d.message).includes(m) && String(d.message).includes("'keep-model'"));
    assert.deepStrictEqual((output(i, d) as any).hookSpecificOutput.updatedInput,
      { subagent_type: 'general-purpose', description: 'collect logs', model: 'sonnet', prompt: 'p' });
  }
  assert.deepStrictEqual(arm(xr('opus', 'collect logs', S.red, null, XS)), ['suggest', 'explicit_suggest', 'sonnet']);
  assert.deepStrictEqual(arm(xr('opus', 'x', S.yellow, { running: 3 }, XI)), ['inject', 'explicit_downgrade', 'sonnet']);
  assert.deepStrictEqual(arm(xr('opus', 'x', S.yellow, { running: 1, sessions: 3 }, XI)), ['inject', 'explicit_downgrade', 'sonnet']);
  assert.deepStrictEqual(xr('opus', 'x', S.yellow, { running: 1, sessions: 2 }, XI), HAS);
  const q = xr('opus', 'design review', S.red, null, XI);
  assert.deepStrictEqual([q.action, q.reason, q.message], ['pass', 'keep_judgment:design', undefined]);
  assert.ok(xr('opus', 'design review', S.red, null, { ...XI, explicitDowngradeVerbose: true }).message);
  assert.equal(xr('opus', 'design review keep-model', S.red, null, XI).reason, 'keep_judgment:design');
  assert.equal(xr('opus', 'collect logs keep-model', S.red, null, XI).reason, 'keep_marker');
  const p = (prompt: string) => decide(xin('opus', 'collect logs', { prompt }), S.red, gcfg(XI), GNOW, noDef).reason;
  assert.equal(p('x'.repeat(595) + '모델 유지'), 'keep_marker');
  assert.equal(p('x'.repeat(601) + '모델 유지'), 'explicit_downgrade');
  const h = descHash('collect logs') as string;
  const led = (ts: number, kind = 'agent', sid = 's1') => ({ [sid]: { [h]: { ts, requested: 'opus', kind } } });
  assert.equal(xr('opus', 'collect logs', S.red, null, XI, { ledger: led(GNOW - 600) }).reason, 'keep_escalation');
  assert.equal(xr('opus', 'collect logs', S.red, null, XI, { ledger: led(GNOW - 1801) }).reason, 'explicit_downgrade');
  assert.equal(xr('opus', 'collect logs', S.red, null, XI, { ledger: led(GNOW - 600, 'agent', 's2') }).reason, 'explicit_downgrade');
  assert.equal(xr('opus', 'collect logz', S.red, null, XI, { ledger: led(GNOW - 600) }).reason, 'explicit_downgrade');
  assert.equal(xr('opus', 'collect logs', S.red, null, XI, { ledger: led(GNOW - 600, 'session') }).reason, 'explicit_downgrade');
  assert.equal(descHash('Collect   LOGS'), descHash('collect logs'));
  assert.equal(descHash('  '), null);
  assert.equal(xr('opus', '', S.red, null, XI, { ledger: { s1: { '': { ts: GNOW } } } }).reason, 'explicit_downgrade');
  assert.equal(isUpperModel('claude-opus-4-7'), true);
  assert.equal(isUpperModel('opusplus'), false);
  assert.equal(hasKeepMarker('a keep-model b'), 'keep-model');
  assert.equal(escalated(null, 's1', 'agent', h, GNOW, 1800), false);
  assert.deepStrictEqual(EXPLICIT_DEFAULTS.explicitDowngradeTiers, ['opus', 'fable']);
});

test('W4b-1 #15 parity: TS decide() equals scripts/agent-model.js decide() on the explicit grid', () => {
  const h = descHash('collect logs') as string;
  const ledgers: unknown[] = [undefined, null, 'x', { s1: { [h]: { ts: GNOW - 600 } } }, { s1: { ['session:' + h]: { ts: GNOW - 60 } } },
    { s1: { [h]: { ts: GNOW - 1801 } } }, { s1: { [h]: { ts: GNOW - 600, kind: 'session' } } }];
  const fleets: unknown[] = [undefined, null, { running: 0 }, { running: 3 }, { running: 1, sessions: 3 }, { running: 1, sessions: 2 },
    { running: 5, truncated: true }, { running: 2, sessions: 5 }, { running: 1, sessions: -1 }];
  const overs: object[] = [{}, XS, XI, { ...XI, mode: 'suggest' }, { ...XI, lang: 'en' }, { ...XS, lang: 'ja' }, { ...XI, explicitDowngradeTiers: [] },
    { ...XI, explicitDowngradeTo: 'haiku' }, { ...XI, keepModelMarker: [] }, { ...XI, escalateWithinSec: 300 }, { ...XI, explicitDowngradeVerbose: true },
    { ...XI, fleetTotalWarnAt: 0 }, { explicitDowngrade: 'garbage' }];
  const inputs = [xin('opus', 'collect logs'), xin('fable', 'design review'), xin('claude-opus-4-7', 'collect logs keep-model'),
    xin('opus', 'do the thing', { prompt: 'x'.repeat(601) + '모델 유지' }), xin('sonnet', 'collect logs'), xin('opus', ''),
    xin('opus', 'collect logs', {}, { kind: 'session' }), gin('do the thing')];
  let n = 0;
  for (const st of Object.values(grid.states)) for (const i of inputs) for (const f of fleets) for (const o of overs) for (const l of ledgers) {
    const cfg = gcfg(o);
    assert.deepStrictEqual(decide(i, st as never, cfg, GNOW, { ...noDef, fleet: f as never, ledger: l as never }),
      jsAm.decide(i, st, cfg, GNOW, { ...noDef, fleet: f, ledger: l }));
    n++;
  }
  assert.equal(n, 5 * 8 * 9 * 13 * 7);
  for (const v of ['Collect  LOGS', '', '  ', 'x', undefined]) assert.equal(descHash(v), jsAm.descHash(v));
});

test('decide: agentModelDefault gives a model-less Agent call that model; the lower one wins against pressure; judgment words keep it off', () => {
  const g = decide({ tool_input: { prompt: 'implement it', description: 'impl' } }, greenState, { ...baseCfg, agentModelDefault: 'sonnet' }, NOW);
  assert.equal(g.action, 'inject'); assert.equal(g.reason, 'agent_default'); assert.equal(g.model, 'sonnet');
  const low = decide({ tool_input: { prompt: 'implement it', description: 'impl' } }, redState, { ...baseCfg, agentModelDefault: 'haiku' }, NOW);
  assert.equal(low.model, 'haiku');
  const same = decide({ tool_input: { prompt: 'implement it', description: 'impl' } }, redState, { ...baseCfg, agentModelDefault: 'sonnet' }, NOW);
  assert.equal(same.reason, 'red_downgrade');
  assert.notEqual(decide({ tool_input: { prompt: 'design the schema', description: 'x' } }, greenState, { ...baseCfg, agentModelDefault: 'sonnet' }, NOW).action, 'inject');
  assert.equal(decide({ tool_input: { prompt: 'x' }, kind: 'session' }, greenState, { ...baseCfg, agentModelDefault: 'sonnet' }, NOW).action, 'pass');
  assert.equal(decide({ tool_input: { prompt: 'x' } }, greenState, baseCfg, NOW).action, 'pass');
});

// ---- H2 mirror: start_session protection + session wording (scripts/agent-model.js adaptSession / T_SESSION) ----
import { adaptSession, sessionProtected, textsFor, T_SESSION, T as T_AGENT } from './core/agent-model.ts';
import { createRequire as h2Require } from 'node:module';
const amJs = h2Require(import.meta.url)('../scripts/agent-model.js');

test('H2 agent-model.ts adaptSession: protected sessions pass (Trading cwd, keyword, no cwd); ordinary ones adapt', () => {
  const mk = (ti: any, cwd = 'C:\Claude') => ({ tool_name: 'mcp__ccd_session__start_session', cwd, tool_input: ti });
  const prot = [mk({ cwd: 'C:\Trading', title: 'x', prompt: 'y' }), mk({ cwd: 'C:\Work', title: 'trade check', prompt: 'y' }),
    mk({ cwd: 'C:\Work', title: 'x', prompt: 'trade orders' }), mk({ title: 'x', prompt: 'y' }), mk({ cwd: '  ', title: 'x', prompt: 'y' }),
    mk({ cwd: 'C:\Work', title: 'x', prompt: 'y' }, 'C:\Trading\bot')];
  for (const i of prot) {
    assert.deepEqual(adaptSession(i, {}), { pass: 'protected' }, JSON.stringify(i));
    assert.deepEqual(amJs.adaptSession(i, {}), { pass: 'protected' }, 'js ' + JSON.stringify(i));
  }
  const ok = mk({ cwd: 'C:\Work\proj', title: 'collect logs', prompt: 'collect the build logs' });
  assert.equal(sessionProtected(ok, {}), false);
  assert.deepEqual(adaptSession(ok, {}), amJs.adaptSession(ok, {}));
  assert.equal(adaptSession(ok, {}).input!.kind, 'session');
  // a configured bot folder protects too (excludeCwd / managerExcludeCwd lists)
  assert.equal(sessionProtected(ok, { managerExcludeCwd: ['proj'] }), true);
});

test('H2 agent-model.ts session wording == JS, never "this subagent"; agent wording unchanged', () => {
  const args: [string, string, string, string] = ['7d', 'sonnet', 'red', '7d'];
  for (const lang of ['en', 'ko', 'ja']) {
    const ts: any = textsFor({ kind: 'session' }, lang);
    const js: any = amJs.textsFor({ kind: 'session' }, lang);
    for (const k of Object.keys(T_SESSION.en)) {
      assert.equal(ts[k](...args), js[k](...args), lang + ' ' + k);
      assert.ok(!/this subagent|description/.test(ts[k](...args)), lang + ' ' + k);
    }
    assert.equal((textsFor({}, lang) as any).inject('7d', 'sonnet'), (T_AGENT[lang] || T_AGENT.en).inject('7d', 'sonnet'));
  }
  assert.deepEqual(Object.keys(T_SESSION.ko).sort(), Object.keys(T_SESSION.en).sort());
});
