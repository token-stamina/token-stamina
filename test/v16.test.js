'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// W9-1e: local decision apply (scripts/decisions.js rules + scripts/board.js --apply / --record-apply). TEST-PLAN-v2 W9-1e.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Isolated data folder (never the real home), set before anything reads pace.home().
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-dec-'));
process.env.TOKEN_STAMINA_HOME = HOME;
const D = require('../scripts/decisions');
const board = require('../scripts/board');

const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'decisions', 'cases.json'), 'utf8'));
const T0 = FX.T0;
const NOW = T0 + 3600;
const iso = (s) => new Date(s * 1000).toISOString();
const rows = () => JSON.parse(JSON.stringify(FX.rows));
const cfg = (o) => Object.assign({}, FX.cfg, o || {});
const rowOf = (sid) => FX.rows.find((r) => r.sid === sid);
const freshBoard = (o) => Object.assign({ rows: rows(), now: NOW, stateStale: false, grade: 'red' }, o || {});
// Every fixture row mapped to an app session entry (W7 #4: only exactly mapped rows get applicable session cards).
const MAPPED = { mapped: FX.rows.map((r) => r.sid) };
// Local proposal copies (board/decisions.json "proposals") for a list of proposal docs.
const ledgerOf = (ps) => ({ rows: [], proposals: Object.fromEntries(ps.map((x) => [x.pid, x])) });
// An approved decision for a session_model proposal on sid (merged decision + proposal doc).
function smDecision(sid, over) {
  const r = rowOf(sid);
  const target = { sid }, params = { from: 'opus', to: 'sonnet' };
  return Object.assign({ pid: D.pidOf('session_model', target, params, r.last_user_ts), kind: 'session_model', target, params,
    basis: { measured_at: r.updated_at }, status: 'approved', decided_by: 'owner', decided_at: iso(NOW - 60) }, over || {});
}
const liveOf = (sid) => FX.live.find((l) => l.sessionId === sid);

// ---- 1. proposals ----
test('proposals: red owner-opus j=0 -> session_model card with E3/E1 basis, "환산" note, revert possible', () => {
  const ps = D.proposals(rows(), { grade: 'red', stale: false }, null, NOW, cfg(), MAPPED);
  const sm = ps.find((p) => p.kind === 'session_model' && p.target.sid === 'owner-opus');
  assert.ok(sm);
  assert.match(sm.pid, D.PID_RE);
  assert.deepEqual(sm.params, { from: 'opus', to: 'sonnet' });
  assert.equal(sm.basis.values.j, 0); assert.equal(sm.basis.values.in_med10, 40000); assert.match(sm.basis.metric, /E3/); assert.match(sm.basis.metric, /E1/);
  assert.equal(sm.est_saving.tokens, Math.round(40000 * 10 * (1 - 3 / 5)));
  assert.equal(sm.est_saving.window, '10_turns');
  assert.match(sm.est_saving.note, /환산/);
  assert.equal(sm.revert.possible, true);
  assert.equal(sm.advice_only, false); assert.equal(sm.status, 'proposed');
  assert.equal(sm.ttl_until, iso(Date.parse(rowOf('owner-opus').updated_at) / 1000 + 7200));
  for (const k of ['pid', 'kind', 'target', 'params', 'basis', 'est_saving', 'revert', 'protected', 'advice_only', 'status', 'ttl_until', 'created_at']) assert.ok(k in sm, k);
});

test('proposals: ctx450k -> session_clear revert impossible; trading -> advice_only; agent default card; none for sonnet row', () => {
  const ps = D.proposals(rows(), { grade: 'red' }, null, NOW, cfg());
  const sc = ps.find((p) => p.kind === 'session_clear');
  assert.equal(sc.target.sid, 'ctx450k'); assert.equal(sc.revert.possible, false); assert.equal(sc.est_saving.tokens, 4500000);
  const tr = ps.find((p) => p.target.sid === 'trading-opus');
  assert.equal(tr.advice_only, true); assert.equal(tr.protected, true);
  const am = ps.find((p) => p.kind === 'agent_default_model');
  assert.deepEqual(am.target, { scope: 'agents' }); assert.deepEqual(am.params, { from: null, to: 'sonnet' });
  assert.equal(am.basis.values.agent_tokens, 100000, 'protected trading row is not counted');
  assert.equal(am.est_saving.window, 'board_tail');
  assert.ok(!ps.some((p) => p.target.sid === 'sonnet'));
  assert.ok(!ps.some((p) => p.kind === 'fleet_threshold'), 'no peak given -> no fleet card');
  const ft = D.proposals(rows(), { grade: 'red' }, null, NOW, cfg(), { fleetPeak24h: 4 }).find((p) => p.kind === 'fleet_threshold');
  assert.deepEqual(ft.params, { fleetWarnAt: 2, fleetHardAt: 4 }); assert.equal(ft.est_saving.tokens, null);
});

test('proposals: green -> no model cards; stale account -> nothing; agentModelDefault already sonnet -> no agent card', () => {
  const g = D.proposals(rows(), { grade: 'green' }, null, NOW, cfg());
  assert.ok(!g.some((p) => p.kind === 'session_model' || p.kind === 'agent_default_model'));
  assert.ok(g.some((p) => p.kind === 'session_clear'));
  assert.deepEqual(D.proposals(rows(), { grade: 'red', stale: true }, null, NOW, cfg()), []);
  assert.ok(!D.proposals(rows(), { grade: 'red' }, null, NOW, cfg({ agentModelDefault: 'sonnet' })).some((p) => p.kind === 'agent_default_model'));
});

