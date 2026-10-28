// TS mirror of the pure part of test/v15.test.js (scripts/board.js), same fixtures.
import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { turnsFromTail, metrics, row, suggest, readBoardEntries, pruneList, ROW_KEYS } from './core/board.ts';

const FX = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'board');
const EXP = JSON.parse(readFileSync(join(FX, 'expected.json'), 'utf8'));
const T0 = 1793145600;
const load = (n: string) => turnsFromTail(readFileSync(join(FX, n + '.jsonl'), 'utf8'));
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const cfg = { lang: 'en', judgmentKeywords: ['design', 'architecture', 'review', 'audit', '설계'], gateAtTokens: 200000, newSessionAtTokens: 400000 };

test('board.ts E1: A trend / spark; B sample 8', () => {
  const m = metrics(load('A'), null, T0 + 1600, cfg);
  assert.equal(m.in_med10, EXP.A.in_med10);
  assert.equal(m.in_trend, EXP.A.in_trend);
  assert.equal(m.spark.length, 20);
  assert.equal(m.last_user_ts, EXP.A.last_user_ts);
  const b = metrics(load('B'), null, T0 + 600, cfg);
  assert.equal(b.sample_turns, 8); assert.equal(b.spark.length, 8); assert.equal(b.in_trend, null);
});

test('board.ts E2: C misses 3, hit_active excludes them; empty -> null', () => {
  const c = metrics(load('C'), null, T0 + 5000, cfg);
  assert.equal(c.miss_after_idle, 3); near(c.hit, 0.63); near(c.hit_active, 0.9);
  const e = metrics(load('E'), null, T0, cfg);
  assert.equal(e.hit, null); assert.equal(e.fit, null); assert.equal(e.sample_turns, 0);
});

test('board.ts E3/E4/E5', () => {
  assert.equal(metrics(load('A'), null, T0, cfg).fit, 'lower_candidate');
  assert.equal(metrics(load('B'), ['design', 'review', 'audit'], T0, cfg).fit, 'judgment_on_lower');
  assert.equal(metrics(load('B'), ['設計'], T0, cfg).j, 1);
  const c2 = { ...cfg, gateAtTokens: 1500 };
  assert.equal(metrics(load('A'), null, EXP.A.last_user_ts + 1799, c2).clear_candidate, false);
  assert.equal(metrics(load('A'), null, EXP.A.last_user_ts + 1800, c2).clear_candidate, true);
  // W7 E5: totalTokens is a last-turn value -> only the ids leave metrics (mirror of scripts/board.js)
  assert.deepEqual(metrics(load('D'), null, T0, cfg).agent_done_ids, ['agA', 'agB']);
  assert.equal(metrics(load('D'), null, T0, cfg).main_tokens_sum, 3000);
  assert.deepEqual(metrics(load('A'), null, T0, cfg).agent_done_ids, []);
});

test('board.ts row whitelist and suggest priority / languages', () => {
  const m = metrics(load('A'), null, T0 + 1600, cfg);
  const r = row({ sid: 's', cwd: 'C:\\Users\\x\\proj', entrypoint: 'cli' }, m, { running: 0, items: [] }, T0, cfg);
  assert.deepEqual(Object.keys(r).sort(), ROW_KEYS.slice().sort());
  assert.equal(r.cwd_tail, 'proj');
  const both = { ...r, clear_candidate: true };
  assert.match(suggest(both, { grade: 'red' }, cfg)!, /Budget is red/);
  assert.match(suggest(both, { grade: 'green' }, cfg)!, /Clear candidate/);
  assert.equal(suggest({ ...r, fit: 'fit', clear_candidate: false, in_med10: 1000 }, { grade: 'green' }, cfg), null);
  assert.equal(suggest({ ...r, clear_candidate: false }, {}, { ...cfg, lang: 'ko' }), '이 세션은 Sonnet 으로 낮춰도 돼요(앱 모델 메뉴).');
  assert.equal(suggest({ ...r, clear_candidate: false }, {}, { ...cfg, lang: 'ja' }), 'このセッションは Sonnet で十分です(アプリのモデルメニュー)。');
});

test('board.ts readBoardEntries / pruneList: 25h out, broken skipped, manager.json kept', () => {
  const now = 1_800_000_000;
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const entries = [
    { name: 'fresh.json', text: JSON.stringify({ sid: 'fresh', updated_at: iso(now - 60) }) },
    { name: 'old.json', text: JSON.stringify({ sid: 'old', updated_at: iso(now - 25 * 3600) }) },
    { name: 'broken.json', text: '{"sid":' },
    { name: 'manager.json', text: '{"log":[]}' },
  ];
  assert.deepEqual(readBoardEntries(entries, now, cfg).map((r) => r.sid), ['fresh']);
  assert.deepEqual(pruneList(entries, now, cfg).sort(), ['old.json']);
});

test('H1 board.ts pruneList: decisions ledger and sid-mismatch files are never pruned (shape, not name)', () => {
  const now = 1_800_000_000;
  const entries = [
    { name: 'decisions.json', text: JSON.stringify({ rows: [], proposals: {} }) },
    { name: 'decisions2.json', text: JSON.stringify([{ pid: 'x' }]) },
    { name: 'mismatch.json', text: JSON.stringify({ sid: 'other', updated_at: '2000-01-01T00:00:00Z' }) },
    { name: 'dead.json', text: JSON.stringify({ sid: 'dead', updated_at: '2000-01-01T00:00:00Z' }) },
  ];
  assert.deepEqual(pruneList(entries, now, cfg), ['dead.json']);
  assert.deepEqual(readBoardEntries(entries, now, cfg), []);
});

