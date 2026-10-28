// Ported from test/v03.test.js's handoff fixtures. Most legacy handoff tests exercise impure
// fs-backed orchestration (`runStop`/`runStart`/`pick`/`dirOf`/`sessionFile`/`latestFile`/`prune`)
// that is NOT ported here -- that is register.ts's job (desktop-only, unverified on this PC; see
// handoff.ts's header for the exact pure/impure split).
//
// What IS a direct port:
//   - `handoff.scan(boundary.readTail(f, ...))` (line 36-44) -> `scan(entries)`. The legacy test
//     read a real transcript file via `boundary.readTail`; this port constructs the already-parsed
//     `entries` array directly (the same shape `transcript()`'s helpers built before writing it to
//     disk), since `scan()`'s pure core takes parsed entries, not a file path.
//   - `handoff.additionalContext(p)` (line 105) -> `additionalContext(p)`, unchanged.
//   - The "Claude-written note wins only when newer than the last user prompt" (line 93-109) and
//     "after /clear only a fresh Claude-written note is restored" (line 157-169) tests exercised
//     `handoff.pick(...)`, which internally read the four candidate files via fs and called the
//     (now-named) `tryPairPure`/`pickFromData` logic. This port reconstructs the same scenarios
//     directly against `pickFromData`, passing in already-"read" text/mtime data instead of having
//     it hit the filesystem -- same convention as agent-model.ts's `definitionHasModel` injection.
//
// `cwdHash`/`safeId`/`sessionFileName`/`latestFileName`/`clip`/`render`/`renderCapped`/`parseMeta`/
// `stripMeta`/`accumulate`/`buildMeta` have no standalone legacy fixture (only exercised indirectly
// inside `runStop`/`runStart`/`pick`) -- tested here directly against their own documented
// behavior, same convention as lang.test.ts's 'isAuto/withLang'.

import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import {
  TAIL_BYTES, KEEP_SEC, FALLBACK_MAX_AGE_SEC, CLEAR_MAX_AGE_SEC, HEADER,
  cwdHash, safeId, sessionFileName, latestFileName, promptText, scan, clip,
  render, renderCapped, parseMeta, stripMeta, accumulate, buildMeta,
  pickFromData, additionalContext, type NotePairFetch, type ScanResult,
} from './core/handoff.ts';

const asst = (content: unknown, extra?: unknown) => Object.assign({ type: 'assistant', isSidechain: false, message: { model: 'm', role: 'assistant', content } }, extra);
const userPrompt = (t: string, ts: string) => ({ type: 'user', isSidechain: false, timestamp: ts, message: { role: 'user', content: t } });
const tu = (name: string, input: unknown, id?: string) => ({ type: 'tool_use', id: id || 'tu_' + Math.random(), name, input });
const text = (t: string) => ({ type: 'text', text: t });

test('constants unchanged', () => {
  assert.equal(TAIL_BYTES, 512 * 1024);
  assert.equal(KEEP_SEC, 7 * 86400);
  assert.equal(FALLBACK_MAX_AGE_SEC, 86400);
  assert.equal(CLEAR_MAX_AGE_SEC, 3600);
  assert.equal(HEADER, 'Token Stamina handoff (auto-saved before compact/clear)');
});

test('scan: extracts prompts, commits, files, todos', () => {
  const entries = [
    userPrompt('first request', '2026-10-23T10:00:00Z'), asst([tu('Edit', { file_path: 'C:\\a.js' })]),
    userPrompt('second ' + 'x'.repeat(400), '2026-10-23T10:05:00Z'),
    asst([
      tu('Bash', { command: 'git commit -m "feat: one"' }, 'k1'),
      tu('Write', { file_path: 'C:\\b.js' }),
      tu('TodoWrite', { todos: [{ content: 'step A', status: 'completed' }, { content: 'step B', status: 'pending' }] }),
    ]),
    userPrompt('third request', '2026-10-23T10:10:00Z'), asst([text('done')], { timestamp: '2026-10-23T10:11:00Z' }),
  ];
  const s = scan(entries);
  assert.equal(s.prompts.length, 3);
  assert.deepEqual(s.commits.map((c) => c.s), ['feat: one']);
  assert.deepEqual(s.files, ['C:\\a.js', 'C:\\b.js']);
  assert.equal(s.todos?.length, 2);
  assert.equal(s.lastPromptTs, '2026-10-23T10:10:00Z');
});

