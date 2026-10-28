// TS mirror of the pure part of test/v10.test.js (scripts/fleet.js).
import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { parseMeta, classify, sessionDir, modelLetter, scanEntries, segment, table, pressure, MAX_SCAN, type FleetEntry } from './core/fleet.ts';

const NOW = 1_800_000_000;
const meta = (o: Record<string, unknown>) => JSON.stringify({ agentType: 'general-purpose', description: 'Collect sample logs', spawnDepth: 1, ...o });
const entry = (id: string, o: Record<string, unknown>, ageSec = 10): FleetEntry => ({ name: `agent-${id}.meta.json`, mtime: NOW - ageSec, text: meta(o) });

test('fleet: parseMeta accepts objects, rejects broken JSON / arrays / null', () => {
  assert.equal(parseMeta('{"model":"opus"}')?.model, 'opus');
  assert.equal(parseMeta('{"a":'), null);
  assert.equal(parseMeta('[1]'), null);
  assert.equal(parseMeta('null'), null);
});

test('fleet: classify running / finished / stale', () => {
  assert.equal(classify({}, NOW - 5, NOW, {}), 'running');
  assert.equal(classify({ finished: true }, NOW - 99999, NOW, {}), 'finished');
  assert.equal(classify({}, NOW - 601, NOW, {}), 'stale');
  assert.equal(classify({}, NOW - 600, NOW, {}), 'running');
  assert.equal(classify({}, NOW - 1000, NOW, { fleetStaleSec: 1800 }), 'running');
  assert.equal(classify({}, NOW - 100, NOW, { fleetStaleSec: 50 }), 'stale');
});

test('fleet: sessionDir strips .jsonl, no glob', () => {
  assert.equal(sessionDir('/a/b/s1.jsonl'), '/a/b/s1/subagents');
  assert.equal(sessionDir(undefined), null);
});

test('fleet: modelLetter', () => {
  assert.deepEqual(['fable', 'claude-opus-4-7', 'sonnet', 'haiku', null, 'zeta'].map(modelLetter), ['F', 'O', 'S', 'H', '?', 'Z']);
});

test('fleet: segment shows only from fleetShowAt', () => {
  const snap = scanEntries([entry('a', { model: 'sonnet' }), entry('b', { model: 'sonnet' }), entry('c', { model: 'opus' }), entry('d', { finished: true })], NOW, {});
  assert.equal(segment(snap, {}), '🤖3 (2S·1O)');
  assert.equal(segment(scanEntries([entry('a', {})], NOW, {}), {}), '');
});

test('fleet: fleet:false and fleetShowAt:0 switch it off', () => {
  const snap = scanEntries([entry('a', { model: 'sonnet' }), entry('b', { model: 'sonnet' })], NOW, {});
  assert.equal(segment(snap, { fleet: false }), '');
  assert.equal(segment(snap, { fleetShowAt: 0 }), '');
  assert.equal(segment(snap, { fleetShowAt: 3 }), '');
});

test('fleet: broken meta is ignored; more than 64 -> truncated', () => {
  const es = [{ name: 'agent-x.meta.json', mtime: NOW, text: '{broken' }, entry('ok', {})];
  assert.equal(scanEntries(es, NOW, {}).total, 1);
  const many = Array.from({ length: MAX_SCAN + 5 }, (_, i) => entry('n' + i, {}, i));
  const s = scanEntries(many, NOW, {});
  assert.equal(s.truncated, true);
  assert.equal(s.total, MAX_SCAN);
});

test('fleet: table renders in en/ko and handles empty', () => {
  const snap = scanEntries([entry('a', { model: 'sonnet' })], NOW, {});
  assert.match(table(snap, 'en'), /1 running/);
  assert.match(table(snap, 'ko'), /실행 중 1/);
  assert.equal(table(scanEntries([], NOW, {}), 'en'), 'No subagent records found.');
});

