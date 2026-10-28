// Ported from test/v06.test.js. The legacy `firstCallTokens(transcriptPath)` and
// `historyThreshold(projectsDir, cacheFile, nowMs)` are impure (partial-read a transcript file /
// scan a projects directory + a daily cache file). The port splits each into a pure "given the
// already-fetched data, decide" half:
//   - firstCallTokens(path)        -> firstCallTokensFromText(text)       (text = already-read)
//   - historyThreshold(dir, cache) -> cacheIsFresh(cache, nowMs)          (cache = already-read JSON)
//                                   + pickNewestAutoCompact(textsNewestFirst) (texts = already-read,
//                                     already filtered to <30 days/<64 MiB, already sorted)
//   - profile(o)                   -> computeProfile(o)  (every fetched value passed in explicitly;
//                                     see ComputeProfileInput's field-by-field mapping in clear-savings.ts)
// register.ts (desktop-only, unverified on this PC) owns the actual `$.fs` reads/writes/directory
// scans and must assemble the ComputeProfileInput object before calling computeProfile().
//
// `hintLine`/`card`/`thresholdFromWindow`/`parseTokens` were already pure in the original and are
// ported with unchanged signatures. The golden-fixture comparison (`card` vs the reviewed Python
// prototype's recorded outputs) is read directly from test/fixtures/clear-savings-golden.json via
// plain node:fs -- that's a static JSON data file, not impure hook orchestration.
//
// NOT ported (duplicative): v06's "topic-gate hint embeds the estimate..." and "boundary message
// appends the estimate..." tests are already covered by hooks/topic-gate.test.ts's
// 'hintMessage: embeds both the compact and clear estimates...' and hooks/boundary.test.ts's
// 'message: embeds the clear-savings estimate...'.

import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  FIXED,
  THRESHOLD,
  CACHE_REWRITE,
  MIN_MESSAGES,
  MIN_MESSAGES_IDLE,
  MIN_TURNS,
  card,
  hintLine,
  thresholdFromWindow,
  parseTokens,
  firstCallTokensFromText,
  cacheIsFresh,
  pickNewestAutoCompact,
  computeProfile,
} from './core/clear-savings.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REF = { fixed: 90000, threshold: 266600 }; // the reference machine's measured profile

test('constants unchanged', () => {
  assert.equal(FIXED, 90000);
  assert.equal(THRESHOLD, 266600);
  assert.equal(CACHE_REWRITE, 40000);
  assert.equal(MIN_MESSAGES, 40000);
  assert.equal(MIN_MESSAGES_IDLE, 20000);
  assert.equal(MIN_TURNS, 4);
});

test('card matches the recorded outputs of the Python prototype', () => {
  const rows = JSON.parse(readFileSync(join(__dirname, '..', 'test', 'fixtures', 'clear-savings-golden.json'), 'utf8'));
  let withNum = 0;
  for (const r of rows) {
    const got = card(r.messages, r.turns, { mode: r.mode, idle: r.idle });
    assert.equal(got.text, r.text, `${r.messages}/${r.turns}/${r.mode}/${r.idle}`);
    if (got.range) withNum++;
  }
  assert.equal(rows.length, 220);
  assert.ok(withNum > 10 && withNum < rows.length);
});

test('no-card scenarios give an empty hint line (no numbers)', () => {
  assert.equal(hintLine(100000, 'ko', 'compact', {}, REF), ''); // messages 10k < 40k floor
  assert.equal(hintLine(400000, 'ko', 'compact', {}, REF), ''); // already past auto-compact
  assert.equal(hintLine(200000, 'ko', 'compact', { savingsTurns: 3 }, REF), ''); // too few turns
});

test('no card unless the full-price-equivalent saving at the low end at least covers the clearing cost', () => {
  // ~94-376만 tokens re-read but only ~4-33만 full-price equivalent, low end below the 5만 rewrite
  assert.equal(card(66984, 10).range, null);
  assert.ok(card(66984, 10).text.includes('비우는 비용'));
  const r = card(150000, 10);
  assert.ok(r.range !== null && r.range[2] >= CACHE_REWRITE * 1.25, r.text);
});

test('unknown profile gives no numbers, never the reference values', () => {
  assert.equal(hintLine(200000, 'ko', 'compact', {}, undefined), '');
  assert.equal(hintLine(200000, 'ko', 'compact', {}, { fixed: 90000, threshold: null }), '');
  assert.equal(hintLine(200000, 'ko', 'compact', {}, { fixed: null, threshold: 266600 }), '');
});

test('hint line carries (예상) and tokens, never money or limit percent', () => {
  const ko = hintLine(200000, 'ko', 'compact', {}, REF);
  assert.ok(ko.startsWith('(예상) 지금 압축하면') && ko.includes('정가 환산') && ko.includes('덜 읽는 양'), ko);
  // full-price equivalent comes first, raw re-read tokens only in parentheses
  assert.ok(ko.indexOf('정가 환산') < ko.indexOf('덜 읽는 양'), ko);
  assert.ok(!/\$|원|%/.test(ko.replace('1/10', '')), ko);
  const en = hintLine(200000, 'en', 'clear', {}, REF);
  assert.ok(en.startsWith('(estimate)') && !/\$|%/.test(en.replace('1/10', '')), en);
});