// ---- W9-1b mirror ----
import { accountOf, summaryOf, cleanTitle, titleMap, sessionDocs, batchOf, pushTokens24h, decidePush, pushHashText } from './core/board.ts';
const NOW = T0 + 3600;
const isoS = (s: number) => new Date(s * 1000).toISOString();
const mk = (sid: string, over: any) => ({ ...row({ sid, cwd: 'C:\\x\\' + sid, entrypoint: 'cli' }, metrics(load('A'), null, NOW, cfg), { running: 0, items: [] }, NOW, cfg), ...over });
const three = () => [mk('s1', { hit: 0.9, fit: 'lower_candidate', clear_candidate: false }), mk('s2', { hit: 0.6, fit: 'fit', clear_candidate: true }), mk('s3', { hit: 0.3, fit: 'fit', clear_candidate: false, agents_running: 2 })];
const assessRed = { grade: 'red', worst: '7d', stale: false, d7: { used: 80, elapsedPct: 50, resetsAt: NOW + 302400 }, h5: { used: 5, elapsedPct: 80, resetsAt: NOW + 3600 } };

test('board.ts rows: account / summary / suggestions / no forecast keys', () => {
  const acc = accountOf({ recorded_at: NOW - 60 }, assessRed, NOW);
  assert.equal(acc.grade, 'red'); assert.equal(acc.vs_share_pp, 30); assert.equal(acc.updated_at, isoS(NOW)); assert.equal(acc.stale, false);
  const sess = sessionDocs(three(), acc, null, cfg);
  const sum = summaryOf(sess, 3, NOW);
  assert.equal(sum.sessions, 3); assert.equal(sum.lower, 1); assert.equal(sum.clear, 1); assert.equal(sum.agents, 2); near(sum.hit, 0.6);
  assert.match(sess[0].suggestion, /Budget is red/);
  assert.ok(!/forecast|"eta|exhaust/i.test(JSON.stringify({ acc, sess, sum })));
  assert.equal(accountOf({ recorded_at: NOW - 7 * 3600 }, { grade: null, stale: true }, NOW).stale, true);
});

test('board.ts rows: titles, mask, batch shape, deletes', () => {
  const t = [{ sessionId: 's1', title: 'A very long session title indeed' }];
  assert.equal(sessionDocs(three(), {}, t, cfg)[0].title, 'A very long session title indeed');
  assert.equal(sessionDocs(three(), {}, t, { ...cfg, dashboardMaskTitles: true })[0].title, 'A very long …');
  assert.equal(cleanTitle('a\nb', false), 'a b');
  assert.deepEqual(titleMap({ x: 'y', z: 1 }), { x: 'y' });
  const acc = accountOf({}, assessRed, NOW); const sess = sessionDocs(three(), acc, null, cfg);
  const w = batchOf(sess, acc, summaryOf(sess, null, NOW), { 'sessions/s1': 4, 'account/now': 9, 'sessions/gone': 2 });
  assert.deepEqual(w.map((x: any) => `${x.op}:${x.collection}/${x.doc_id}${x.if_version ? '@' + x.if_version : ''}`),
    ['set:account/now@9', 'set:summary/now', 'set:sessions/s1@4', 'set:sessions/s2', 'set:sessions/s3', 'delete:sessions/gone@2']);
});

test('board.ts rows: budget and unchanged decisions', () => {
  const ev = (tokens: number, ago: number) => JSON.stringify({ ts: isoS(NOW - ago), event: 'board_push', tokens }) + '\n';
  assert.equal(pushTokens24h(ev(150001, 100), NOW), 150001);
  assert.equal(pushTokens24h(ev(7, 90000), NOW), 0);
  const last = { ts: NOW - 100, hash: 'h' };
  assert.equal(decidePush({ now: NOW, cfg, tokens24h: 150001, last, hash: 'h' }).reason, 'budget');
  assert.equal(decidePush({ now: NOW, cfg, tokens24h: 150000, last: { ts: NOW - 100, hash: 'zz' }, hash: 'h' }), null);
  assert.equal(decidePush({ now: NOW, cfg, tokens24h: 150001, last: { ts: NOW - 4000, hash: 'h' }, hash: 'h' }), null);
  assert.equal(decidePush({ now: NOW, cfg, tokens24h: 0, last, hash: 'h' }).reason, 'unchanged');
  assert.equal(decidePush({ now: NOW, cfg, tokens24h: 0, last, hash: 'h', pending: 1 }), null);
  assert.equal(decidePush({ now: NOW, cfg, tokens24h: 0, last: { ts: NOW - 1600, hash: 'h' }, hash: 'h' }), null);
  const a = three(), acc = accountOf({}, assessRed, NOW);
  const h1 = pushHashText(sessionDocs(a, acc, null, cfg), acc, {});
  const h2 = pushHashText(sessionDocs(a.map((r) => ({ ...r, idle_sec: 5, updated_at: 'x' })), acc, null, cfg), { ...acc, vs_share_pp: 1 }, {});
  assert.equal(h1, h2);
});
