'use strict';
// Savings estimate: synthetic events + transcripts in temp folders only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pacer-v04-'));
const HOME = path.join(TMP, 'home');
const PROJ = path.join(TMP, 'projects', 'p1');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
process.env.TOKEN_STAMINA_HOME = HOME;

const sv = require('../scripts/savings');
const handoff = require('../scripts/handoff');

const T0 = Date.parse('2026-10-20T10:00:00Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();
const jl = (arr) => arr.map((o) => JSON.stringify(o)).join('\n') + '\n';
const asst = (id, min, model, u, extra) => Object.assign({ type: 'assistant', isSidechain: false, timestamp: iso(min),
  message: { id, model, usage: { input_tokens: u[0], cache_read_input_tokens: u[1], cache_creation_input_tokens: u[2], output_tokens: u[3] }, content: [] } }, extra || {});
const toolUse = (o, id) => { o.message.content.push({ type: 'tool_use', id, name: 'Agent', input: {} }); return o; };
const result = (min, id, tur) => ({ type: 'user', timestamp: iso(min), message: { content: [{ type: 'tool_result', tool_use_id: id }] }, toolUseResult: tur });
const boundary = (min, trigger, pre, post) => ({ type: 'system', subtype: 'compact_boundary', timestamp: iso(min), compactMetadata: Object.assign({ trigger, preTokens: pre }, post ? { postTokens: post } : {}) });
const writeSession = (sid, entries) => fs.writeFileSync(path.join(PROJ, sid + '.jsonl'), jl(entries));
const writeEvents = (evs) => fs.writeFileSync(path.join(HOME, 'events.jsonl'), jl(evs.map((e) => Object.assign({ ts: iso(0) }, e))));
const clearSessions = () => fs.readdirSync(PROJ).forEach((f) => fs.rmSync(path.join(PROJ, f), { recursive: true, force: true }));
const opts = { since: '2026-10-01', dir: path.join(TMP, 'projects') };
const cfg = { savingsMaxCalls: 50 };

test('cost: weights, cache write 1.25x, cache read 0.1x, output 5x', () => {
  const u = { input: 100, cache_creation: 80, cache_read: 1000, output: 10 };
  assert.equal(sv.cost(u, 'haiku'), 100 + 100 + 100 + 50);
  assert.equal(sv.cost(u, 'opus'), (100 + 100 + 100 + 50) * 5);
  assert.equal(sv.opusEquiv(sv.cost(u, 'sonnet')), 350 * 3 / 5);
  assert.equal(sv.cost(u, 'other'), 0);
});

test('A: sync downgrade uses toolUseResult.usage, saving = opus cost - sonnet cost', () => {
  clearSessions();
  const caller = toolUse(asst('m1', 1, 'claude-opus-4', [10, 0, 0, 5]), 'tu1');
  writeSession('sA', [caller, result(2, 'tu1', { agentId: 'a1', resolvedModel: 'claude-sonnet-4', usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 } })]);
  writeEvents([{ event: 'agent_model', session: 'sA', action: 'inject', model: 'sonnet', tool_use_id: 'tu1' },
    { event: 'agent_model', session: 'sA', action: 'suggest', model: 'sonnet', tool_use_id: 'tu2' },
    { event: 'agent_model', session: 'sA', action: 'inject', model: 'sonnet' }]); // no tool_use_id -> unresolved
  const r = sv.compute(opts, cfg);
  const u = { input: 1000, cache_read: 0, cache_creation: 0, output: 100 };
  assert.equal(r.downgrade.count, 1);
  assert.equal(r.downgrade.suggest_only, 1);
  assert.equal(r.downgrade.unresolved, 1);
  assert.equal(r.downgrade.cost, sv.cost(u, 'opus') - sv.cost(u, 'sonnet'));
  assert.equal(r.downgrade.tokens, 1100);
  assert.equal(r.estimate, true);
});

test('A: async result sums the subagent transcript (unique messages, max merge)', () => {
  clearSessions();
  const caller = toolUse(asst('m1', 1, 'claude-opus-4', [10, 0, 0, 5]), 'tu1');
  writeSession('sB', [caller, result(2, 'tu1', { agentId: 'a9', status: 'async_launched', resolvedModel: 'claude-haiku-4' })]);
  const sub = path.join(PROJ, 'sB', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-a9.jsonl'), jl([
    asst('s1', 1, 'claude-haiku-4', [100, 0, 0, 10], { isSidechain: true }),
    asst('s1', 1, 'claude-haiku-4', [100, 0, 0, 40], { isSidechain: true }), // repeated id: max
    asst('s2', 2, 'claude-haiku-4', [200, 500, 0, 20], { isSidechain: true })]));
  writeEvents([{ event: 'agent_model', session: 'sB', action: 'inject', model: 'haiku', tool_use_id: 'tu1' }]);
  const r = sv.compute(opts, cfg);
  const u = { input: 300, cache_read: 500, cache_creation: 0, output: 60 };
  assert.equal(r.downgrade.count, 1);
  assert.equal(r.downgrade.cost, sv.cost(u, 'opus') - sv.cost(u, 'haiku'));
});

