'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// 0.4.9-fleet W4: decide() fleet rows (DESIGN-v2 §5.3, TEST-PLAN-v2 §W4 + common 1/2/4).
// The legacy grid fixture is a snapshot of decide() taken before the fleet rows existed; with no usable fleet input
// the new decide() must reproduce it bit for bit.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const am = require('../scripts/agent-model.js');
const grid = require('./fixtures/agent-model/legacy-grid.json');

const NOW = grid.now;
const noDef = { definitionHasModel: () => false };
const inp = (description, extra) => ({ tool_input: Object.assign({ subagent_type: 'general-purpose', description }, extra || {}) });
const cfgOf = (over) => Object.assign({}, grid.cfg, { mode: 'inject', lang: 'ko' }, over || {});
const S = grid.states;
const run = (desc, state, fleet, over) => am.decide(inp(desc), state, cfgOf(over), NOW, Object.assign({}, noDef, { fleet }));
const GARBAGE = ['3', { running: 'x' }, { running: -1 }, { running: NaN }, [], { running: Infinity }, { running: 2.5 }, 7, true];

test('common 1: no/null/garbage fleet reproduces the pre-fleet snapshot (60 cases x 12 variants)', () => {
  assert.equal(grid.cases.length, 60);
  for (const c of grid.cases) {
    const i = inp(grid.inputs[c.input]);
    const cfg = cfgOf({ mode: c.mode, lang: c.lang });
    const st = S[c.state];
    assert.deepStrictEqual(am.decide(i, st, cfg, NOW, noDef), c.expect);
    assert.deepStrictEqual(am.decide(i, st, cfg, NOW, Object.assign({}, noDef)), c.expect);
    assert.deepStrictEqual(am.decide(i, st, cfg, NOW, Object.assign({ fleet: null }, noDef)), c.expect);
    for (const g of GARBAGE) assert.deepStrictEqual(am.decide(i, st, cfg, NOW, Object.assign({ fleet: g }, noDef)), c.expect, JSON.stringify(g));
  }
});

test('common 1b: a valid fleet below fleetWarnAt (and below fleetHardAt on red) is also bit-identical', () => {
  for (const c of grid.cases) {
    for (const running of [0, 1, 2]) {
      const d = am.decide(inp(grid.inputs[c.input]), S[c.state], cfgOf({ mode: c.mode, lang: c.lang }), NOW,
        Object.assign({ fleet: { running, models: { O: running }, truncated: true } }, noDef));
      assert.deepStrictEqual(d, c.expect);
    }
  }
});

test('common: the four front pass branches ignore even a huge fleet', () => {
  const fleet = { running: 99, models: { O: 99 } };
  assert.deepStrictEqual(am.decide(inp('x'), S.red, cfgOf({ mode: 'off' }), NOW, { fleet }), { action: 'pass', reason: 'mode_off' });
  assert.deepStrictEqual(am.decide(inp('x', { model: 'opus' }), S.red, cfgOf(), NOW, { fleet }), { action: 'pass', reason: 'has_model' });
  assert.deepStrictEqual(am.decide({ tool_input: { subagent_type: 'fork' } }, S.red, cfgOf(), NOW, { fleet }), { action: 'pass', reason: 'fork' });
  assert.deepStrictEqual(am.decide(inp('x'), S.red, cfgOf(), NOW, { fleet, definitionHasModel: () => true }), { action: 'pass', reason: 'definition_model' });
});

test('common 2: stale 94% never injects, whatever the fleet size (row A is advice only)', () => {
  for (const running of [3, 5, 99]) for (const mode of ['inject', 'suggest']) for (const desc of ['collect logs', 'do the thing', 'design review']) {
    const d = run(desc, S.stale, { running }, { mode });
    assert.equal(d.action, 'suggest');
    assert.equal(d.reason, 'fleet_advise_nostate');
    assert.equal(d.model, undefined);
  }
});

