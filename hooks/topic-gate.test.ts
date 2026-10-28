// Ported from test/v04.test.js (decideTopicCheck/clearOffered/topicCheckMessage), test/v03.test.js
// (decide/message/sameTree), test/v03b.test.js (window-following decide, decideHint/hintMessage),
// and test/v06.test.js (hintMessage's embedded clear-savings estimate). The impure `run(raw)`
// orchestration (reads/writes topic-gate.json, reads the transcript tail, calls
// handoff.sessionFile/pace.appendEvent/pace.attributed) is NOT ported -- that is register.ts's job
// (desktop-only, unverified on this PC).
//
// `decideTopicCheck(tokens, cfg, user, offeredAt)`, `decideHint(tokens, cfg, user, hintAt)`, and
// `decide(info, cfg, user, rec)` all gained an explicit `user` param (split out of the old single
// merged `cfg` -- see pacer.ts's header). Per the established doubling convention, legacy 3-arg
// calls are ported as 4-arg calls with the same config object passed as both `cfg` and `user`.
// `hintMessage(lang, tokens, file, cfg, prof)` likewise gained trailing `cfg`/`prof` params with no
// default value, so every ported call supplies `{}, undefined` when no estimate is wanted.

import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { decideTopicCheck, isDesktopApp, clearOffered, topicCheckMessage, message, hintMessage, decideHint, sameTree, decide } from './core/topic-gate.ts';

test('decideTopicCheck: above gateAt every prompt, quiet after a clear offer until the context grows', () => {
  const c = { gateAtTokens: 200000 };
  assert.equal(decideTopicCheck(150000, c, c, null).check, false);
  assert.equal(decideTopicCheck(210000, c, c, null).check, true);
  assert.equal(decideTopicCheck(220000, c, c, null).check, true); // every prompt, no growth gate
  assert.equal(decideTopicCheck(250000, c, c, 210000).check, false); // offered at 210k
  assert.equal(decideTopicCheck(320000, c, c, 210000).check, true); // +100k
  assert.equal(decideTopicCheck(210000, c, c, 300000).offeredAt, null); // shrank: reset
  const off = { gateAtTokens: 200000, topicCheck: false };
  assert.equal(decideTopicCheck(250000, off, off, null).check, false);
});

test('clearOffered: detects a clear_session tool_use among recent assistant turns', () => {
  const offer = {
    type: 'assistant',
    isSidechain: false,
    message: { content: [{ type: 'tool_use', id: 't', name: 'mcp__ccd_turn__wrap_up', input: { actions: [{ message: '지금 세션 비워줘 (clear_session self)' }] } }] },
  };
  const noOffer = { type: 'assistant', isSidechain: false, message: { content: [] } };
  assert.equal(clearOffered([offer]), true);
  assert.equal(clearOffered([noOffer]), false);
});

test('topicCheckMessage: ko wording mentions the keep-going option', () => {
  assert.ok(topicCheckMessage('ko', 210000, 'H.md').includes('비우지 않기'));
});

test('decide: decide thresholds, idle or cwd change, regrowth', () => {
  const now = 1_800_000_000_000;
  const cfg = { boundary: true }; // gateAt defaults to 200000
  const base = { tokens: 420000, lastAssistantMs: now - 3 * 3600 * 1000, nowMs: now, cwd: 'C:\\A' };
  assert.equal(decide(base, cfg, cfg, undefined).gate, true);
  assert.equal(decide({ ...base, tokens: 150000 }, cfg, cfg, undefined).reason, 'below_threshold');
  assert.equal(decide({ ...base, lastAssistantMs: now - 600000 }, cfg, cfg, { cwd: 'C:\\A' }).reason, 'no_gap');
  const cw = decide({ ...base, lastAssistantMs: now - 600000 }, cfg, cfg, { cwd: 'C:\\B' });
  assert.equal(cw.gate, true);
  assert.equal(cw.cwdChanged, true);
  assert.equal(decide(base, cfg, cfg, { cwd: 'C:\\A', gatedAt: 420000 }).reason, 'renotify_suppressed');
  assert.equal(decide(base, cfg, cfg, { cwd: 'C:\\A', gatedAt: 300000 }).gate, true); // +100k
  assert.equal(decide(base, cfg, cfg, { cwd: 'C:\\A', gatedAt: 900000 }).gate, true); // shrank since
  const off = { ...cfg, topicGate: false };
  assert.equal(decide(base, off, off, undefined).gate, false);
});

test('message: wording and run() end to end (pure wording lines only)', () => {
  const ko = message('ko', 420000, 3 * 3600, false, 'P.claude.md');
  assert.ok(ko.includes('42만') && ko.includes('3시간') && ko.includes('P.claude.md') && ko.includes('무시'));
  assert.ok(message('en', 420000, 3 * 3600, false, 'P').includes('420k, 3h idle'));
});

test('sameTree: parent/child folder counts as the same project', () => {
  assert.equal(sameTree('C:\\Projects', 'C:\\Projects\\misc\\app'), true);
  assert.equal(sameTree('c:/projects/misc/', 'C:\\Projects'), true);
  assert.equal(sameTree('C:\\Projects', 'C:\\Other'), false);
  assert.equal(sameTree('C:\\Projects', 'C:\\ProjectsX'), false);
});