test('proposals: rejected (kind,target) within 24h -> no card; held within ttl -> no card; after -> back', () => {
  const key = D.targetKey('session_model', { sid: 'owner-opus' });
  const has = (led, now) => D.proposals(rows(), { grade: 'red' }, led, now, cfg()).some((p) => p.kind === 'session_model' && p.target.sid === 'owner-opus');
  assert.equal(has({ rows: [{ pid: 'sm-000000000000', key, status: 'rejected', decided_at: iso(NOW - 86399) }] }, NOW), false);
  assert.equal(has({ rows: [{ pid: 'sm-000000000000', key, status: 'rejected', decided_at: iso(NOW - 86400) }] }, NOW), true);
  assert.equal(has({ rows: [{ pid: 'sm-000000000000', key, status: 'held', decided_at: iso(NOW - 7199) }] }, NOW), false);
  assert.equal(has({ rows: [{ pid: 'sm-000000000000', key, status: 'held', decided_at: iso(NOW - 7200) }] }, NOW), true);
});

test('proposals: pid stable across runs while the session is idle, changes with a new prompt', () => {
  const a = D.proposals(rows(), { grade: 'red' }, null, NOW, cfg())[0].pid;
  const b = D.proposals(rows(), { grade: 'red' }, null, NOW + 900, cfg())[0].pid;
  assert.equal(a, b);
  const moved = rows(); moved[0].last_user_ts += 10;
  assert.notEqual(D.proposals(moved, { grade: 'red' }, null, NOW, cfg())[0].pid, a);
});

// ---- 2. validateDecision ----
test('validateDecision: approved + fresh + live model == from -> set_session_model op with code-built args', () => {
  const v = D.validateDecision(smDecision('owner-opus'), freshBoard(), cfg(), liveOf('owner-opus'));
  assert.equal(v.ok, true);
  assert.deepEqual(v.op, { tool: 'set_session_model', args: { session_id: 'owner-opus', model: 'sonnet' } });
});

test('validateDecision: protected / stale / expired / target_changed / unknown_target / live_unknown / self / manual', () => {
  const tr = smDecision('trading-opus');
  assert.deepEqual(D.validateDecision(tr, freshBoard(), cfg(), liveOf('trading-opus')), { ok: false, status: 'refused', reason: 'protected' });
  // Row flag off but cwd_tail matches the protect list -> still protected (shape + guard).
  const b2 = freshBoard(); b2.rows.find((r) => r.sid === 'trading-opus').protected = false;
  assert.equal(D.validateDecision(tr, b2, cfg(), liveOf('trading-opus')).reason, 'protected');
  // Live cwd under a protected folder protects a row whose tail does not.
  const b3 = freshBoard(); b3.rows[0].cwd_tail = 'x';
  assert.equal(D.validateDecision(smDecision('owner-opus'), b3, cfg(), { model: 'opus', cwd: 'C:\\Trading\\x' }).reason, 'protected');
  assert.equal(D.validateDecision(smDecision('owner-opus'), b3, cfg(), { model: 'opus', cwd: 'C:\\w\\trade-live' }).reason, 'protected');
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard({ stateStale: true }), cfg(), liveOf('owner-opus')).reason, 'stale_state');
  const old = smDecision('owner-opus', { basis: { measured_at: iso(NOW - 7201) } });
  assert.deepEqual(D.validateDecision(old, freshBoard(), cfg(), liveOf('owner-opus')), { ok: false, status: 'expired', reason: 'ttl' });
  assert.equal(D.validateDecision(smDecision('owner-opus', { basis: { measured_at: iso(NOW - 7200) } }), freshBoard(), cfg(), liveOf('owner-opus')).ok, true);
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard(), cfg(), { model: 'claude-haiku-4-5', cwd: 'C:\\Claude\\proj' }).reason, 'target_changed');
  const b4 = freshBoard(); b4.rows[0].model = 'claude-sonnet-4-6';
  assert.equal(D.validateDecision(smDecision('owner-opus'), b4, cfg(), liveOf('owner-opus')).reason, 'target_changed');
  assert.equal(D.validateDecision(smDecision('owner-opus', { target: { sid: 'ghost' } }), freshBoard(), cfg(), null).reason, 'unknown_target');
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard(), cfg(), null).reason, 'unmapped');
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard(), cfg(), { cwd: 'C:\\Claude\\proj' }).reason, 'live_unknown');
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard({ selfSid: 'owner-opus' }), cfg(), liveOf('owner-opus')).reason, 'self');
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard(), cfg({ applyMode: 'manual' }), liveOf('owner-opus')).reason, 'manual_mode');
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard(), cfg({ applyMode: 'auto' }), liveOf('owner-opus')).reason, 'manual_mode');
  // Live already at the target -> ok without an op (idempotent by observation).
  assert.deepEqual(D.validateDecision(smDecision('linked-opus'), freshBoard(), cfg(), liveOf('linked-opus')), { ok: true, already: true });
});