test('common 4: fleet:false / fleetShowAt:0 behave as if no fleet were passed; mode off passes', () => {
  for (const c of grid.cases) {
    for (const over of [{ fleet: false }, { fleetShowAt: 0 }]) {
      const d = am.decide(inp(grid.inputs[c.input]), S[c.state], cfgOf(Object.assign({ mode: c.mode, lang: c.lang }, over)), NOW,
        Object.assign({ fleet: { running: 99 } }, noDef));
      assert.deepStrictEqual(d, c.expect);
    }
  }
});

test('W4-1 row A: stale/no_state with 3 running -> suggest fleet_advise_nostate, no model, mentions 3', () => {
  for (const st of [S.stale, null]) {
    const d = run('do the thing', st, { running: 3, models: { O: 2, S: 1 } });
    assert.equal(d.action, 'suggest');
    assert.equal(d.reason, 'fleet_advise_nostate');
    assert.equal(d.model, undefined);
    assert.equal(d.fleet_running, 3);
    assert.ok(d.message.includes('3개'), d.message);
    assert.ok(d.message.includes('opus 2 · sonnet 1'), d.message);
  }
  assert.ok(run('x', S.stale, { running: 3 }).message.includes('오래돼서'));
  assert.ok(run('x', null, { running: 3 }).message.includes('없어서'));
});

test('W4-2 row C: green with 3 running -> suggest fleet_advise_green (judgment word or not)', () => {
  for (const desc of ['do the thing', 'design review', 'collect logs']) {
    const d = run(desc, S.green, { running: 3 });
    assert.equal(d.action, 'suggest');
    assert.equal(d.reason, 'fleet_advise_green');
    assert.equal(d.model, undefined);
    assert.equal(d.grade, 'green');
  }
});

test('W4-3 row G: yellow with 3 running -> inject fleet_yellow (collect -> haiku, else sonnet); 2 running -> pass', () => {
  const c = run('collect logs', S.yellow, { running: 3 });
  assert.deepStrictEqual([c.action, c.reason, c.model], ['inject', 'fleet_yellow', 'haiku']);
  assert.ok(c.message.includes('노랑') && c.message.includes('3개') && c.message.includes('model="haiku"'), c.message);
  const t = run('do the thing', S.yellow, { running: 3 });
  assert.deepStrictEqual([t.action, t.reason, t.model], ['inject', 'fleet_yellow', 'sonnet']);
  assert.deepStrictEqual(run('do the thing', S.yellow, { running: 2 }), { action: 'pass', reason: 'grade_yellow' });
  const out = am.output(inp('do the thing'), t);
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'sonnet');
});

test('W4-4 row F: yellow with 3 running and a judgment word -> suggest judgment:design + fleet suffix', () => {
  const d = run('design review', S.yellow, { running: 3 });
  assert.deepStrictEqual([d.action, d.reason, d.model], ['suggest', 'judgment:design', undefined]);
  assert.ok(d.message.endsWith(' 지금 하위 에이전트 3개가 동시에 실행 중이에요.'), d.message);
  assert.ok(d.message.includes('노랑') && !d.message.includes('빨강'), d.message);
});

test('W4-5 row J: red with 5 running -> fleet_hard_downgrade at fleetModelFloor; 4 running -> red_downgrade', () => {
  const d = run('do the thing', S.red, { running: 5 });
  assert.deepStrictEqual([d.action, d.reason, d.model], ['inject', 'fleet_hard_downgrade', 'sonnet']);
  assert.equal(run('do the thing', S.red, { running: 5 }, { fleetModelFloor: 'haiku' }).model, 'haiku');
  assert.equal(run('do the thing', S.red, { running: 5 }, { fleetModelFloor: 'opus' }).model, 'sonnet');
  assert.equal(run('do the thing', S.red, { running: 5 }, { fleetModelFloor: 42 }).model, 'sonnet');
  assert.equal(run('collect logs', S.red, { running: 5 }).model, 'haiku');
  const i = run('do the thing', S.red, { running: 4 });
  assert.deepStrictEqual(i, run('do the thing', S.red, null)); // row I = the old result, message included
  assert.equal(i.reason, 'red_downgrade');
});

