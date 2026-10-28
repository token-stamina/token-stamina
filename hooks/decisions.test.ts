// TS mirror of the pure part of test/v16.test.js (scripts/decisions.js), same fixtures.
import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposals, validateDecision, validateSettings, applyConfig, planApply, pidOf, PID_RE, mergeLedger, recordResults, batchFor, mergeDocs, mappedIds } from './core/decisions.ts';

const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'decisions', 'cases.json'), 'utf8'));
const NOW = FX.T0 + 3600;
const iso = (s: number) => new Date(s * 1000).toISOString();
const rows = () => JSON.parse(JSON.stringify(FX.rows));
const cfg = (o?: any) => ({ ...FX.cfg, ...(o || {}) });
const rowOf = (sid: string) => FX.rows.find((r: any) => r.sid === sid);
const board = (o?: any) => ({ rows: rows(), now: NOW, stateStale: false, grade: 'red', ...(o || {}) });
const live = (sid: string) => FX.live.find((l: any) => l.sessionId === sid);
function sm(sid: string, over?: any) {
  const target = { sid }, params = { from: 'opus', to: 'sonnet' };
  return { pid: pidOf('session_model', target, params, rowOf(sid).last_user_ts), kind: 'session_model', target, params,
    basis: { measured_at: rowOf(sid).updated_at }, status: 'approved', decided_at: iso(NOW - 60), ...(over || {}) };
}

test('decisions.ts proposals: kinds, advice_only, revert, ledger cooldown', () => {
  const ps = proposals(rows(), { grade: 'red' }, null, NOW, cfg());
  const own = ps.find((p: any) => p.kind === 'session_model' && p.target.sid === 'owner-opus');
  assert.match(own.pid, PID_RE); assert.equal(own.revert.possible, true); assert.match(own.est_saving.note, /환산/);
  assert.equal(ps.find((p: any) => p.kind === 'session_clear').revert.possible, false);
  assert.equal(ps.find((p: any) => p.target.sid === 'trading-opus').advice_only, true);
  assert.ok(ps.some((p: any) => p.kind === 'agent_default_model'));
  const key = 'session_model|owner-opus';
  const cool = proposals(rows(), { grade: 'red' }, { rows: [{ pid: 'sm-000000000000', key, status: 'rejected', decided_at: iso(NOW - 100) }] }, NOW, cfg());
  assert.ok(!cool.some((p: any) => p.kind === 'session_model' && p.target.sid === 'owner-opus'));
});

test('decisions.ts validateDecision: ok / protected / stale / expired / target_changed / unknown / schema', () => {
  assert.deepEqual(validateDecision(sm('owner-opus'), board(), cfg(), live('owner-opus')).op, { tool: 'set_session_model', args: { session_id: 'owner-opus', model: 'sonnet' } });
  assert.equal(validateDecision(sm('trading-opus'), board(), cfg(), live('trading-opus')).reason, 'protected');
  assert.equal(validateDecision(sm('owner-opus'), board({ stateStale: true }), cfg(), live('owner-opus')).reason, 'stale_state');
  assert.equal(validateDecision(sm('owner-opus', { basis: { measured_at: iso(NOW - 7201) } }), board(), cfg(), live('owner-opus')).status, 'expired');
  assert.equal(validateDecision(sm('owner-opus'), board(), cfg(), { model: 'claude-haiku-4-5', cwd: 'C:\\Claude\\proj' }).reason, 'target_changed');
  assert.equal(validateDecision(sm('owner-opus', { target: { sid: 'ghost' } }), board(), cfg(), null).reason, 'unknown_target');
  assert.equal(validateDecision(sm('owner-opus', { kind: 'effort' }), board(), cfg(), null).reason, 'schema');
  assert.equal(validateDecision(sm('owner-opus', { params: { from: 'sonnet', to: 'opus' } }), board(), cfg(), null).reason, 'schema');
  assert.equal(validateDecision(sm('owner-opus', { params: { from: 'opus', to: 'sonnet;x' } }), board(), cfg(), null).reason, 'schema');
  assert.equal(validateDecision(sm('owner-opus'), board(), cfg({ applyMode: 'manual' }), live('owner-opus')).reason, 'manual_mode');
});

test('decisions.ts planApply: clear is a button only, max_per_run, idempotent', () => {
  const t = { sid: 'ctx450k' };
  const c = { pid: pidOf('session_clear', t, {}, rowOf('ctx450k').last_user_ts), kind: 'session_clear', target: t, params: {}, basis: { measured_at: rowOf('ctx450k').updated_at }, status: 'approved' };
  const r = planApply([c], board(), cfg(), FX.live, null);
  assert.deepEqual(r.ops, []); assert.equal(r.buttons[0].kind, 'offer_clear'); assert.ok(!JSON.stringify(r).includes('clear_session'));
  const four = planApply([sm('owner-opus'), c, sm('linked-opus'), sm('owner-opus', { pid: 'sm-aaaaaaaaaaaa', decided_at: iso(NOW) })], board(), cfg(), FX.live, null);
  assert.equal(four.results[3].reason, 'max_per_run');
  const led = mergeLedger(null, four.ledgerRows, NOW);
  assert.equal(planApply([sm('owner-opus')], board(), cfg(), FX.live, led).results[0].reason, 'idempotent');
  const rec = recordResults(led, [{ pid: sm('owner-opus').pid, ok: false, reason: 'rm -rf' }], NOW);
  assert.deepEqual(rec.results, [{ pid: sm('owner-opus').pid, status: 'failed', reason: 'unexpected_tool_result' }]);
  assert.equal(batchFor(rec.ledgerRows, null, 'h').writes[0].data.applied_by, 'sync');
});