test('validateDecision: schema - kind outside enum, upgrade, strings with spaces / semicolons, extra params, bad pid', () => {
  const bad = (over) => D.validateDecision(smDecision('owner-opus', over), freshBoard(), cfg(), liveOf('owner-opus'));
  assert.equal(bad({ kind: 'effort' }).reason, 'schema');
  assert.equal(bad({ kind: 'rm -rf' }).reason, 'schema');
  assert.equal(bad({ params: { from: 'sonnet', to: 'opus' } }).reason, 'schema');
  assert.equal(bad({ params: { from: 'opus', to: 'opus' } }).reason, 'schema');
  assert.equal(bad({ params: { from: 'opus', to: 'sonnet; clear_session' } }).reason, 'schema');
  assert.equal(bad({ params: { from: 'opus', to: 'son net' } }).reason, 'schema');
  assert.equal(bad({ params: { from: 'opus', to: 'sonnet', model: 'x' } }).reason, 'schema');
  assert.equal(bad({ target: { sid: 'owner-opus; ls' } }).reason, 'schema');
  assert.equal(bad({ target: { sid: 'owner-opus', path: '/etc' } }).reason, 'schema');
  assert.equal(bad({ pid: '../x' }).reason, 'schema');
  assert.equal(bad({ pid: 'sc-0123456789ab' }).reason, 'schema', 'pid prefix must match kind');
  assert.equal(bad({ basis: {} }).reason, 'schema');
  assert.equal(bad({ status: 'held' }).reason, 'not_approved');
});

test('validateDecision: agent_default_model -> config only (no op), old spelling accepted; fleet_threshold via allow table', () => {
  const t = { scope: 'agents' }, p = { from: null, to: 'sonnet' };
  const d = { pid: D.pidOf('agent_default_model', t, p, 1), kind: 'agent_default_model', target: t, params: p, basis: { measured_at: iso(NOW - 60) }, status: 'approved' };
  assert.deepEqual(D.validateDecision(d, freshBoard(), cfg(), null), { ok: true, config: { agentModelDefault: 'sonnet' } });
  assert.deepEqual(D.validateDecision(Object.assign({}, d, { kind: 'agent_model_default' }), freshBoard(), cfg(), null).config, { agentModelDefault: 'sonnet' });
  assert.equal(D.validateDecision(Object.assign({}, d, { params: { from: null, to: 'opus' } }), freshBoard(), cfg(), null).reason, 'schema');
  assert.equal(D.validateDecision(d, freshBoard(), cfg({ agentModelDefault: 'haiku' }), null).reason, 'target_changed');
  const ft = { scope: 'fleet' }, fp = { fleetWarnAt: 2, fleetHardAt: 4 };
  const f = { pid: D.pidOf('fleet_threshold', ft, fp, 1), kind: 'fleet_threshold', target: ft, params: fp, basis: { measured_at: iso(NOW - 60) }, status: 'approved' };
  assert.deepEqual(D.validateDecision(f, freshBoard(), cfg(), null).config, { fleetWarnAt: 2, fleetHardAt: 4 });
  assert.equal(D.validateDecision(Object.assign({}, f, { params: { fleetWarnAt: 5, fleetHardAt: 4 } }), freshBoard(), cfg(), null).reason, 'schema');
  assert.equal(D.validateDecision(Object.assign({}, f, { params: { fleetWarnAt: 0, fleetHardAt: 4 } }), freshBoard(), cfg(), null).reason, 'schema');
});

// ---- 2b/3/4. planApply ----
test('planApply: idempotent applied skip, 4th approval deferred(max_per_run), held/rejected noted', () => {
  const ds = ['owner-opus', 'linked-opus'].map((s) => smDecision(s));
  const t = { scope: 'agents' }, p = { from: null, to: 'sonnet' };
  ds.push({ pid: D.pidOf('agent_default_model', t, p, 1), kind: 'agent_default_model', target: t, params: p, basis: { measured_at: iso(NOW - 60) }, status: 'approved', decided_at: iso(NOW - 30) });
  const ft = { scope: 'fleet' }, fp = { fleetWarnAt: 2, fleetHardAt: 4 };
  ds.push({ pid: D.pidOf('fleet_threshold', ft, fp, 1), kind: 'fleet_threshold', target: ft, params: fp, basis: { measured_at: iso(NOW - 60) }, status: 'approved', decided_at: iso(NOW - 10) });
  const r = D.planApply(ds, freshBoard(), cfg(), FX.live, null);
  assert.deepEqual(r.results.map((x) => x.status), ['issued', 'applied', 'applied', 'deferred']);
  assert.equal(r.results[3].reason, 'max_per_run');
  assert.equal(r.ops.length, 1);
  assert.deepEqual(r.config, { agentModelDefault: 'sonnet' });
  const led = D.mergeLedger(null, r.ledgerRows, NOW);
  const again = D.planApply(ds, freshBoard(), cfg(), FX.live, led);
  assert.deepEqual(again.results.slice(0, 3).map((x) => x.reason), ['idempotent', 'idempotent', 'idempotent']);
  assert.equal(again.ops.length, 0);
  assert.equal(again.results[3].status, 'applied', 'the deferred one goes next run');
  const notes = D.planApply([smDecision('owner-opus', { status: 'held' }), smDecision('linked-opus', { status: 'rejected' })], freshBoard(), cfg(), FX.live, null);
  assert.deepEqual(notes.ledgerRows.map((x) => x.status), ['held', 'rejected']);
  assert.ok(notes.ledgerRows.every((x) => x.key && x.key.startsWith('session_model|')));
});