test('W4-6 row H: red with 99 running and a judgment word -> suggest judgment:security, never a model', () => {
  // The keyword list is scanned in its own order and 'audit' precedes 'security' in the default list, so the
  // plan's 'security audit' reports judgment:audit; 'security check' gives the plan's judgment:security.
  const d = run('security audit', S.red, { running: 99 });
  assert.deepStrictEqual([d.action, d.reason, d.model], ['suggest', 'judgment:audit', undefined]);
  const sec = run('security check', S.red, { running: 99 });
  assert.deepStrictEqual([sec.action, sec.reason, sec.model], ['suggest', 'judgment:security', undefined]);
  assert.ok(sec.message.includes('99개'));
  const below = run('security check', S.red, { running: 2 });
  assert.deepStrictEqual(below, run('security check', S.red, null));
});

test('W4-7 fleetAdvise:false -> rows A and C pass as before', () => {
  assert.deepStrictEqual(run('x', S.stale, { running: 9 }, { fleetAdvise: false }), { action: 'pass', reason: 'stale_state' });
  assert.deepStrictEqual(run('x', null, { running: 9 }, { fleetAdvise: false }), { action: 'pass', reason: 'no_state' });
  assert.deepStrictEqual(run('x', S.green, { running: 9 }, { fleetAdvise: false }), { action: 'pass', reason: 'grade_green' });
  assert.equal(run('x', S.yellow, { running: 9 }, { fleetAdvise: false }).reason, 'fleet_yellow'); // G is not advice
});

test('W4-8 mode suggest -> G and J become suggest with the same model', () => {
  for (const [st, n, reason] of [[S.yellow, 3, 'fleet_yellow'], [S.red, 5, 'fleet_hard_downgrade']]) {
    for (const desc of ['collect logs', 'do the thing']) {
      const inj = run(desc, st, { running: n });
      const sug = run(desc, st, { running: n }, { mode: 'suggest' });
      assert.deepStrictEqual([sug.action, sug.reason, sug.model], ['suggest', reason, inj.model]);
      assert.ok(sug.message.includes('고려하세요'), sug.message);
      assert.equal(am.output(inp(desc), sug).hookSpecificOutput.updatedInput, undefined);
    }
  }
});

test('W4-9 truncated -> fleet messages mention 64', () => {
  for (const [st, desc, n] of [[S.stale, 'x', 3], [S.green, 'x', 3], [S.yellow, 'x', 3], [S.yellow, 'design', 3], [S.red, 'x', 5], [S.red, 'design', 3]]) {
    const d = run(desc, st, { running: n, truncated: true });
    assert.ok(d.message.includes('64'), d.message);
    assert.ok(!run(desc, st, { running: n }).message.includes('64'));
  }
});

test('W4-10 fleetWarnAt:0 (or garbage) switches rows A/C/F/G off; fleetHardAt:0 switches J off', () => {
  for (const w of [0, -1, '3', NaN]) {
    assert.deepStrictEqual(run('x', S.green, { running: 9 }, { fleetWarnAt: w }), { action: 'pass', reason: 'grade_green' });
    assert.deepStrictEqual(run('x', S.yellow, { running: 9 }, { fleetWarnAt: w }), { action: 'pass', reason: 'grade_yellow' });
    assert.deepStrictEqual(run('x', S.stale, { running: 9 }, { fleetWarnAt: w }), { action: 'pass', reason: 'stale_state' });
  }
  assert.equal(run('x', S.red, { running: 9 }, { fleetHardAt: 0 }).reason, 'red_downgrade');
  assert.equal(run('x', S.yellow, { running: 4 }, { fleetWarnAt: 5 }).reason, 'grade_yellow');
  assert.equal(run('x', S.red, { running: 6 }, { fleetHardAt: 7 }).reason, 'red_downgrade');
});

test('W4-11 message tables: ko has every fleet entry, unknown languages fall back to en', () => {
  for (const k of ['fleetAdvise', 'fleetInject', 'fleetSuggest', 'fleetSuffix', 'fleetTrunc']) {
    assert.equal(typeof am.T.ko[k], 'function', k);
    assert.equal(typeof am.T.en[k], 'function', k);
  }
  const ja = run('do the thing', S.yellow, { running: 3 }, { lang: 'ja' });
  assert.equal(ja.message, run('do the thing', S.yellow, { running: 3 }, { lang: 'en' }).message);
  assert.ok(ja.message.startsWith('Token Stamina: usage is slightly over pace (7d yellow) and 3 subagents'), ja.message);
});