test('scan: skips sidechain entries, failed tool calls, and system-reminder/command prompts', () => {
  const s = scan([
    Object.assign(userPrompt('from a subagent', '2026-10-23T10:00:00Z'), { isSidechain: true }),
    userPrompt('<system-reminder>ignore me</system-reminder>', '2026-10-23T10:01:00Z'),
    { type: 'user', isSidechain: false, message: { content: [{ type: 'tool_result', tool_use_id: 'k2', is_error: true }] } },
    asst([tu('Bash', { command: 'git commit -m "should not count"' }, 'k2')]),
  ]);
  assert.equal(s.prompts.length, 0);
  assert.equal(s.commits.length, 0);
});

test('promptText: joins text blocks, collapses whitespace, trims', () => {
  assert.equal(promptText({ message: { content: 'plain   string\n text' } }), 'plain string text');
  assert.equal(promptText({ message: { content: [{ type: 'text', text: ' a ' }, { type: 'image' }, { type: 'text', text: 'b' }] } }), 'a b');
});

test('cwdHash: stable, case-insensitive, 12 hex chars', () => {
  assert.equal(cwdHash('C:\\Work'), cwdHash('c:\\work'));
  assert.equal(cwdHash('C:\\Work').length, 12);
  assert.ok(/^[0-9a-f]{12}$/.test(cwdHash('C:\\Work')));
  assert.notEqual(cwdHash('C:\\Work'), cwdHash('C:\\Other'));
});

test('safeId: strips anything outside [A-Za-z0-9_-]; falls back to "unknown"', () => {
  assert.equal(safeId('sess-1'), 'sess-1');
  assert.equal(safeId('a/b c'), 'a_b_c');
  assert.equal(safeId(undefined), 'unknown');
  assert.equal(safeId(''), 'unknown');
});

test('sessionFileName/latestFileName: plain joins, .claude.md suffix when requested', () => {
  assert.equal(sessionFileName('C:\\home\\handoff', 'sess-1'), 'C:\\home\\handoff/sess-1.md');
  assert.equal(sessionFileName('C:\\home\\handoff', 'sess-1', true), 'C:\\home\\handoff/sess-1.claude.md');
  const h = cwdHash('C:\\Work');
  assert.equal(latestFileName('C:\\home\\handoff', 'C:\\Work'), `C:\\home\\handoff/latest-${h}.md`);
  assert.equal(latestFileName('C:\\home\\handoff', 'C:\\Work', true), `C:\\home\\handoff/latest-${h}.claude.md`);
});

test('clip: leaves short text alone, truncates long text with an ellipsis', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('a'.repeat(10), 5), 'aa...');
});

test('render: includes cwd/saved and the requested sections only when non-empty', () => {
  const meta = { session: 's1', cwd: 'C:\\Work', saved: '2026-10-23T10:00:00.000Z', lastPromptTs: '2026-10-23T10:10:00Z', prompts: ['hi'], commits: [{ id: 'k1', s: 'feat: one' }], files: ['C:\\a.js'], todos: [{ status: 'pending', content: 'step B' }] };
  const p = { promptLen: 200, nCommits: 20, nFiles: 15, nTodos: 20 };
  const md = render(meta, p);
  assert.ok(md.startsWith(`<!-- token-stamina-handoff session=s1 lastPromptTs=2026-10-23T10:10:00Z saved=2026-10-23T10:00:00.000Z -->\n`));
  assert.ok(md.includes('- cwd: C:\\Work') && md.includes('feat: one') && md.includes('[pending] step B') && md.includes('C:\\a.js'));
  const empty = render({ session: 's2', saved: 'x', prompts: [], commits: [], files: [], todos: null }, p);
  assert.ok(!empty.includes('## Last user requests') && !empty.includes('## Commits') && !empty.includes('## Files') && !empty.includes('## Latest todo'));
});

test('renderCapped: shrinks step by step, then hard-cuts, to stay under the token cap', () => {
  const manyFiles = Array.from({ length: 80 }, (_, i) => `C:\\very\\long\\path\\number\\${i}\\file.js`);
  const meta = { session: 'sess-cap', cwd: 'C:\\Cap', saved: new Date().toISOString(), lastPromptTs: null, prompts: ['p'], commits: [], files: manyFiles, todos: null };
  const md = renderCapped(meta, 120);
  // estimateTokens ~ chars/4; renderCapped guarantees the final text respects that estimate
  // (after shrinking, or a hard truncation to maxTokens*3 chars as a last resort).
  assert.ok(md.length <= 120 * 3 + 40, md.length.toString());
});