test('decisions.ts validateSettings / applyConfig: allow table', () => {
  assert.deepEqual(validateSettings(FX.settings.ok, cfg()).rejected, {});
  const b = validateSettings(FX.settings.bad, cfg());
  assert.equal(b.rejected.applyMode.reason, 'locked'); assert.equal(b.accepted.applyMode, 'approve');
  assert.equal(b.rejected.sessionRules.reason, 'not_allowed'); assert.equal(b.rejected.fleetWarnAt.reason, 'range');
  assert.equal(validateSettings({ values: { fleetHardAt: 2 } }, cfg()).rejected.fleetHardAt.reason, 'order');
  assert.equal(validateSettings({ values: { fleetWarnAt: '3' } }, cfg()).rejected.fleetWarnAt.reason, 'type');
  assert.equal(validateSettings({ values: { autoScope: ['session_clear'] } }, cfg()).rejected.autoScope.reason, 'enum');
  assert.equal(validateSettings(FX.settings.unknown, cfg()).rejected.excludeCwd.reason, 'not_allowed');
  assert.deepEqual(applyConfig({ a: 1, sessionRules: { x: 'exclude' } }, { fleetWarnAt: 4, sessionRules: { y: 'pin' }, foo: 2 }),
    { a: 1, sessionRules: { x: 'exclude' }, fleetWarnAt: 4 });
});

test('decisions.ts W7: local copy wins, unknown pid, unmapped, no-title protected, grade/judgment re-check, one per sid', () => {
  const own = sm('owner-opus');
  const m = mergeDocs([{ doc_id: own.pid, data: { status: 'approved', params: { from: 'opus', to: 'haiku' }, target: { sid: 'linked-opus' } } }, { doc_id: 'sm-0123456789ab', data: { status: 'approved' } }], [own]);
  assert.deepEqual(m[0].params, own.params); assert.deepEqual(m[0].target, own.target); assert.equal(m[1].unknown, true);
  assert.equal(planApply(m, board(), cfg(), FX.live, null).results[1].reason, 'unknown_proposal');
  assert.equal(validateDecision(own, board(), cfg(), null).reason, 'unmapped');
  assert.equal(validateDecision({ ...own, unmapped: true }, board(), cfg(), live('owner-opus')).reason, 'unmapped');
  assert.equal(validateDecision(own, board(), cfg(), { model: 'claude-opus-4-7' }).reason, 'protected');
  assert.equal(validateDecision(own, board({ grade: 'green' }), cfg(), live('owner-opus')).reason, 'grade_changed');
  const bj = board(); bj.rows.find((r: any) => r.sid === 'owner-opus').j = 1;
  assert.equal(validateDecision(own, bj, cfg(), live('owner-opus')).reason, 'judgment');
  const two = planApply([own, sm('owner-opus', { pid: pidOf('session_model', { sid: 'owner-opus' }, { from: 'opus', to: 'sonnet' }, 1) })], board(), cfg(), FX.live, null);
  assert.equal(two.results[1].reason, 'one_per_sid');
  assert.deepEqual(mappedIds([{ sessionId: 'local_abc', cwd: 'C:\\Claude\\proj' }], [{ sid: 'owner-opus' }]), []);
  assert.deepEqual(mappedIds([{ sessionId: 'owner-opus' }], [{ sid: 'owner-opus' }]), ['owner-opus']);
  const ps = proposals(rows(), { grade: 'red' }, null, NOW, cfg());
  assert.ok(ps.filter((p: any) => p.target && p.target.sid).every((p: any) => p.advice_only && p.unmapped));
  assert.equal(ps.find((p: any) => p.kind === 'agent_default_model').est_saving.window, 'board_tail');
  assert.equal(validateSettings({ values: { sessionRules: { a: 'exclude' } } }, cfg()).rejected.sessionRules.reason, 'not_allowed');
});

test('decisions.ts textProtected: trading folders protected with no config; applied_by fixed', async () => {
  const m = await import('./core/decisions.ts');
  for (const p of ['C:\\Trading\\x', 'c:\\claude\\TRADING\\y']) assert.equal(m.textProtected(p, {}), true, p);
  assert.equal(m.textProtected('C:\\Trading\\x', { managerProtectKeywords: [] }), true);
  assert.equal(m.textProtected('c:\\claude\\TRADING-ARCHIVE\\y', { managerProtectKeywords: [] }), false);
  assert.equal(m.textProtected('c:\\claude\\TRADING-ARCHIVE\\y', { managerProtectSegments: ['trading-archive'], managerProtectKeywords: [] }), true);
  assert.equal(m.textProtected('C:\\Trading\\x', { managerProtectSegments: [], managerProtectKeywords: [] }), false);
  assert.equal(m.textProtected('C:\\Claude\\misc\\token-saver', {}), false);
  assert.equal(m.safeHost('anything'), 'sync');
});

test('M1 decisions.ts validateDecision: basis more than 120 s ahead expires (ttl), +100 s still ok', () => {
  const t = { scope: 'agents' }, p = { from: null, to: 'sonnet' };
  const mk = (at: number) => ({ pid: pidOf('agent_default_model', t, p, 1), kind: 'agent_default_model', target: t, params: p, basis: { measured_at: iso(at) }, status: 'approved' });
  assert.equal((validateDecision(mk(NOW + 86400), board(), cfg(), null) as any).reason, 'ttl');
  assert.equal((validateDecision(mk(NOW + 100), board(), cfg(), null) as any).ok, true);
});