test('A: never negative when the caller was already the weaker model', () => {
  assert.equal(sv.downgradeSaving({ input: 100, cache_read: 0, cache_creation: 0, output: 0 }, 'haiku', 'sonnet').saving, 0);
});

function compactSession(sid, trigger, nAfter) {
  const e = [asst('c0', 0, 'claude-opus-4', [10, 100000, 0, 5]), boundary(10, trigger, 120000, 20000)];
  for (let i = 0; i < nAfter; i++) e.push(asst('c' + (i + 1), 11 + i, 'claude-opus-4', [10, 20000, 0, 5]));
  writeSession(sid, e);
}

test('B: manual compact after hint counts; auto and unhinted manual are excluded', () => {
  clearSessions();
  compactSession('sC1', 'manual', 4);   // hinted
  compactSession('sC2', 'auto', 4);     // auto
  compactSession('sC3', 'manual', 4);   // manual, hint too old
  writeEvents([
    { event: 'inline_hint', session: 'sC1', ts: iso(-60) },
    { event: 'inline_hint', session: 'sC2', ts: iso(-60) },
    { event: 'topic_gate', session: 'sC3', ts: iso(-400) }]);
  const r = sv.compute(opts, cfg);
  assert.equal(r.compact.count, 1);
  assert.equal(r.compact.excluded_auto, 1);
  assert.equal(r.compact.excluded_no_alert, 1);
  assert.equal(r.compact.tokens, 100000 * 4);
  // no summary message: the compact request costs 0.1*pre + 5*postTokens, more than 4 re-reads save
  assert.equal(r.compact.compact_overhead_opus_input_equiv, 0.1 * 120000 + 5 * 20000);
  assert.equal(r.compact.not_worth_it, 1);
  assert.equal(r.compact.cost, 0);
});

test('B: N is capped by savingsMaxCalls; postTokens missing falls back to first call context', () => {
  clearSessions();
  const e = [asst('d0', 0, 'claude-sonnet-4', [10, 100000, 0, 5]), boundary(10, 'manual', 110000)];
  for (let i = 0; i < 8; i++) e.push(asst('d' + (i + 1), 11 + i, 'claude-sonnet-4', [10, 30000, 0, 5]));
  writeSession('sD', e);
  writeEvents([{ event: 'boundary', session: 'sD', ts: iso(5) }]);
  const r = sv.compute(opts, { savingsMaxCalls: 3 });
  assert.equal(r.compact.count, 1);
  assert.equal(r.compact.tokens, (110000 - 30010) * 3);
  assert.equal(r.compact.cost, 0); // re-read saving is below the compact request cost
});

test('B: compact request cost is subtracted, summary measured from the summary message', () => {
  clearSessions();
  const e = [asst('s0', 0, 'claude-opus-4', [10, 190000, 0, 5]), boundary(10, 'manual', 200000, 20000),
    { type: 'user', isCompactSummary: true, timestamp: iso(10), message: { role: 'user', content: 'x'.repeat(4000) } }];
  for (let i = 0; i < 30; i++) e.push(asst('s' + (i + 1), 11 + i, 'claude-opus-4', [10, 20000, 0, 5]));
  writeSession('sS', e);
  writeEvents([{ event: 'inline_hint', session: 'sS', ts: iso(5) }]);
  const r = sv.compute(opts, cfg);
  const reread = 180000 * 30 * 0.1 * 5, overhead = (0.1 * 200000 + 5 * 1000) * 5;
  assert.equal(r.compact.count, 1);
  assert.equal(r.compact.cost, reread - overhead);
  assert.equal(r.compact.not_worth_it, 0);
  assert.equal(sv.compactCost(200000, 1000, 'opus'), overhead);
});

test('C: clear linked by from_session counts; old events without it are "unlinked"', () => {
  clearSessions();
  writeSession('old', [asst('o1', 0, 'claude-opus-4', [10, 150000, 0, 5]), asst('o2', 5, 'claude-opus-4', [10, 160000, 0, 5])]);
  const nw = [];
  for (let i = 0; i < 5; i++) nw.push(asst('n' + i, 20 + i, 'claude-opus-4', [10, 10000, 0, 5]));
  writeSession('new', nw);
  writeEvents([
    { event: 'topic_gate', session: 'old', ts: iso(-30) },
    { event: 'handoff_restore', session: 'new', source: 'clear', kind: 'claude', fallback: true, from_session: 'old', ts: iso(19) },
    { event: 'handoff_restore', session: 'new', source: 'clear', kind: 'claude', fallback: true, ts: iso(19) },
    { event: 'handoff_restore', session: 'new', source: 'compact', kind: 'auto', fallback: false, ts: iso(19) }]);
  const r = sv.compute(opts, cfg);
  assert.equal(r.clear.count, 1);
  assert.equal(r.clear.unlinked, 1);
  assert.equal(r.clear.tokens, (160010 - 10010) * 5);
  assert.equal(r.total_opus_input_equiv, r.downgrade.opus_input_equiv + r.compact.opus_input_equiv + r.clear.opus_input_equiv);
});