test('sanitizeFleet keeps only a well-formed shape', () => {
  assert.deepStrictEqual(am.sanitizeFleet({ running: 3, models: { O: 2, S: 'x', H: -1, F: 1 }, truncated: true, items: [1] }),
    { running: 3, models: { O: 2, F: 1 }, truncated: true });
  assert.deepStrictEqual(am.sanitizeFleet({ running: 0, truncated: 'yes' }), { running: 0 });
  for (const g of GARBAGE.concat([null, undefined, {}])) assert.equal(am.sanitizeFleet(g), null);
  assert.equal(am.fleetDist({ S: 1, O: 2, '?': 1, H: 0 }), 'opus 2 · unspecified 1 · sonnet 1');
  assert.equal(am.fleetDist(undefined), '');
  assert.equal(path.basename(require.resolve('../scripts/agent-model.js')), 'agent-model.js');
});

// ---- 0.4.9-fleet W4b-1: explicit upper-tier model rows M..R (DESIGN-v2 §8.2, TEST-PLAN-v2 §W4b-1) ----
// The shipped default explicitDowngrade:'suggest' lives in config.default.json (W4b-3); decide() reads a missing key as
// 'off', so XS below spells out the "default cfg" of the plan.
const XS = { explicitDowngrade: 'suggest' };
const XI = { explicitDowngrade: 'inject' };
const xin = (model, description, extra, top) => Object.assign({ session_id: 's1',
  tool_input: Object.assign({ subagent_type: 'general-purpose', description, model }, extra || {}) }, top || {});
const xr = (model, desc, state, fleet, over, o2) => am.decide(xin(model, desc), state, cfgOf(over), NOW,
  Object.assign({}, noDef, { fleet }, o2 || {}));
const STATES = [S.red, S.yellow, S.green, S.stale, null];
const HAS = { action: 'pass', reason: 'has_model' };

test('W4b-1 #1 row N: explicitDowngrade off (or missing) -> has_model for every state, model and fleet', () => {
  for (const over of [{ explicitDowngrade: 'off' }, {}, { explicitDowngrade: null }]) for (const st of STATES)
    for (const m of ['opus', 'fable', 'sonnet', 'haiku'])
      for (const f of [null, { running: 3 }, { running: 5 }, { running: 0, sessions: 3 }]) {
        assert.deepStrictEqual(xr(m, 'collect logs', st, f, over), HAS);
      }
});

test('W4b-1 #2 row M: sonnet / haiku / claude-sonnet-4-5 are never upper tier', () => {
  for (const over of [XS, XI]) for (const st of STATES) for (const m of ['sonnet', 'haiku', 'claude-sonnet-4-5', 'claude-haiku-4-5'])
    for (const f of [null, { running: 99, sessions: 9 }]) assert.deepStrictEqual(xr(m, 'do the thing', st, f, over), HAS);
});

test('W4b-1 #3 row O: no_state / stale keep the requested model, no updatedInput, no fleet advice', () => {
  for (const over of [XS, XI]) {
    assert.deepStrictEqual(xr('opus', 'collect logs', null, null, over), { action: 'pass', reason: 'no_state' });
    assert.deepStrictEqual(xr('opus', 'collect logs', null, { running: 99, sessions: 9 }, over), { action: 'pass', reason: 'no_state' });
    const d = xr('opus', 'collect logs', S.stale, { running: 99, sessions: 9 }, over);
    assert.deepStrictEqual(d, { action: 'pass', reason: 'stale_state' });
    assert.equal(am.output(xin('opus', 'collect logs'), d), null);
  }
});

test('W4b-1 #4 row P: no pressure -> has_model, no updatedInput', () => {
  for (const over of [XS, XI]) {
    assert.deepStrictEqual(xr('opus', 'do the thing', S.green, { running: 99, sessions: 9 }, over), HAS);
    assert.deepStrictEqual(xr('opus', 'do the thing', S.yellow, null, over), HAS);
    assert.deepStrictEqual(xr('opus', 'do the thing', S.yellow, { running: 2, sessions: null }, over), HAS);
    assert.deepStrictEqual(xr('opus', 'do the thing', S.yellow, { running: 2 }, over), HAS);
  }
});