test('parseMeta/stripMeta: round-trips the HTML-comment header written by render()', () => {
  const md = render({ session: 'sess-1', saved: '2026-10-23T10:00:00.000Z', lastPromptTs: '2026-10-23T10:10:00Z', prompts: [], commits: [], files: [], todos: null }, { promptLen: 200, nCommits: 20, nFiles: 15, nTodos: 20 });
  const meta = parseMeta(md);
  assert.equal(meta?.session, 'sess-1');
  assert.equal(meta?.lastPromptTs, Date.parse('2026-10-23T10:10:00Z'));
  assert.equal(meta?.saved, Date.parse('2026-10-23T10:00:00.000Z'));
  assert.equal(parseMeta(null), null);
  assert.equal(parseMeta('no comment here'), null);
  assert.ok(!stripMeta(md).includes('<!--'));
  assert.ok(stripMeta(md).startsWith('# Handoff note'));
});

test('accumulate: merges new commits/files into the running session total, dedupes by id, caps at 40', () => {
  const acc = { commits: [{ id: 'k1', s: 'feat: one' }], files: ['C:\\a.js'] };
  const sc: ScanResult = { prompts: [], commits: [{ id: 'k1', s: 'feat: one (dup)' }, { id: 'k2', s: 'feat: two' }], files: ['C:\\a.js', 'C:\\b.js'], todos: null, lastPromptTs: null };
  const next = accumulate(acc, sc);
  assert.deepEqual(next.commits.map((c) => c.id), ['k1', 'k2']); // id dedup wins, duplicate dropped
  assert.deepEqual(next.files, ['C:\\a.js', 'C:\\b.js']); // re-touched files are dropped from the old list, then re-appended in sc.files order
  const big = { commits: Array.from({ length: 40 }, (_, i) => ({ id: 'c' + i, s: 's' + i })), files: [] };
  const grown = accumulate(big, { prompts: [], commits: [{ id: 'cNEW', s: 'new' }], files: [], todos: null, lastPromptTs: null });
  assert.equal(grown.commits.length, 40);
  assert.equal(grown.commits[grown.commits.length - 1].id, 'cNEW');
});

test('buildMeta: assembles the render-ready meta object from a scan + accumulated totals', () => {
  const sc: ScanResult = { prompts: ['hi'], commits: [], files: [], todos: null, lastPromptTs: '2026-10-23T10:10:00Z' };
  const acc = { commits: [{ id: 'k1', s: 'feat: one' }], files: ['C:\\a.js'] };
  const now = Date.parse('2026-10-23T11:00:00.000Z');
  const m = buildMeta('sess-1', 'C:\\Work', now, sc, acc);
  assert.deepEqual(m, { session: 'sess-1', cwd: 'C:\\Work', saved: new Date(now).toISOString(), lastPromptTs: '2026-10-23T10:10:00Z', prompts: ['hi'], commits: acc.commits, files: acc.files, todos: null });
});

test('additionalContext: prefixes the header and strips the meta comment', () => {
  const md = render({ session: 's1', saved: 'x', lastPromptTs: null, prompts: [], commits: [], files: [], todos: null }, { promptLen: 200, nCommits: 20, nFiles: 15, nTodos: 20 });
  const ctx = additionalContext({ text: md });
  assert.ok(ctx.startsWith(HEADER + '\n'));
  assert.ok(!ctx.includes('<!--'));
});

// --- pickFromData: reconstructs test/v03.test.js's handoff.pick() scenarios (lines 93-109,
// 157-169) by passing already-"read" candidate text/mtimes directly instead of hitting fs. ---

const noNote: NotePairFetch = { autoFile: 'auto.md', claudeFile: 'auto.claude.md', autoText: null, claudeText: null, autoMtimeMs: null, claudeMtimeMs: null };
const lastPromptTs = Date.parse('2026-10-23T10:10:00Z');
function autoNote(lastPromptTsStr: string | null): string {
  return `<!-- token-stamina-handoff session=sess-c lastPromptTs=${lastPromptTsStr || ''} saved=2026-10-23T10:11:00.000Z -->\n# Handoff note\nbody`;
}

test('pickFromData: own auto note wins when there is no Claude-written counterpart', () => {
  const own: NotePairFetch = { autoFile: 'a.md', claudeFile: 'a.claude.md', autoText: autoNote('2026-10-23T10:10:00Z'), claudeText: null, autoMtimeMs: Date.now(), claudeMtimeMs: null };
  const r = pickFromData('sess-c', 'compact', own, noNote, null, Date.now());
  assert.equal(r?.kind, 'auto');
  assert.equal(r?.fallback, false);
  assert.equal(r?.from, 'sess-c');
});

test('pickFromData: Claude note older than the last user prompt is stale -- falls back to the auto note', () => {
  const now = Date.now();
  const own: NotePairFetch = {
    autoFile: 'a.md', claudeFile: 'a.claude.md',
    autoText: autoNote('2026-10-23T10:10:00Z'), claudeText: '# Rich note from Claude\nkeep X',
    autoMtimeMs: now, claudeMtimeMs: Date.parse('2026-10-23T09:00:00Z'), // before the last prompt (10:10)
  };
  const r = pickFromData('sess-c', 'compact', own, noNote, null, now);
  assert.equal(r?.kind, 'auto');
});