test('session_clear approved -> offer_clear button only, never an op, never clear_session', () => {
  const t = { sid: 'ctx450k' };
  const d = { pid: D.pidOf('session_clear', t, {}, rowOf('ctx450k').last_user_ts), kind: 'session_clear', target: t, params: {}, basis: { measured_at: rowOf('ctx450k').updated_at }, status: 'approved' };
  const r = D.planApply([d], freshBoard(), cfg(), FX.live, null);
  assert.deepEqual(r.ops, []);
  assert.deepEqual(r.buttons, [{ pid: d.pid, kind: 'offer_clear', sid: 'ctx450k', button_only: true }]);
  assert.ok(!JSON.stringify(r).includes('clear_session'));
});

test('applyMode manual -> ops [] for every approval', () => {
  const r = D.planApply([smDecision('owner-opus')], freshBoard(), cfg({ applyMode: 'manual' }), FX.live, null);
  assert.deepEqual(r.ops, []); assert.equal(r.results[0].reason, 'manual_mode');
  const r2 = D.planApply([smDecision('owner-opus')], freshBoard(), cfg({ applyMode: undefined }), FX.live, null);
  assert.deepEqual(r2.ops, [], 'default mode is manual');
});

// ---- 5. validateSettings ----
test('validateSettings: normal request -> all accepted', () => {
  const v = D.validateSettings(FX.settings.ok, cfg());
  assert.deepEqual(v.rejected, {});
  assert.deepEqual(Object.keys(v.accepted).sort(), Object.keys(FX.settings.ok.values).sort());
});

test('validateSettings: order / range / type / enum / locked / autoScope / not_allowed', () => {
  const rj = (values, c) => D.validateSettings({ values }, cfg(c)).rejected;
  assert.equal(rj({ fleetHardAt: 2 }).fleetHardAt.reason, 'order');
  const both = rj({ fleetWarnAt: 6, fleetHardAt: 5 });
  assert.equal(both.fleetWarnAt.reason, 'order'); assert.equal(both.fleetHardAt.reason, 'order');
  assert.equal(rj({ fleetWarnAt: 0 }).fleetWarnAt.reason, 'range');
  assert.equal(rj({ fleetWarnAt: 51 }).fleetWarnAt.reason, 'range');
  assert.equal(rj({ fleetWarnAt: 2.5 }).fleetWarnAt.reason, 'range');
  assert.equal(rj({ fleetWarnAt: '3' }).fleetWarnAt.reason, 'type');
  assert.equal(rj({ fleetTotalHardAt: 3 }).fleetTotalHardAt.reason, 'order');
  assert.equal(rj({ fleetModelFloor: 'opus' }).fleetModelFloor.reason, 'enum');
  assert.equal(rj({ agentModelDefault: 'fable' }).agentModelDefault.reason, 'enum');
  const auto = D.validateSettings({ values: { applyMode: 'auto' } }, cfg());
  assert.equal(auto.rejected.applyMode.reason, 'locked'); assert.equal(auto.accepted.applyMode, 'approve');
  assert.equal(rj({ applyMode: 'yolo' }).applyMode.reason, 'enum');
  assert.equal(rj({ autoScope: ['session_clear'] }).autoScope.reason, 'enum');
  assert.deepEqual(D.validateSettings({ values: { autoScope: ['agent_model_default'] } }, cfg()).accepted.autoScope, ['agent_default_model']);
  assert.equal(rj({ dashboardMaskTitles: 'yes' }).dashboardMaskTitles.reason, 'type');
  assert.equal(rj({ foo: 1 }).foo.reason, 'not_allowed');
  assert.equal(rj({ excludeCwd: [] }).excludeCwd.reason, 'not_allowed');
  assert.equal(rj({ managerExcludeCwd: [] }).managerExcludeCwd.reason, 'not_allowed');
  const proto = D.validateSettings(JSON.parse('{"values":{"__proto__":{"applyMode":"approve"}}}'), cfg());
  assert.equal(proto.rejected.__proto__.reason, 'not_allowed');
  assert.equal(Object.getPrototypeOf(proto.accepted), Object.prototype);
  assert.equal(proto.accepted.applyMode, undefined);
});

test('validateSettings fixtures bad / unknown', () => {
  const b = D.validateSettings(FX.settings.bad, cfg());
  assert.deepEqual(Object.fromEntries(Object.entries(b.rejected).map(([k, v]) => [k, v.reason])),
    { fleetWarnAt: 'range', fleetHardAt: 'range', applyMode: 'locked', sessionRules: 'not_allowed' });
  assert.deepEqual(b.accepted, { applyMode: 'approve' });
  const u = D.validateSettings(FX.settings.unknown, cfg());
  assert.deepEqual(u.accepted, {});
  assert.deepEqual(Object.keys(u.rejected).sort(), ['excludeCwd', 'foo']);
});

// ---- 6. applyConfig ----
test('applyConfig: only allowed keys change, other keys byte-identical', () => {
  const user = { lang: 'ko', compactWindowTokens: 400000, excludeCwd: ['mybot_work'], sessionRules: { old: 'exclude' } };
  const out = D.applyConfig(user, { fleetWarnAt: 4, sessionRules: { proj: 'pin' }, excludeCwd: [], foo: 1 });
  assert.deepEqual(out, { lang: 'ko', compactWindowTokens: 400000, excludeCwd: ['mybot_work'], sessionRules: { old: 'exclude' }, fleetWarnAt: 4 });
  const { fleetWarnAt, ...rest } = out; void fleetWarnAt;
  assert.equal(JSON.stringify(rest), JSON.stringify(user));
});

