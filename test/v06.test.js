'use strict';
// Estimated savings hint: the port must match the recorded prototype outputs exactly (constants, skip rules).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cs = require('../scripts/clear-savings');
const gate = require('../scripts/topic-gate');
const boundary = require('../scripts/boundary');

test('constants unchanged', () => {
  assert.strictEqual(cs.FIXED, 90000); assert.strictEqual(cs.THRESHOLD, 266600);
  assert.strictEqual(cs.CACHE_REWRITE, 40000); assert.strictEqual(cs.MIN_MESSAGES, 40000);
  assert.strictEqual(cs.MIN_MESSAGES_IDLE, 20000); assert.strictEqual(cs.MIN_TURNS, 4);
});

const REF = { fixed: 90000, threshold: 266600 };   // the reference machine's measured profile

test('card matches the recorded outputs of the Python prototype', () => {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'clear-savings-golden.json'), 'utf8'));
  let withNum = 0;
  for (const r of rows) {
    const got = cs.card(r.messages, r.turns, { mode: r.mode, idle: r.idle });
    assert.strictEqual(got.text, r.text, `${r.messages}/${r.turns}/${r.mode}/${r.idle}`);
    if (got.range) withNum++;
  }
  assert.strictEqual(rows.length, 220);
  assert.ok(withNum > 10 && withNum < rows.length);
});

test('no-card scenarios give an empty hint line (no numbers)', () => {
  assert.strictEqual(cs.hintLine(100000, 'ko', 'compact', {}, REF), '');           // messages 10k < 40k floor
  assert.strictEqual(cs.hintLine(400000, 'ko', 'compact', {}, REF), '');           // already past auto-compact
  assert.strictEqual(cs.hintLine(200000, 'ko', 'compact', { savingsTurns: 3 }, REF), ''); // too few turns
});

test('unknown profile gives no numbers, never the reference values', () => {
  assert.strictEqual(cs.hintLine(200000, 'ko', 'compact', {}), '');
  assert.strictEqual(cs.hintLine(200000, 'ko', 'compact', {}, { fixed: 90000, threshold: null }), '');
  assert.strictEqual(cs.hintLine(200000, 'ko', 'compact', {}, { fixed: null, threshold: 266600 }), '');
});

test('hint line carries (예상) and tokens, never money or limit percent', () => {
  const ko = cs.hintLine(200000, 'ko', 'compact', {}, REF);
  assert.ok(ko.startsWith('(예상) 지금 압축하면') && ko.includes('토큰 덜 읽음'), ko);
  assert.ok(!/\$|원|%/.test(ko.replace('1/10', '')), ko);
  const en = cs.hintLine(200000, 'en', 'clear', {}, REF);
  assert.ok(en.startsWith('(estimate)') && !/\$|%/.test(en.replace('1/10', '')), en);
});

test('topic-gate hint embeds the estimate only when a card exists', () => {
  const withCard = gate.hintMessage('ko', 200000, 'f.md', {}, REF);
  assert.ok(withCard.includes('(예상) 지금 압축하면') && withCard.includes('(예상) 지금 비우면'));
  assert.ok(!gate.hintMessage('ko', 400000, 'f.md', {}, REF).includes('(예상)'));
  assert.ok(!gate.hintMessage('ko', 200000, 'f.md', {}).includes('(예상)'));
});

test('boundary message appends the estimate only when a card exists', () => {
  assert.ok(boundary.message({ tokens: 200000, commits: [] }, 'ko', 'compact', {}, REF).includes('(예상)'));
  assert.ok(!boundary.message({ tokens: 90000, commits: [] }, 'ko', 'compact', {}, REF).includes('(예상)'));
  assert.ok(!boundary.message({ tokens: 200000, commits: [] }, 'ko', 'compact', {}).includes('(예상)'));
});

// --- per-user profile ---
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-v06-')); }
function line(o) { return JSON.stringify(o) + '\n'; }
const call = (t, extra) => line(Object.assign({ type: 'assistant', isSidechain: false,
  message: { model: 'm', usage: { input_tokens: 10, cache_read_input_tokens: t - 10, cache_creation_input_tokens: 0 } } }, extra));
const autoCompact = (pre) => line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: pre } });

test('window formula reproduces both observed compaction points', () => {
  assert.strictEqual(cs.thresholdFromWindow(400000, '70'), 266000);   // observed 266,646
  assert.strictEqual(cs.thresholdFromWindow(1000000, undefined), 967000); // observed 966,605-972,607
  assert.strictEqual(Math.round(cs.thresholdFromWindow(400000) / 400000 * 100), 92); // the app's displayed 92%
  assert.strictEqual(cs.thresholdFromWindow(null, '70'), null);       // percent without a window: unknown
  assert.strictEqual(cs.thresholdFromWindow(400000, '100'), 367000);  // out-of-range percent ignored
});