test('pickFromData: Claude note newer than the last user prompt wins', () => {
  const now = Date.now();
  const own: NotePairFetch = {
    autoFile: 'a.md', claudeFile: 'a.claude.md',
    autoText: autoNote('2026-10-23T10:10:00Z'), claudeText: '# Rich note from Claude\nkeep X',
    autoMtimeMs: now, claudeMtimeMs: Date.parse('2026-10-23T10:30:00Z'), // after the last prompt
  };
  const r = pickFromData('sess-c', 'compact', own, noNote, null, now);
  assert.equal(r?.kind, 'claude');
  assert.ok(r && additionalContext(r).includes('keep X'));
});

test('pickFromData: source="clear" with no Claude-written note anywhere (own or fallback) -> null', () => {
  const now = Date.parse('2026-10-23T10:40:00Z');
  const own: NotePairFetch = { autoFile: 'a.md', claudeFile: 'a.claude.md', autoText: autoNote('2026-10-23T10:10:00Z'), claudeText: null, autoMtimeMs: now, claudeMtimeMs: null };
  const latest: NotePairFetch = { autoFile: 'l.md', claudeFile: 'l.claude.md', autoText: autoNote('2026-10-23T10:10:00Z'), claudeText: null, autoMtimeMs: now, claudeMtimeMs: null };
  assert.equal(pickFromData('sess-new', 'clear', noNote, latest, null, now), null); // no own note at all
  assert.equal(pickFromData('sess-clr', 'clear', own, latest, null, now), null); // own note exists but is auto-only
  // the same own pair with source="compact" (not clear) does restore the auto note
  assert.equal(pickFromData('sess-clr', 'compact', own, latest, null, now)?.kind, 'auto');
});

test('pickFromData: source="clear" restores a fresh own Claude note within CLEAR_MAX_AGE_SEC, not once it ages past it', () => {
  const claudeMtimeMs = Date.parse('2026-10-23T10:30:00Z');
  const own = (nowOffsetMs: number): NotePairFetch => ({
    autoFile: 'a.md', claudeFile: 'a.claude.md', autoText: autoNote('2026-10-23T10:10:00Z'),
    claudeText: '# Claude note\nnext: Y', autoMtimeMs: claudeMtimeMs, claudeMtimeMs,
  });
  const now1 = Date.parse('2026-10-23T10:40:00Z'); // 10 min after the claude note: within 1h
  assert.equal(pickFromData('sess-clr', 'clear', own(0), noNote, null, now1)?.kind, 'claude');
  const now2 = now1 + 2 * 3600 * 1000; // +2h: now 2h10m after the claude note, past CLEAR_MAX_AGE_SEC
  assert.equal(pickFromData('sess-clr', 'clear', own(0), noNote, null, now2), null);
});

test('pickFromData: falls back to the latest-<cwdhash> pair when there is no own note at all', () => {
  const now = Date.now();
  const latestAuto: NotePairFetch = { autoFile: 'l.md', claudeFile: 'l.claude.md', autoText: autoNote('2026-10-23T10:10:00Z'), claudeText: null, autoMtimeMs: now, claudeMtimeMs: null };
  const r = pickFromData('brand-new', 'compact', noNote, latestAuto, null, now);
  assert.equal(r?.kind, 'auto');
  assert.equal(r?.fallback, true);
  assert.equal(r?.from, 'sess-c'); // the session recorded in the auto note's own meta comment

  const latestClaude: NotePairFetch = { autoFile: 'l.md', claudeFile: 'l.claude.md', autoText: null, claudeText: '# note', autoMtimeMs: null, claudeMtimeMs: now };
  const rc = pickFromData('brand-new', 'compact', noNote, latestClaude, '  sess-origin  \n', now);
  assert.equal(rc?.kind, 'claude');
  assert.equal(rc?.from, 'sess-origin'); // from the .from sidecar, trimmed
});

test('pickFromData: fallback respects FALLBACK_MAX_AGE_SEC', () => {
  const now = Date.now();
  const latestAuto: NotePairFetch = { autoFile: 'l.md', claudeFile: 'l.claude.md', autoText: autoNote(null), claudeText: null, autoMtimeMs: now - (FALLBACK_MAX_AGE_SEC + 10) * 1000, claudeMtimeMs: null };
  assert.equal(pickFromData('brand-new', 'compact', noNote, latestAuto, null, now), null);
});