test('W7 #7: sessionRules (exclude/pin, read by no code) is rejected not_allowed, never shown as applied', () => {
  const v = D.validateSettings({ values: { sessionRules: { otherbot_work: 'exclude' }, fleetWarnAt: 4 } }, cfg());
  assert.equal(v.rejected.sessionRules.reason, 'not_allowed');
  assert.equal('sessionRules' in v.accepted, false);
  assert.deepEqual(v.accepted, { fleetWarnAt: 4 });
});

test('W7 #5: the agent default card names the window it was measured on (board tails), not 24h', () => {
  const am = D.proposals(rows(), { grade: 'red' }, null, NOW, cfg()).find((p) => p.kind === 'agent_default_model');
  assert.equal(am.est_saving.window, 'board_tail');
  assert.ok(!JSON.stringify(am).includes('24h'));
});

test('W7 #4: no exact app-session mapping -> session cards advice_only + unmapped; agent card unaffected', () => {
  const ps = D.proposals(rows(), { grade: 'red' }, null, NOW, cfg());
  const sess = ps.filter((p) => p.target && p.target.sid);
  assert.ok(sess.length >= 2);
  assert.ok(sess.every((p) => p.advice_only === true && p.unmapped === true));
  const am = ps.find((p) => p.kind === 'agent_default_model');
  assert.equal(am.advice_only, false); assert.equal('unmapped' in am, false);
  const some = D.proposals(rows(), { grade: 'red' }, null, NOW, cfg(), { mapped: ['owner-opus'] });
  assert.equal(some.find((p) => p.kind === 'session_model' && p.target.sid === 'owner-opus').advice_only, false);
  assert.equal(some.find((p) => p.kind === 'session_model' && p.target.sid === 'linked-opus').unmapped, true);
});

test('W7 #4: mappedIds maps only on an exact id field; an app id (local_...) or same cwd/time never maps a transcript uuid', () => {
  const rs = [{ sid: '0b6c1f3e-1111-4222-8333-944455556666' }, { sid: 'owner-opus' }];
  const appOnly = [{ sessionId: 'local_d9eb22d0', cwd: 'C:\\Claude\\proj', createdAt: '2026-10-28T00:00:00Z', title: 'x' }];
  assert.deepEqual(D.mappedIds(appOnly, rs), []);
  assert.deepEqual(D.mappedIds([{ sessionId: 'owner-opus', title: 't' }], rs), ['owner-opus']);
  assert.deepEqual(D.mappedIds({ sessions: [{ sessionId: '0B6C1F3E-1111-4222-8333-944455556666' }] }, rs), [], 'no case folding either');
  assert.deepEqual(D.mappedIds({ sessions: [{ sessionId: 'owner-opus' }] }, rs), ['owner-opus'], 'list_sessions wrapper shape');
  assert.deepEqual(D.mappedIds({ 'owner-opus': 'my title' }, rs), [], 'a hand-built id->title map is not a mapping');
  // unmapped rows: apply refused(unmapped) whatever the page says
  assert.equal(D.validateDecision(smDecision('owner-opus', { unmapped: true }), freshBoard(), cfg(), liveOf('owner-opus')).reason, 'unmapped');
  const r = D.planApply([smDecision('owner-opus')], freshBoard(), cfg(), [{ sessionId: 'local_x', model: 'claude-opus-4-7', cwd: 'C:\\Claude\\proj' }], null);
  assert.deepEqual(r.ops, []); assert.equal(r.results[0].reason, 'unmapped');
});

test('W7 R2 3b: a live entry with neither title nor folder counts as protected (no op)', () => {
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard(), cfg(), { model: 'claude-opus-4-7' }).reason, 'protected');
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard(), cfg(), 'claude-opus-4-7').reason, 'protected');
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard(), cfg(), { model: 'claude-opus-4-7', title: 'notes' }).ok, true);
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard(), cfg(), { model: 'claude-opus-4-7', title: 'live trading' }).reason, 'protected');
});

test('W7 R2: apply re-checks the grade now and the judgment exception now', () => {
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard({ grade: 'green' }), cfg(), liveOf('owner-opus')).reason, 'grade_changed');
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard({ grade: null }), cfg(), liveOf('owner-opus')).reason, 'grade_changed');
  assert.equal(D.validateDecision(smDecision('owner-opus'), freshBoard({ grade: 'yellow' }), cfg(), liveOf('owner-opus')).ok, true);
  const bj = freshBoard(); bj.rows.find((r) => r.sid === 'owner-opus').j = 2;
  assert.equal(D.validateDecision(smDecision('owner-opus'), bj, cfg(), liveOf('owner-opus')).reason, 'judgment');
  const ft = { scope: 'fleet' }, fp = { fleetWarnAt: 2, fleetHardAt: 4 };
  const f = { pid: D.pidOf('fleet_threshold', ft, fp, 1), kind: 'fleet_threshold', target: ft, params: fp, basis: { measured_at: iso(NOW - 60) }, status: 'approved' };
  assert.equal(D.validateDecision(f, freshBoard({ grade: 'yellow' }), cfg(), null).reason, 'grade_changed');
});