test('window values with suffixes', () => {
  assert.strictEqual(cs.parseTokens('400000'), 400000);
  assert.strictEqual(cs.parseTokens('200k'), 200000);
  assert.strictEqual(cs.parseTokens('1M'), 1000000);
  assert.strictEqual(cs.parseTokens(''), null);
  assert.strictEqual(cs.parseTokens('abc'), null);
});

test('fixed share = first main-thread call, skipping sidechain and synthetic lines', () => {
  const d = tmp(), f = path.join(d, 's.jsonl');
  fs.writeFileSync(f, line({ type: 'user' }) + call(5000, { isSidechain: true })
    + call(7000, { message: { model: '<synthetic>', usage: { input_tokens: 7000 } } }) + call(31000) + call(120000));
  assert.strictEqual(cs.firstCallTokens(f), 31000);
  assert.strictEqual(cs.firstCallTokens(path.join(d, 'missing.jsonl')), null);
});

test('profile order: config > this session > window env > history; unknown stays null', () => {
  const d = tmp(), f = path.join(d, 's.jsonl');
  fs.writeFileSync(f, call(30000));
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' };
  const entries = [JSON.parse(autoCompact(250000))];
  assert.deepStrictEqual(cs.profile({ env, entries, transcriptPath: f, cfg: { compactAtTokens: 150000 } }),
    { fixed: 30000, threshold: 150000, source: 'config' });
  assert.strictEqual(cs.profile({ env, entries, transcriptPath: f }).source, 'session');
  assert.deepStrictEqual(cs.profile({ env, transcriptPath: f }), { fixed: 30000, threshold: 266000, source: 'window' });
  assert.strictEqual(cs.profile({ env: {}, transcriptPath: f, cfg: { compactWindowTokens: 1000000 } }).threshold, 967000);
  const none = cs.profile({ env: {}, transcriptPath: f });
  assert.strictEqual(none.threshold, null);
  assert.strictEqual(cs.hintLine(200000, 'ko', 'compact', {}, none), '');
  assert.strictEqual(cs.profile({ env, transcriptPath: path.join(d, 'nope.jsonl') }).fixed, null);
});

test('history: newest transcript with an auto-compact wins, cached for a day', () => {
  const root = tmp(), proj = path.join(root, 'p'), cache = path.join(root, 'cache.json');
  fs.mkdirSync(proj);
  const now = Date.now();
  const old = path.join(proj, 'old.jsonl'), nw = path.join(proj, 'new.jsonl'), quiet = path.join(proj, 'quiet.jsonl');
  fs.writeFileSync(old, autoCompact(967000)); fs.utimesSync(old, new Date(now - 5 * 864e5), new Date(now - 5 * 864e5));
  fs.writeFileSync(nw, autoCompact(266646)); fs.utimesSync(nw, new Date(now - 864e5), new Date(now - 864e5));
  fs.writeFileSync(quiet, call(50000));   // newest file, but no compaction in it
  assert.strictEqual(cs.historyThreshold(root, cache, now), 266646);
  fs.writeFileSync(nw, autoCompact(500000));
  assert.strictEqual(cs.historyThreshold(root, cache, now + 1000), 266646);        // served from cache
  assert.strictEqual(cs.historyThreshold(root, cache, now + 2 * 864e5), 500000);   // cache expired
  const p = cs.profile({ env: {}, transcriptPath: quiet, projectsDir: root, cacheFile: path.join(root, 'c2.json'), nowMs: now });
  assert.deepStrictEqual(p, { fixed: 50000, threshold: 500000, source: 'history' });
});

test('a fixed share at or above the compaction point is inconsistent: no numbers', () => {
  const d = tmp(), f = path.join(d, 's.jsonl');
  fs.writeFileSync(f, call(300000));
  const p = cs.profile({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' }, transcriptPath: f });
  assert.deepStrictEqual(p, { fixed: null, threshold: null, source: 'inconsistent' });
});

test('another user (1M default, light setup) gets their own numbers, not the reference ones', () => {
  const light = { fixed: 25000, threshold: 967000 };
  const a = cs.hintLine(400000, 'ko', 'compact', {}, light);
  assert.ok(a.startsWith('(예상)'), a);                       // reference profile says "past compaction" here
  assert.strictEqual(cs.hintLine(400000, 'ko', 'compact', {}, REF), '');
  assert.notStrictEqual(cs.hintLine(200000, 'ko', 'compact', {}, light), cs.hintLine(200000, 'ko', 'compact', {}, REF));
});