test('C: clear without a recent hint on the old session is excluded', () => {
  writeEvents([{ event: 'handoff_restore', session: 'new', source: 'clear', kind: 'claude', fallback: true, from_session: 'old', ts: iso(19) }]);
  const r = sv.compute(opts, cfg);
  assert.equal(r.clear.count, 0);
  assert.equal(r.clear.excluded_no_alert, 1);
});

test('text output marks every line as an estimate (ko and en)', () => {
  const r = sv.compute(opts, cfg);
  for (const lang of ['ko', 'en']) {
    const lines = sv.renderText(r, lang).trim().split('\n');
    const mark = lang === 'ko' ? '추정' : 'est';
    for (const l of lines) assert.ok(l.includes(mark), l);
  }
  assert.ok(sv.renderText(r, 'ko').includes('플러그인이 없었다면'));
});

test('handoff: clear restore records from_session; agent_model event carries tool_use_id', () => {
  const sid = 'prevsess', cwd = path.join(TMP, 'work');
  fs.mkdirSync(handoff.dirOf(), { recursive: true });
  fs.writeFileSync(handoff.sessionFile(sid, true), 'claude note');
  const t = path.join(TMP, 'tr.jsonl');
  fs.writeFileSync(t, jl([{ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: iso(0) }]));
  handoff.runStop({ session_id: sid, cwd, transcript_path: t });
  handoff.runStart({ session_id: 'freshsess', cwd, source: 'clear', hook_event_name: 'SessionStart' });
  const read = () => fs.readFileSync(path.join(HOME, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(read().filter((e) => e.event === 'handoff_restore').pop().from_session, sid);
  const am = require('../scripts/agent-model');
  am.run(JSON.stringify({ tool_name: 'Agent', session_id: 's', tool_use_id: 'toolu_1', tool_input: { prompt: 'x', model: 'opus' } }));
  assert.equal(read().pop().tool_use_id, 'toolu_1');
});

const gate = require('../scripts/topic-gate');

test('topic check (0.4.2): above gateAt every prompt, quiet after a clear offer until the context grows', () => {
  const c = { gateAtTokens: 200000 };
  assert.equal(gate.decideTopicCheck(150000, c, null).check, false);
  assert.equal(gate.decideTopicCheck(210000, c, null).check, true);
  assert.equal(gate.decideTopicCheck(220000, c, null).check, true); // every prompt, no growth gate
  assert.equal(gate.decideTopicCheck(250000, c, 210000).check, false); // offered at 210k
  assert.equal(gate.decideTopicCheck(320000, c, 210000).check, true); // +100k
  assert.equal(gate.decideTopicCheck(210000, c, 300000).offeredAt, null); // shrank: reset
  assert.equal(gate.decideTopicCheck(250000, { gateAtTokens: 200000, topicCheck: false }, null).check, false);
  const offer = asst('o1', 0, 'claude-opus-4', [1, 1, 0, 1]);
  offer.message.content.push({ type: 'tool_use', id: 't', name: 'mcp__ccd_turn__wrap_up', input: { actions: [{ message: '지금 세션 비워줘 (clear_session self)' }] } });
  assert.equal(gate.clearOffered([offer]), true);
  assert.equal(gate.clearOffered([asst('o2', 0, 'claude-opus-4', [1, 1, 0, 1])]), false);
  assert.ok(gate.topicCheckMessage('ko', 210000, 'H.md').includes('비우지 않기'));
});

test('savings: topic-check line cost is subtracted and clears after it are attributed', () => {
  clearSessions();
  writeSession('old', [asst('a1', 0, 'claude-opus-4', [10, 250000, 0, 5]), asst('a2', 1, 'claude-opus-4', [10, 250000, 0, 5]),
    asst('a3', 2, 'claude-opus-4', [10, 250000, 0, 5])]);
  writeSession('new', [asst('n1', 5, 'claude-opus-4', [10, 20000, 0, 5]), asst('n2', 6, 'claude-opus-4', [10, 20000, 0, 5])]);
  writeEvents([
    { event: 'topic_check', session: 'old', tokens: 250000, line_tokens: 100, ts: iso(0.5) },
    { event: 'handoff_restore', session: 'new', source: 'clear', kind: 'claude', fallback: true, from_session: 'old', ts: iso(4) }]);
  const r = sv.compute(opts, cfg);
  assert.equal(r.topic_check_cost.count, 1);
  assert.equal(r.topic_check_cost.tokens, 100 * 2); // re-read on the 2 later calls
  assert.equal(r.clear.count, 1);
  assert.equal(r.clear.after_topic_check, 1);
  assert.equal(r.clear.after_topic_check_opus_input_equiv, r.clear.opus_input_equiv);
  assert.equal(r.total_opus_input_equiv, r.downgrade.opus_input_equiv + r.compact.opus_input_equiv + r.clear.opus_input_equiv - r.topic_check_cost.opus_input_equiv);
  assert.ok(sv.renderText(r, 'ko').includes('주제 확인 줄 비용'));
});