test('fleet W3: sessionDir normalizes a subagent transcript to the parent folder', () => {
  assert.equal(sessionDir('/p/S/subagents/agent-abc.jsonl'), '/p/S/subagents');
  assert.equal(sessionDir('/p/S.jsonl'), '/p/S/subagents');
});

test('fleet W3: items keep requestShape / nonInteractive', () => {
  const s = scanEntries([entry('a', { model: 'sonnet', requestShape: 'background', requestNonInteractive: true })], NOW, {});
  assert.equal(s.items[0].requestShape, 'background');
  assert.equal(s.items[0].nonInteractive, true);
});

test('fleet W3: pressure has only running/models/truncated', () => {
  const s = scanEntries([entry('a', { model: 'sonnet' })], NOW, {});
  assert.deepEqual(pressure(s), { running: 1, models: { S: 1 }, truncated: false });
  assert.deepEqual(pressure(null), { running: 0, models: {}, truncated: false });
});

test('fleet W3: table budgetLine first, null identical', () => {
  const s = scanEntries([entry('a', { model: 'sonnet' })], NOW, {});
  const base = table(s, 'en');
  assert.equal(table(s, 'en', null), base);
  assert.equal(table(s, 'en', 'BUDGET'), 'BUDGET\n\n' + base);
});

test('fleet W3: 65 entries -> truncated, running within newest 64', () => {
  const many = Array.from({ length: MAX_SCAN + 1 }, (_, i) => entry('n' + i, {}, i + 1));
  const s = scanEntries(many, NOW, {});
  assert.equal(s.truncated, true);
  assert.equal(s.running, MAX_SCAN);
});

// ---- W4b-2 ----
import { normalizeSlug, excludedBySlug, parseHead, classifySession, sessionsSnapshot, pressureWithSessions, fleetPressure, tableWithSessions, type SessionItem } from './core/fleet.ts';

test('fleet W4b-2: normalizeSlug / excludedBySlug match across _ \\ and -', () => {
  assert.equal(normalizeSlug('mybot_work'), 'mybot-work');
  assert.equal(excludedBySlug('C--Users-x-Temp-mybot-work', undefined, ['mybot_work']), true);
  assert.equal(excludedBySlug('C--Work', 'C:\\Users\\x\\Temp\\mybot_work', ['mybot_work']), true);
  assert.equal(excludedBySlug('C-newsbot-translate-work', undefined, ['newsbot']), true);
  assert.equal(excludedBySlug('C--Claude', undefined, ['mybot_work', '']), false);
  assert.equal(excludedBySlug('C--Claude', undefined, undefined), false);
});

test('fleet W4b-2: parseHead is line based, entrypoint on the 2nd line after a 14 KB record', () => {
  const big = JSON.stringify({ type: 'queue-operation', content: 'x'.repeat(14000) });
  const t = big + '\n' + JSON.stringify({ entrypoint: 'sdk-cli', cwd: 'C:/b' }) + '\n';
  assert.deepEqual(parseHead(t, false), { entrypoint: 'sdk-cli', cwd: 'C:/b' });
  assert.deepEqual(parseHead('{"type":"user","entrypoi', false), { entrypoint: null, cwd: null });
  assert.deepEqual(parseHead('{"entrypoint":"cli"}\n{"cut', true), { entrypoint: 'cli', cwd: null });
});

