// Ported from test/v02.test.js (analyze/decide/message/commitSubject fixtures), test/v03.test.js
// (v0.3 wording), test/v03b.test.js (window-following decide), test/v06.test.js (estimate tail
// embedded via the `cfg, prof` params added for the clear-savings hint), and test/v07.test.js
// (ja/zh wording). The impure `run(raw)` orchestration test (tails a real file, emits
// systemMessage, dedups per session) is NOT ported -- that is register.ts's job (desktop-only,
// unverified on this PC).
//
// `message(res, lang, level, cfg, prof)`: `cfg` and `prof` are positionally required in the new
// signature (no default values), even though their types permit `undefined` -- so every ported
// call that doesn't care about the estimate tail passes `{}, undefined` explicitly for the last
// two args. Likewise `decide(res, cfg, user, last)` gained an explicit `user` param (split out of
// the old single merged `cfg`); per the established doubling convention, legacy calls that passed
// one merged config object are ported as `decide(res, cfg, cfg, last)`.

import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { analyze, decide, message, commitSubject, type AnalyzeResult } from './core/boundary.ts';

const cfg = { boundary: true };

const asst = (content: any[], usage: any, extra?: any) =>
  Object.assign({ type: 'assistant', isSidechain: false, message: { model: 'm', role: 'assistant', content, usage } }, extra);
const prompt = (t?: string) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: t || 'do it' } });
const toolUse = (name: string, input: any, id?: string) => ({ type: 'tool_use', id: id || 'tu_' + Math.random(), name, input });
const text = (t: string) => ({ type: 'text', text: t });
const u = (n: number) => ({ input_tokens: 10, cache_read_input_tokens: n - 30, cache_creation_input_tokens: 20, output_tokens: 5 });
const commitCall = (msg: string) => toolUse('Bash', { command: `git commit -m "${msg}"` }, 'c1');

test('analyze: context tokens come from last main assistant message, sidechain ignored', () => {
  const r = analyze([prompt(), asst([text('a')], u(120000)), asst([text('b')], u(999999), { isSidechain: true }), asst([text('c')], u(190000))]);
  assert.equal(r.tokens, 190000);
});

test('analyze/decide: commit in this turn => boundary; earlier turn commit does not count', () => {
  const old = analyze([prompt('first'), asst([commitCall('old')], u(200000)), prompt('second'), asst([toolUse('Read', {})], u(200000)), asst([text('done')], u(200000))]);
  assert.equal(old.commitCount, 0);
  assert.equal(decide(old, cfg, cfg, undefined).notify, false);
  const cur = analyze([prompt(), asst([commitCall('feat: x')], u(200000)), asst([text('done')], u(200000))]);
  assert.deepEqual(cur.commits, ['feat: x']);
  assert.equal(decide(cur, cfg, cfg, undefined).kind, 'commit');
});

test('decide: edit counts only when the turn ends with an answer', () => {
  const ended = analyze([prompt(), asst([toolUse('Edit', {})], u(200000)), asst([text('done')], u(200000))]);
  assert.equal(decide(ended, cfg, cfg, undefined).kind, 'edit');
  const midTool = analyze([prompt(), asst([text('x'), toolUse('Write', {})], u(200000))]);
  assert.equal(decide(midTool, cfg, cfg, undefined).notify, false);
  const none = analyze([prompt(), asst([text('just talk')], u(200000))]);
  assert.equal(decide(none, cfg, cfg, undefined).reason, 'not_boundary');
});

test('decide: below threshold, no prompt in tail, failed commit => silent', () => {
  const low = analyze([prompt(), asst([commitCall('x')], u(100000)), asst([text('ok')], u(100000))]);
  assert.equal(decide(low, cfg, cfg, undefined).reason, 'below_threshold');
  const noTurn = analyze([asst([commitCall('x')], u(200000)), asst([text('ok')], u(200000))]);
  assert.equal(decide(noTurn, cfg, cfg, undefined).reason, 'no_turn');
  const failed = analyze([
    prompt(),
    asst([commitCall('x')], u(200000)),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'nothing to commit' }] } },
    asst([text('failed')], u(200000)),
  ]);
  assert.equal(failed.commitCount, 0);
});