test('window formula reproduces both observed compaction points', () => {
  assert.equal(thresholdFromWindow(400000, '70'), 266000); // observed 266,646
  assert.equal(thresholdFromWindow(1000000, undefined), 967000); // observed 966,605-972,607
  assert.equal(Math.round((thresholdFromWindow(400000, undefined) as number) / 400000 * 100), 92); // app's displayed 92%
  assert.equal(thresholdFromWindow(null, '70'), null); // percent without a window: unknown
  assert.equal(thresholdFromWindow(400000, '100'), 367000); // out-of-range percent ignored
});

test('window values with suffixes', () => {
  assert.equal(parseTokens('400000'), 400000);
  assert.equal(parseTokens('200k'), 200000);
  assert.equal(parseTokens('1M'), 1000000);
  assert.equal(parseTokens(''), null);
  assert.equal(parseTokens('abc'), null);
});

// --- fixtures mirroring v06's tmp-file line()/call()/autoCompact() builders, as in-memory text ---
function line(o: unknown): string {
  return JSON.stringify(o) + '\n';
}
function call(t: number, extra?: unknown): string {
  return line(
    Object.assign(
      { type: 'assistant', isSidechain: false, message: { model: 'm', usage: { input_tokens: 10, cache_read_input_tokens: t - 10, cache_creation_input_tokens: 0 } } },
      extra,
    ),
  );
}
function autoCompact(pre: number): string {
  return line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: pre } });
}

test('fixed share = first main-thread call, skipping sidechain and synthetic lines', () => {
  const text =
    line({ type: 'user' }) +
    call(5000, { isSidechain: true }) +
    call(7000, { message: { model: '<synthetic>', usage: { input_tokens: 7000 } } }) +
    call(31000) +
    call(120000);
  assert.equal(firstCallTokensFromText(text), 31000);
});

test('profile order: config > this session > window env > history; unknown stays null', () => {
  const text = call(30000);
  const firstCallTokensValue = firstCallTokensFromText(text);
  assert.equal(firstCallTokensValue, 30000);
  const entries = [JSON.parse(autoCompact(250000))];
  const envWindow = '400000';
  const envPct = '70';

  assert.deepEqual(computeProfile({ cfgFixedTokens: undefined, firstCallTokensValue, cfgCompactAtTokens: 150000, entries, envWindow, envPct }), {
    fixed: 30000,
    threshold: 150000,
    source: 'config',
  });
  assert.equal(computeProfile({ firstCallTokensValue, entries, envWindow, envPct }).source, 'session');
  assert.deepEqual(computeProfile({ firstCallTokensValue, envWindow, envPct }), { fixed: 30000, threshold: 266000, source: 'window' });
  assert.equal(computeProfile({ firstCallTokensValue, cfgCompactWindowTokens: 1000000 }).threshold, 967000);
  const none = computeProfile({ firstCallTokensValue });
  assert.equal(none.threshold, null);
  assert.equal(hintLine(200000, 'ko', 'compact', {}, none), '');
  // transcript unreadable (missing file): register.ts passes firstCallTokensValue: null
  assert.equal(computeProfile({ firstCallTokensValue: null, envWindow, envPct }).fixed, null);
});

test('cacheIsFresh: served from cache inside a day, must recompute once stale', () => {
  const now = Date.now();
  assert.equal(cacheIsFresh(null, now), undefined);
  assert.equal(cacheIsFresh({ ts: now, threshold: 266646 }, now + 1000), 266646); // served from cache
  assert.equal(cacheIsFresh({ ts: now, threshold: 266646 }, now + 2 * 864e5), undefined); // cache expired
  assert.equal(cacheIsFresh({ ts: now, threshold: null }, now + 1000), null); // cached "unknown" is still fresh
});

test('pickNewestAutoCompact: newest file that has one wins, a settings change makes older points stale', () => {
  const old = autoCompact(967000);
  const nw = autoCompact(266646);
  const quiet = call(50000); // newest file, but no compaction in it
  // sorted newest-mtime-first: quiet, nw, old
  assert.equal(pickNewestAutoCompact([quiet, nw, old]), 266646);
  // nw's content changes (a settings change) and becomes the newest file again
  const nwUpdated = autoCompact(500000);
  assert.equal(pickNewestAutoCompact([nwUpdated, quiet, old]), 500000);
  // combined with computeProfile, as register.ts would do after recomputing history on a cache miss
  const p = computeProfile({ firstCallTokensValue: firstCallTokensFromText(quiet), historyThresholdValue: pickNewestAutoCompact([nwUpdated, quiet, old]) });
  assert.deepEqual(p, { fixed: 50000, threshold: 500000, source: 'history' });
  // no file has one at all
  assert.equal(pickNewestAutoCompact([quiet]), null);
});

test('a fixed share at or above the compaction point is inconsistent: no numbers', () => {
  const firstCallTokensValue = firstCallTokensFromText(call(300000));
  const p = computeProfile({ firstCallTokensValue, envWindow: '400000', envPct: '70' });
  assert.deepEqual(p, { fixed: null, threshold: null, source: 'inconsistent' });
});

test('another user (1M default, light setup) gets their own numbers, not the reference ones', () => {
  const light = { fixed: 25000, threshold: 967000 };
  const a = hintLine(400000, 'ko', 'compact', {}, light);
  assert.ok(a.startsWith('(예상)'), a); // reference profile says "past compaction" here
  assert.equal(hintLine(400000, 'ko', 'compact', {}, REF), '');
  assert.notEqual(hintLine(200000, 'ko', 'compact', {}, light), hintLine(200000, 'ko', 'compact', {}, REF));
});