test('W4b-1 #5 row R inject: opus/fable/claude-opus-4-7 x red -> explicit_downgrade sonnet, other keys kept', () => {
  for (const m of ['opus', 'fable', 'claude-opus-4-7', 'Opus']) {
    const i = xin(m, 'collect logs', { prompt: 'p', run_in_background: true });
    const d = am.decide(i, S.red, cfgOf(XI), NOW, noDef);
    assert.deepStrictEqual([d.action, d.reason, d.model, d.requested_model], ['inject', 'explicit_downgrade', 'sonnet', m]);
    assert.equal(d.desc_hash, am.descHash('collect logs'));
    assert.ok(d.message.includes(m) && d.message.includes("'keep-model'") && d.message.includes('빨강'), d.message);
    const out = am.output(i, d).hookSpecificOutput.updatedInput;
    assert.deepStrictEqual(out, { subagent_type: 'general-purpose', description: 'collect logs', model: 'sonnet', prompt: 'p', run_in_background: true });
  }
  // simple words do not push an explicit request to haiku (one step only)
  assert.equal(xr('opus', 'collect logs', S.red, null, XI).model, 'sonnet');
  // global mode suggest caps explicit inject
  assert.equal(xr('opus', 'x', S.red, null, Object.assign({ mode: 'suggest' }, XI)).reason, 'explicit_suggest');
  assert.ok(xr('opus', 'x', S.red, null, Object.assign({ lang: 'en' }, XI)).message.startsWith('Token Stamina: usage is running fast (7d red)'));
});

test('W4b-1 #6 row R suggest (shipped default): explicit_suggest, no updatedInput', () => {
  for (const over of [XS, { explicitDowngrade: 'garbage' }]) {
    const d = xr('opus', 'collect logs', S.red, null, over);
    assert.deepStrictEqual([d.action, d.reason, d.model, d.requested_model], ['suggest', 'explicit_suggest', 'sonnet', 'opus']);
    assert.ok(d.message.includes('opus') && d.message.includes('고려하세요'), d.message);
    assert.equal(am.output(xin('opus', 'collect logs'), d).hookSpecificOutput.updatedInput, undefined);
  }
});

test('W4b-1 #7 yellow + fleet: running 3 -> inject; running 1 + sessions 3 -> inject; running 1 + sessions 2 -> pass', () => {
  const a = xr('opus', 'do the thing', S.yellow, { running: 3 }, XI);
  assert.deepStrictEqual([a.action, a.reason, a.fleet_running], ['inject', 'explicit_downgrade', 3]);
  assert.ok(a.message.includes('노랑') && a.message.includes('에이전트 3개'), a.message);
  const b = xr('opus', 'do the thing', S.yellow, { running: 1, sessions: 3 }, XI);
  assert.deepStrictEqual([b.action, b.reason], ['inject', 'explicit_downgrade']);
  assert.ok(b.message.includes('동시 세션 3') && b.message.includes('에이전트 1개'), b.message);
  assert.deepStrictEqual(xr('opus', 'do the thing', S.yellow, { running: 1, sessions: 2 }, XI), HAS);
  assert.deepStrictEqual(xr('opus', 'do the thing', S.yellow, { running: 1, sessions: 3 }, Object.assign({ fleetTotalWarnAt: 0 }, XI)), HAS);
});

test('W4b-1 #8 row Q: judgment word under pressure -> keep_judgment, silent unless verbose', () => {
  for (const over of [XS, XI]) {
    const d = xr('opus', 'design review', S.red, { running: 9 }, over);
    assert.deepStrictEqual([d.action, d.reason, d.model, d.message], ['pass', 'keep_judgment:design', undefined, undefined]);
    assert.equal(d.requested_model, 'opus');
    const v = xr('opus', 'design review', S.red, null, Object.assign({ explicitDowngradeVerbose: true }, over));
    assert.equal(v.reason, 'keep_judgment:design');
    assert.ok(typeof v.message === 'string' && !v.message.includes('\n') && v.message.includes('opus'), v.message);
    // W4b-3: a pass that carries a message is shown as additionalContext only (never updatedInput)
    assert.deepStrictEqual(am.output(xin('opus', 'design review'), v), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: v.message } });
  }
});