test('decide: renotify only after growth; shrink (compact) resets', () => {
  const r = analyze([prompt(), asst([commitCall('x')], u(200000)), asst([text('ok')], u(200000))]);
  assert.equal(decide(r, cfg, cfg, 200000).reason, 'renotify_suppressed');
  assert.equal(decide(r, cfg, cfg, 150000).reason, 'renotify_suppressed'); // +50k < 100k
  assert.equal(decide(r, cfg, cfg, 100000).notify, true); // +100k
  assert.equal(decide(r, cfg, cfg, 300000).notify, true); // context shrank since: start over
});

test('message: wording, max 2 commit subjects, new-session level', () => {
  const r = analyze([
    prompt(),
    asst(
      [
        toolUse('PowerShell', { command: 'git commit -m "feat: a"' }, 'a'),
        toolUse('Bash', { command: "git -C x commit -m 'fix: b'" }, 'b'),
        toolUse('Bash', { command: 'git commit -m "third"' }, 'c'),
      ],
      u(190000),
    ),
    asst([text('ok')], u(190000)),
  ]);
  assert.deepEqual(r.commits, ['feat: a', 'fix: b']);
  const ko = message(r, 'ko', 'compact', {}, undefined);
  assert.ok(ko.includes('컨텍스트 19만 토큰') && ko.includes('/compact feat: a · fix: b') && !ko.includes('<'));
  assert.ok(message(r, 'en', 'compact', {}, undefined).includes('190k'));
  assert.equal(decide(Object.assign({}, r, { tokens: 420000 }), cfg, cfg, undefined).level, 'new_session');
  assert.ok(message(Object.assign({}, r, { tokens: 420000, commits: [] }), 'ko', 'new_session', {}, undefined).includes('새 세션 권장'));
  assert.ok(message(Object.assign({}, r, { commits: [] }), 'ko', 'compact', {}, undefined).includes('(남길 결정·남은 일)'));
  const heredoc = "git commit -m \"$(cat <<'EOF'\nfeat: heredoc subject\n\nbody\nEOF\n)\"";
  assert.equal(commitSubject(heredoc), 'feat: heredoc subject');
});

test('message: v0.3 wording — plain /compact mention, /clear for new session', () => {
  const r = { tokens: 190000, turnFound: true, commitCount: 0, commits: [], edited: false, endsWithAnswer: true } as AnalyzeResult;
  assert.ok(message(r, 'ko', 'compact', {}, undefined).includes('그냥 /compact 만 쳐도 돼요'));
  assert.ok(message(r, 'ko', 'new_session', {}, undefined).includes('/clear 뒤에도'));
  assert.ok(message(r, 'en', 'compact', {}, undefined).includes('Plain /compact'));
});

test('decide: follows compactWindowTokens scaling for compactAt/newAt', () => {
  const res = { tokens: 200000, turnFound: true, commitCount: 1, commits: [], edited: false, endsWithAnswer: true } as AnalyzeResult;
  const cfg600 = { compactWindowTokens: 600000, boundary: true }; // compactAt 240k
  assert.equal(decide(res, cfg600, cfg600, undefined).reason, 'below_threshold');
  const cfg300 = { compactWindowTokens: 300000, boundary: true }; // compactAt 120k
  assert.equal(decide(res, cfg300, cfg300, undefined).notify, true);
  assert.equal(decide(Object.assign({}, res, { tokens: 290000 }), cfg300, cfg300, undefined).level, 'new_session'); // >= 285k
});

test('message: embeds the clear-savings estimate only when a profile is supplied and under threshold', () => {
  const REF = { fixed: 90000, threshold: 266600 };
  assert.ok(message({ tokens: 200000, commits: [] } as any, 'ko', 'compact', {}, REF).includes('(예상)'));
  assert.ok(!message({ tokens: 90000, commits: [] } as any, 'ko', 'compact', {}, REF).includes('(예상)'));
  assert.ok(!message({ tokens: 200000, commits: [] } as any, 'ko', 'compact', {}, undefined).includes('(예상)'));
});

test('message: ja/zh wording, other languages fall back to en', () => {
  const res = { tokens: 200000, commits: [] } as any;
  const ja = message(res, 'ja', 'compact', {}, undefined);
  assert.ok(ja.includes('/compact のしどき') && ja.includes('20万'), ja);
  assert.ok(message(res, 'zh', 'compact', {}, undefined).startsWith('Token Stamina: context is 200k'));
});