test('W7 R2: at most one item per sid per run (second one deferred one_per_sid)', () => {
  const a = smDecision('owner-opus');
  const b = smDecision('owner-opus', { pid: D.pidOf('session_model', { sid: 'owner-opus' }, { from: 'opus', to: 'sonnet' }, 1) });
  const r = D.planApply([a, b], freshBoard(), cfg(), FX.live, null);
  assert.deepEqual(r.results.map((x) => [x.status, x.reason || null]), [['issued', null], ['deferred', 'one_per_sid']]);
  assert.equal(r.ops.length, 1);
});

test('W7 R2: decision doc content is ignored (local copy wins); a pid with no local copy is refused unknown_proposal', () => {
  const now = NOW;
  const state = { seven_day: { pct: 80, resets_at: now + 3.5 * 86400 }, five_hour: { pct: 5, resets_at: now + 3600 }, recorded_at: now - 60 };
  const own = smDecision('owner-opus');
  const forged = { doc_id: own.pid, data: { status: 'approved', kind: 'session_model', target: { sid: 'linked-opus' }, params: { from: 'opus', to: 'haiku' }, basis: { measured_at: iso(now) }, protected: false } };
  const ghost = { doc_id: 'sm-0123456789ab', data: { status: 'approved', kind: 'session_model', target: { sid: 'owner-opus' }, params: { from: 'opus', to: 'sonnet' }, basis: { measured_at: iso(now) } } };
  const r = board.applyPayload({ now, cfg: cfg(), userCfg: {}, state, rows: rows(), ledger: ledgerOf([own]),
    decisions: [forged, ghost], proposals: [Object.assign({}, own, { params: { from: 'opus', to: 'haiku' } })], settings: null, live: FX.live, host: 'h' });
  assert.equal(r.out.ops.length, 1);
  assert.deepEqual(r.out.ops[0].args, { session_id: 'owner-opus', model: 'sonnet' });
  assert.deepEqual(r.out.results[1], { pid: 'sm-0123456789ab', status: 'refused', reason: 'unknown_proposal' });
  assert.deepEqual(D.mergeDocs([{ doc_id: own.pid, data: { status: 'yolo', decided_by: 'x'.repeat(200) } }], [own])[0].status, null);
  assert.equal(D.mergeDocs([{ doc_id: own.pid, data: { status: 'approved', decided_by: 'x'.repeat(200) } }], [own])[0].decided_by.length, 80);
});

test('W7 R2: a settings flip manual -> approve in the same run applies from the next run only', () => {
  const now = NOW;
  const state = { seven_day: { pct: 80, resets_at: now + 3.5 * 86400 }, five_hour: { pct: 5, resets_at: now + 3600 }, recorded_at: now - 60 };
  const own = smDecision('owner-opus');
  const io = { now, cfg: cfg({ applyMode: 'manual' }), userCfg: { applyMode: 'manual' }, state, rows: rows(), ledger: ledgerOf([own]),
    decisions: [{ doc_id: own.pid, data: { status: 'approved' } }], settings: { values: { applyMode: 'approve' } }, live: FX.live, host: 'h' };
  const r = board.applyPayload(io);
  assert.deepEqual(r.out.ops, []); assert.equal(r.out.results[0].reason, 'manual_mode');
  assert.equal(r.out.apply_mode, 'manual'); assert.equal(r.out.apply_mode_next, 'approve');
  assert.equal(r.newUser.applyMode, 'approve');
  const next = board.applyPayload(Object.assign({}, io, { cfg: cfg({ applyMode: 'approve' }), userCfg: r.newUser, settings: null }));
  assert.equal(next.out.ops.length, 1);
});

// ---- 7 + I/O: applyPayload / CLI in an isolated home ----
function mkHome(userCfg, state) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-apply-'));
  fs.mkdirSync(path.join(h, 'board'));
  for (const r of FX.rows) fs.writeFileSync(path.join(h, 'board', r.sid + '.json'), JSON.stringify(Object.assign({}, r, { updated_at: new Date().toISOString() })));
  if (userCfg) fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(userCfg));
  if (state) fs.writeFileSync(path.join(h, 'state.json'), JSON.stringify(state));
  return h;
}
function cli(h, args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'board.js'), ...args], { env: Object.assign({}, process.env, { TOKEN_STAMINA_HOME: h }), encoding: 'utf8' });
  return JSON.parse(r.stdout);
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)).map((x) => e.name + '/' + x) : [e.name])).sort();