test("W4b-1 #9 row Q': keep-model marker in description or prompt head (600) -> keep_marker; past 600 -> R", () => {
  const d = xr('opus', 'collect logs keep-model', S.red, null, XI);
  assert.deepStrictEqual([d.action, d.reason, d.message], ['pass', 'keep_marker', undefined]);
  const p = (prompt) => am.decide(xin('opus', 'collect logs', { prompt }), S.red, cfgOf(XI), NOW, noDef);
  assert.equal(p('모델 유지 해 주세요').reason, 'keep_marker');
  assert.equal(p('x'.repeat(595) + '모델 유지').reason, 'keep_marker'); // ends at 600
  assert.equal(p('x'.repeat(601) + '모델 유지').reason, 'explicit_downgrade');
  assert.equal(xr('opus', 'collect logs KEEP-MODEL', S.red, null, XI).reason, 'keep_marker');
  assert.equal(xr('opus', 'collect logs keep-model', S.red, null, Object.assign({ keepModelMarker: [] }, XI)).reason, 'explicit_downgrade');
});

test("W4b-1 #10 row Q'': same session + same desc_hash downgraded within escalateWithinSec -> keep_escalation", () => {
  const h = am.descHash('collect logs');
  const led = (ts, kind, sid) => ({ [sid || 's1']: { [h]: { ts, requested: 'opus', kind: kind || 'agent' } } });
  const e = xr('opus', 'collect logs', S.red, null, XI, { ledger: led(NOW - 600) });
  assert.deepStrictEqual([e.action, e.reason, e.model], ['pass', 'keep_escalation', undefined]);
  assert.ok(e.message.includes('opus') && !e.message.includes('\n'), e.message);
  assert.equal(xr('opus', 'collect logs', S.red, null, XI, { ledger: led(NOW - 1800) }).reason, 'keep_escalation');
  assert.equal(xr('opus', 'collect logs', S.red, null, XI, { ledger: led(NOW - 1801) }).reason, 'explicit_downgrade');
  assert.equal(xr('opus', 'collect logs', S.red, null, XI, { ledger: led(NOW - 600, 'agent', 's2') }).reason, 'explicit_downgrade');
  assert.equal(xr('opus', 'collect logz', S.red, null, XI, { ledger: led(NOW - 600) }).reason, 'explicit_downgrade');
  assert.equal(xr('opus', 'collect logs', S.red, null, XI, { ledger: led(NOW - 600, 'session') }).reason, 'explicit_downgrade');
  // kind-prefixed key (W4b-3 ledger shape) for a start_session call
  const sess = am.decide(xin('opus', 'collect logs', {}, { kind: 'session' }), S.red, cfgOf(XI), NOW,
    Object.assign({ ledger: { s1: { ['session:' + h]: { ts: NOW - 60 } } } }, noDef));
  assert.equal(sess.reason, 'keep_escalation');
  assert.equal(xr('opus', 'collect logs', S.red, null, XI, { ledger: { s1: { ['session:' + h]: { ts: NOW - 60 } } } }).reason, 'explicit_downgrade');
  assert.equal(xr('opus', 'collect logs', S.red, null, Object.assign({ escalateWithinSec: 300 }, XI), { ledger: led(NOW - 600) }).reason, 'explicit_downgrade');
  for (const bad of [null, 'x', [], { s1: 'x' }, { s1: { [h]: { ts: 'x' } } }, { s1: { [h]: { ts: NOW + 60 } } }]) {
    assert.equal(xr('opus', 'collect logs', S.red, null, XI, { ledger: bad }).reason, 'explicit_downgrade', JSON.stringify(bad));
  }
  assert.equal(am.decide({ tool_input: { model: 'opus', description: 'collect logs' } }, S.red, cfgOf(XI), NOW,
    Object.assign({ ledger: led(NOW - 600) }, noDef)).reason, 'explicit_downgrade'); // no session id
});