test('fleet W4b-2: classifySession precedence', () => {
  const cfg = { excludeCwd: ['mybot_work'] };
  const mk = (o: Record<string, unknown>) => ({ slug: 'C--Claude', path: '/p/C--Claude/a.jsonl', entrypoint: 'claude-desktop', cwd: 'C:/Claude', ...o });
  assert.equal(classifySession(mk({}), NOW - 5, NOW, '/p/C--Claude/a.jsonl', cfg), 'self');
  assert.equal(classifySession(mk({}), NOW - 5, NOW, '/p/C--Claude/a/subagents/agent-9.jsonl', cfg), 'self');
  assert.equal(classifySession(mk({}), NOW - 5, NOW, null, cfg), 'interactive');
  assert.equal(classifySession(mk({ entrypoint: 'cli' }), NOW - 5, NOW, null, cfg), 'interactive');
  assert.equal(classifySession(mk({ entrypoint: 'sdk-cli' }), NOW - 5, NOW, null, cfg), 'headless');
  assert.equal(classifySession(mk({ entrypoint: 'sdk-cli', slug: 'C-mybot-work' }), NOW - 5, NOW, null, cfg), 'excluded');
  assert.equal(classifySession(mk({}), NOW - 7200, NOW, null, cfg), 'old');
  assert.equal(classifySession(mk({ entrypoint: null }), NOW - 5, NOW, null, cfg), 'unknown');
});

test('fleet W4b-2: sessionsSnapshot counts and count flags', () => {
  const it = (kind: SessionItem['kind']): SessionItem => ({ slug: 's', id: kind, age: 1, kind });
  const items = [it('interactive'), it('interactive'), it('headless'), it('excluded'), it('unknown')];
  const s = sessionsSnapshot(items, false, {}, 0);
  assert.deepEqual([s.sessions, s.headless, s.excluded, s.unknown, s.truncated], [2, 1, 1, 1, false]);
  assert.equal(sessionsSnapshot(items, false, { fleetSessionsCountHeadless: true }).sessions, 3);
  assert.equal(sessionsSnapshot(items, true, { fleetSessionsCountExcluded: true }).sessions, 3);
  assert.equal(sessionsSnapshot([], false, {}, 6).excluded, 6);
});

test('fleet W4b-2: fleetPressure agents alone / total', () => {
  assert.equal(fleetPressure({ running: 3 }), true);
  assert.equal(fleetPressure({ running: 1, sessions: 3 }), true);
  assert.equal(fleetPressure({ running: 1, sessions: 2 }), false);
  assert.equal(fleetPressure({ running: 1, sessions: null }), false);
  assert.equal(fleetPressure({ running: 4, sessions: 0 }, {}, 'hard'), false);
  assert.equal(fleetPressure({ running: 5 }, {}, 'hard'), true);
  assert.equal(fleetPressure({ running: 3, sessions: 4 }, {}, 'hard'), true);
});

test('fleet W4b-2: pressure without sessions keeps the old shape', () => {
  const s = scanEntries([entry('a', { model: 'sonnet' })], NOW, {});
  assert.deepEqual(pressureWithSessions(s), { running: 1, models: { S: 1 }, truncated: false });
  assert.equal(pressureWithSessions(s, null).sessions, null);
  assert.equal(pressureWithSessions(s, sessionsSnapshot([{ slug: 's', id: 'a', age: 1, kind: 'interactive' }], false)).sessions, 1);
  assert.equal(fleetPressure({ running: 3, sessions: undefined }), fleetPressure({ running: 3 }));
});

test('fleet W4b-2: table sessions line in ko/en/ja, null ss identical', () => {
  const s = scanEntries([entry('a', { model: 'sonnet' }), entry('b', { model: 'opus' })], NOW, {});
  const ss = sessionsSnapshot([{ slug: 's', id: 'a', age: 1, kind: 'interactive' }, { slug: 's', id: 'b', age: 1, kind: 'interactive' }], false, {}, 6);
  assert.equal(tableWithSessions(s, 'en', null, null), table(s, 'en'));
  assert.match(tableWithSessions(s, 'ko', null, ss), /^세션 2개\(대화형\) · 제외 6 · 헤드리스 0 · 이 세션 에이전트 2개 \(1O·1S\)/);
  assert.match(tableWithSessions(s, 'en', 'BUDGET', ss), /^BUDGET\n\nsessions 2 \(interactive\) · excluded 6 · headless 0 · agents here 2/);
  assert.match(tableWithSessions(s, 'ja', null, ss, true), /^セッション 2件.*全体のエージェント 2件/);
});