test('applyPayload: batch shape - decisions/<pid> updates with applied_by sync@host and settings/applied snapshot', () => {
  const now = NOW;
  const state = { seven_day: { pct: 80, resets_at: now + 3.5 * 86400 }, five_hour: { pct: 5, resets_at: now + 3600 }, recorded_at: now - 60 };
  const t = { scope: 'agents' }, p = { from: null, to: 'sonnet' };
  const am = { pid: D.pidOf('agent_default_model', t, p, 1), kind: 'agent_default_model', target: t, params: p, basis: { measured_at: iso(now - 60) }, status: 'approved' };
  // agentModelDefault left out: setting it in the same run would make the approval target_changed (checked below).
  const noAgent = { values: Object.assign({}, FX.settings.ok.values, { agentModelDefault: undefined }), requested_by: 'owner' };
  delete noAgent.values.agentModelDefault;
  const r = board.applyPayload({ now, cfg: cfg(), userCfg: { lang: 'ko' }, state, rows: rows(), ledger: ledgerOf([smDecision('trading-opus'), am]),
    decisions: [{ doc_id: smDecision('trading-opus').pid, data: { status: 'approved', decided_by: 'owner', decided_at: iso(now - 30) } }, { doc_id: am.pid, data: { status: 'approved', decided_at: iso(now - 20) } }],
    proposals: [smDecision('trading-opus'), am], settings: noAgent, live: FX.live, host: 'MY PC.local' });
  const shape = r.batch.writes.map((w) => `${w.op}:${w.collection}/${w.doc_id}:${w.data.status || ''}`);
  assert.deepEqual(shape, [`update:decisions/${smDecision('trading-opus').pid}:refused`, `update:decisions/${am.pid}:applied`, 'set:settings/applied:']);
  const dw = r.batch.writes[1].data;
  assert.equal(dw.applied_by, 'sync'); assert.equal(dw.applied_at, iso(now));
  assert.equal(r.batch.writes[0].data.reason, 'protected');
  const sa = r.batch.writes[2].data;
  assert.deepEqual(Object.keys(sa).sort(), ['accepted', 'applied_at', 'config_hash', 'rejected', 'requested_by']);
  assert.equal(sa.accepted.applyMode, 'approve'); assert.match(sa.config_hash, /^[0-9a-f]{16}$/);
  assert.equal(r.newUser.agentModelDefault, 'sonnet');
  assert.equal(r.newUser.fleetWarnAt, 4);
});

test('applyPayload: no settings request -> settings/applied not written; manual mode -> ops []', () => {
  const now = NOW;
  const state = { seven_day: { pct: 80, resets_at: now + 3.5 * 86400 }, recorded_at: now - 60 };
  const r = board.applyPayload({ now, cfg: cfg({ applyMode: 'manual' }), userCfg: {}, state, rows: rows(), ledger: null,
    decisions: [smDecision('owner-opus')], proposals: null, settings: null, live: FX.live, host: 'h' });
  assert.deepEqual(r.out.ops, []); assert.equal(r.out.settings_applied, null); assert.equal(r.configChanged, false);
  assert.ok(!r.batch.writes.some((w) => w.collection === 'settings'));
});

test('CLI --apply in an isolated home: writes only config.json / config.prev.json / board/decisions.json (+events), never the real home', () => {
  const realCfg = path.join(os.homedir(), '.claude', 'token-stamina', 'config.json');
  const realBefore = fs.existsSync(realCfg) ? fs.readFileSync(realCfg) : null;
  const now = Math.floor(Date.now() / 1000);
  const user = { lang: 'ko', applyMode: 'approve', managerExcludeCwd: ['Trading'], keep: { a: 1 } };
  const h = mkHome(user, { seven_day: { pct: 80, resets_at: now + 3.5 * 86400 }, five_hour: { pct: 5, resets_at: now + 3600 }, recorded_at: now - 60 });
  const dec = path.join(os.tmpdir(), 'ts-dec-in-' + process.pid + '.json');
  const ds = [smDecision('owner-opus', { basis: { measured_at: iso(now - 60) }, decided_at: iso(now - 50) })];
  fs.writeFileSync(path.join(h, 'board', 'decisions.json'), JSON.stringify(ledgerOf(ds)));
  const before = walk(h);
  fs.writeFileSync(dec, JSON.stringify(ds));
  const out = cli(h, ['--apply', '--decisions', dec, '--settings', JSON.stringify(FX.settings.ok), '--live', JSON.stringify(FX.live)]);
  assert.equal(out.ops.length, 1); assert.equal(out.ops[0].tool, 'set_session_model'); assert.equal(out.ops[0].pid, ds[0].pid);
  assert.equal(out.config_written, true);
  const added = walk(h).filter((f) => !before.includes(f));
  assert.deepEqual(added.sort(), ['config.prev.json', 'events.jsonl']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, 'config.prev.json'), 'utf8')), user);
  const nc = JSON.parse(fs.readFileSync(path.join(h, 'config.json'), 'utf8'));
  assert.deepEqual(nc.keep, { a: 1 }); assert.equal(nc.fleetWarnAt, 4); assert.deepEqual(nc.managerExcludeCwd, ['Trading']);
  // pending approval (issued, not yet applied) is visible to W9-1b's --rows rule
  const led = JSON.parse(fs.readFileSync(path.join(h, 'board', 'decisions.json'), 'utf8'));
  assert.equal(led.rows.filter((x) => x.status === 'approved' && !x.applied_at).length, 1);
  // --record-apply turns it into applied; unknown pids ignored; second --apply skips (idempotent).
  const rec = cli(h, ['--record-apply', '--results', JSON.stringify([{ pid: ds[0].pid, ok: true }, { pid: 'sm-ffffffffffff', ok: true }])]);
  assert.deepEqual(rec.results.map((x) => x.status), ['applied', 'skip']);
  assert.equal(rec.batch.writes[0].data.status, 'applied'); assert.equal(rec.batch.writes[0].data.applied_by, 'sync');
  const again = cli(h, ['--apply', '--decisions', dec, '--live', JSON.stringify(FX.live)]);
  assert.deepEqual(again.ops, []); assert.equal(again.results[0].reason, 'idempotent');
  const ev = fs.readFileSync(path.join(h, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ev.map((e) => e.event), ['decision_apply', 'decision_record', 'decision_apply']);
  fs.unlinkSync(dec);
  const realAfter = fs.existsSync(realCfg) ? fs.readFileSync(realCfg) : null;
  assert.ok(realBefore === null ? realAfter === null : realBefore.equals(realAfter), 'real home config untouched');
});