test('decide: follows compactWindowTokens scaling for gateAt', () => {
  const info = { tokens: 160000, lastAssistantMs: 0, nowMs: 1, cwd: 'a' };
  const cfg300 = { compactWindowTokens: 300000 }; // gateAt 150k
  assert.equal(decide(info, cfg300, cfg300, { cwd: 'b' }).gate, true);
  const cfg600 = { compactWindowTokens: 600000 }; // gateAt 300k
  assert.equal(decide(info, cfg600, cfg600, { cwd: 'b' }).gate, false);
});

test('decideHint/hintMessage: threshold, once per growth, reset after compact, one-click clear wording', () => {
  const c = { compactWindowTokens: 400000 }; // compactAt 160k
  assert.equal(decideHint(150000, c, c, null).hint, false);
  const a = decideHint(170000, c, c, null);
  assert.equal(a.hint, true);
  assert.equal(decideHint(200000, c, c, a.hintAt).hint, false);
  assert.equal(decideHint(280000, c, c, a.hintAt).hint, true);
  assert.equal(decideHint(90000, c, c, 280000).hintAt, null); // compacted
  const off = { inlineCompactHint: false };
  assert.equal(decideHint(170000, off, off, null).hint, false);
  const ko = hintMessage('ko', 241000, 'H.claude.md', {}, undefined);
  assert.ok(ko.includes('24.1만') && ko.includes('clear_session self') && ko.includes('H.claude.md'));
  assert.ok(hintMessage('en', 241000, 'H.claude.md', {}, undefined).includes('241k'));
});

test('hintMessage: embeds both the compact and clear estimates when a profile is supplied', () => {
  const REF = { fixed: 90000, threshold: 266600 };
  const withCard = hintMessage('ko', 200000, 'f.md', {}, REF);
  assert.ok(withCard.includes('(예상) 지금 압축하면'));
  assert.ok(withCard.includes('(예상) 지금 비우면'));
  assert.ok(!hintMessage('ko', 400000, 'f.md', {}, REF).includes('(예상)'));
});

// Ported from test/v04.test.js (0.4.5 step threshold; TS signature adds `user` before offeredAt).
test('decideTopicCheck 0.4.5: after a line, wait for topicCheckStepTokens (50k) of growth', () => {
  const c = { gateAtTokens: 200000 };
  assert.equal(decideTopicCheck(210000, c, c, null, null).checkedAt, 210000);
  assert.equal(decideTopicCheck(240000, c, c, null, 210000).check, false);
  assert.equal(decideTopicCheck(240000, c, c, null, 210000).checkedAt, 210000);
  assert.equal(decideTopicCheck(260000, c, c, null, 210000).check, true);
  assert.equal(decideTopicCheck(205000, c, c, null, 300000).check, true); // shrank (compact): start over
  const zero = Object.assign({ topicCheckStepTokens: 0 }, c);
  assert.equal(decideTopicCheck(215000, zero, zero, null, 210000).check, true); // 0 = every prompt
});

// Ported from test/app-card.test.js.
test('isDesktopApp: only claude-desktop', () => {
  assert.strictEqual(isDesktopApp({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), true);
  for (const v of ['cli', 'claude-vscode', 'sdk-ts', '']) assert.strictEqual(isDesktopApp({ CLAUDE_CODE_ENTRYPOINT: v }), false, v);
  assert.strictEqual(isDesktopApp({}), false);
});

test('app wording: card only, no paste-line instruction (ko and en)', () => {
  for (const lang of ['ko', 'en']) {
    const hint = hintMessage(lang, 200000, 'f.md', {}, undefined, true);
    assert.ok(hint.includes('clear_session self'), lang);
    assert.ok(!/붙여 넣을|one line the user can paste/.test(hint), lang);
    const tc = topicCheckMessage(lang, 210000, 'H.md', true);
    assert.ok(tc.includes('clear_session self') && !/CLI/.test(tc), lang);
    const g = message(lang, 210000, 7200, false, 'H.md', true);
    assert.ok(g.includes('clear_session self') && !/CLI/.test(g), lang);
  }
});

test('non-app wording unchanged: still offers the paste line', () => {
  assert.ok(hintMessage('ko', 200000, 'f.md', {}, undefined).includes('붙여 넣을 한 줄'));
  assert.ok(hintMessage('en', 200000, 'f.md', {}, undefined, false).includes('one line the user can paste'));
  assert.ok(topicCheckMessage('ko', 210000, 'H.md').includes('CLI: /clear 안내'));
});

// Parity with scripts/topic-gate.js (exact app wording).
test('app wording is byte-identical to scripts/topic-gate.js', () => {
  const js = createRequire(import.meta.url)('../scripts/topic-gate.js');
  for (const lang of ['ko', 'en']) {
    assert.equal(topicCheckMessage(lang, 210000, 'H.md', true), js.topicCheckMessage(lang, 210000, 'H.md', true));
    assert.equal(message(lang, 210000, 7200, false, 'H.md', true), js.message(lang, 210000, 7200, false, 'H.md', true));
    assert.equal(message(lang, 210000, 7200, true, 'H.md', true), js.message(lang, 210000, 7200, true, 'H.md', true));
    assert.equal(hintMessage(lang, 200000, 'f.md', {}, undefined, true), js.hintMessage(lang, 200000, 'f.md', {}, undefined, true));
    assert.equal(hintMessage(lang, 200000, 'f.md', {}, undefined), js.hintMessage(lang, 200000, 'f.md', {}, undefined));
  }
});