test('W4b-1 #11 descHash: case and whitespace runs collapse; empty -> no hash, never escalates', () => {
  assert.equal(am.descHash('Collect   LOGS\n now'), am.descHash('collect logs now'));
  assert.match(am.descHash('collect logs'), /^[0-9a-f]{16}$/);
  assert.notEqual(am.descHash('collect logs'), am.descHash('collect log'));
  for (const v of ['', '   ', undefined, null, 3]) assert.equal(am.descHash(v), null);
  const d = xr('opus', '', S.red, null, XI, { ledger: { s1: { '': { ts: NOW } } } });
  assert.equal(d.reason, 'explicit_downgrade');
  assert.equal(d.desc_hash, undefined);
});

test('W4b-1 #12 an explicit sonnet is never lowered to haiku, even red with 9 running', () => {
  for (const over of [XS, XI]) assert.deepStrictEqual(xr('sonnet', 'collect logs', S.red, { running: 9, sessions: 9 }, over), HAS);
});

test('W4b-1 #13 explicitDowngradeTiers:[] (or garbage) -> every model is row M', () => {
  for (const tiers of [[], 'opus', {}]) for (const m of ['opus', 'fable', 'claude-opus-4-7']) {
    assert.deepStrictEqual(xr(m, 'collect logs', S.red, { running: 9 }, Object.assign({ explicitDowngradeTiers: tiers }, XI)), HAS);
  }
  assert.equal(xr('sonnet', 'x', S.red, null, Object.assign({ explicitDowngradeTiers: ['sonnet'] }, XI)).reason, 'explicit_downgrade');
  assert.equal(am.isUpperModel('opusplus'), false);
  assert.equal(am.isUpperModel('claude-fable-1'), true);
});

test('W4b-1 #14 priority: judgment word beats keep marker and escalation; explicitDowngradeTo garbage/upper -> sonnet', () => {
  assert.equal(xr('opus', 'design review keep-model', S.red, null, XI).reason, 'keep_judgment:design');
  const h = am.descHash('design review');
  assert.equal(xr('opus', 'design review', S.red, null, XI, { ledger: { s1: { [h]: { ts: NOW } } } }).reason, 'keep_judgment:design');
  assert.equal(xr('opus', 'x', S.red, null, Object.assign({ explicitDowngradeTo: 'haiku' }, XI)).model, 'haiku');
  for (const to of ['opus', 'fable', 42]) assert.equal(xr('opus', 'x', S.red, null, Object.assign({ explicitDowngradeTo: to }, XI)).model, 'sonnet');
});

test('W4b-1 sessions in the W4 rows: total pressure only when sessions is known', () => {
  // {running:3, sessions:undefined} is the same as {running:3}
  for (const st of STATES) for (const d of ['collect logs', 'design review', 'do the thing']) {
    assert.deepStrictEqual(run(d, st, { running: 3, sessions: undefined }), run(d, st, { running: 3 }));
    assert.deepStrictEqual(run(d, st, { running: 1, sessions: null }), run(d, st, { running: 1 }));
  }
  const g = run('do the thing', S.yellow, { running: 1, sessions: 3 });
  assert.deepStrictEqual([g.action, g.reason, g.model], ['inject', 'fleet_yellow', 'sonnet']);
  assert.ok(g.message.includes('다른 대화형 세션 3개'), g.message);
  assert.deepStrictEqual(run('do the thing', S.yellow, { running: 1, sessions: 2 }), { action: 'pass', reason: 'grade_yellow' });
  assert.equal(run('do the thing', S.red, { running: 2, sessions: 5 }).reason, 'fleet_hard_downgrade');
  assert.equal(run('do the thing', S.red, { running: 2, sessions: 4 }).reason, 'red_downgrade');
  assert.equal(run('do the thing', S.red, { running: 2, sessions: 5 }, { fleetTotalHardAt: 0 }).reason, 'red_downgrade');
  assert.deepStrictEqual(am.sanitizeFleet({ running: 1, sessions: 2 }), { running: 1, sessions: 2 });
  for (const bad of [-1, 2.5, '2', null, NaN]) assert.deepStrictEqual(am.sanitizeFleet({ running: 1, sessions: bad }), { running: 1 });
});