test('CLI --apply: stale state.json -> no downgrade op, refused(stale_state)', () => {
  const now = Math.floor(Date.now() / 1000);
  const h = mkHome({ applyMode: 'approve' }, { seven_day: { pct: 80, resets_at: now + 3.5 * 86400 }, recorded_at: now - 7 * 3600 });
  const ds = [smDecision('owner-opus', { basis: { measured_at: iso(now - 60) } })];
  fs.writeFileSync(path.join(h, 'board', 'decisions.json'), JSON.stringify(ledgerOf(ds)));
  const out = cli(h, ['--apply', '--decisions', JSON.stringify(ds), '--live', JSON.stringify(FX.live)]);
  assert.deepEqual(out.ops, []); assert.equal(out.results[0].reason, 'stale_state'); assert.equal(out.state_stale, true);
  assert.ok(!fs.existsSync(path.join(h, 'config.json')) || JSON.parse(fs.readFileSync(path.join(h, 'config.json'), 'utf8')).applyMode === 'approve');
  assert.ok(!fs.existsSync(path.join(h, 'config.prev.json')));
});

test('rows: red board -> proposal docs in the push batch, content remembered in the local ledger', () => {
  const now = Math.floor(Date.now() / 1000);
  const h = mkHome({ lang: 'ko', managerExcludeCwd: ['Trading'] }, { seven_day: { pct: 80, resets_at: now + 3.5 * 86400 }, five_hour: { pct: 5, resets_at: now + 3600 }, recorded_at: now - 60 });
  const titles = path.join(h, 'titles.json');
  fs.writeFileSync(titles, JSON.stringify(FX.rows.map((r) => ({ sessionId: r.sid, title: 't-' + r.cwd_tail, cwd: 'C:\\Claude\\' + r.cwd_tail }))));
  const out = cli(h, ['--rows', '--titles', titles]);
  assert.equal(out.skip, false);
  const pw = out.writes.filter((w) => w.collection === 'proposals');
  assert.ok(pw.length >= 3 && pw.length === out.proposals);
  const doc = JSON.parse(fs.readFileSync(pw[0].file_path, 'utf8'));
  for (const k of ['pid', 'kind', 'target', 'params', 'basis', 'est_saving', 'revert', 'protected', 'advice_only', 'status', 'ttl_until', 'created_at']) assert.ok(k in doc, k);
  const led = JSON.parse(fs.readFileSync(path.join(h, 'board', 'decisions.json'), 'utf8'));
  assert.equal(Object.keys(led.proposals).length, pw.length);
  // A page copy with forged params loses to the local copy.
  const pid = pw.find((w) => JSON.parse(fs.readFileSync(w.file_path, 'utf8')).kind === 'session_model' && !JSON.parse(fs.readFileSync(w.file_path, 'utf8')).protected).doc_id;
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ lang: 'ko', managerExcludeCwd: ['Trading'], applyMode: 'approve' }));
  const sid = led.proposals[pid].target.sid;
  const forged = [{ pid, kind: 'session_model', target: { sid }, params: { from: 'opus', to: 'haiku' }, basis: { measured_at: new Date().toISOString() } }];
  const ap = cli(h, ['--apply', '--decisions', JSON.stringify([{ doc_id: pid, data: { status: 'approved' } }]), '--proposals', JSON.stringify(forged), '--live', JSON.stringify([{ sessionId: sid, model: 'claude-opus-4-7', cwd: 'C:\\Claude\\proj' }])]);
  assert.equal(ap.ops.length, 1); assert.equal(ap.ops[0].args.model, 'sonnet');
});

test('W7 #5/#7 dashboard: no sessionRules field in the settings form, every window code has a label, every refusal reason has a label', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.ok(!html.includes('sessionRules'), 'settings panel does not offer a rule nothing reads');
  for (const w of ['10_turns', 'board_tail']) assert.ok(html.includes('"' + w + '":'), w);
  assert.ok(!html.includes('24시간 환산'));
  for (const r of ['unmapped', 'unknown_proposal', 'grade_changed', 'judgment', 'one_per_sid', 'protected', 'stale_state']) assert.ok(new RegExp('[{,]' + r + ':"').test(html), r);
});

test('M1 validateDecision: a basis measured_at more than 120 s ahead (clock went back) expires, never lives forever', () => {
  const t = { scope: 'agents' }, p = { from: null, to: 'sonnet' };
  const mk = (at) => ({ pid: D.pidOf('agent_default_model', t, p, 1), kind: 'agent_default_model', target: t, params: p, basis: { measured_at: iso(at) }, status: 'approved' });
  assert.equal(D.validateDecision(mk(NOW + 86400), freshBoard(), cfg(), null).reason, 'ttl');
  assert.equal(D.validateDecision(mk(NOW + 100), freshBoard(), cfg(), null).ok, true);
});
