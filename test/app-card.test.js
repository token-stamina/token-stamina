'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// Desktop app (CLAUDE_CODE_ENTRYPOINT=claude-desktop): hook text asks for a card only, never a chat paste line.
const test = require('node:test');
const assert = require('node:assert');
const gate = require('../scripts/topic-gate');

test('isDesktopApp: only claude-desktop', () => {
  assert.strictEqual(gate.isDesktopApp({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), true);
  for (const v of ['cli', 'claude-vscode', 'sdk-ts', '']) assert.strictEqual(gate.isDesktopApp({ CLAUDE_CODE_ENTRYPOINT: v }), false, v);
  assert.strictEqual(gate.isDesktopApp({}), false);
});

test('app wording: card only, no paste-line instruction (ko and en)', () => {
  for (const lang of ['ko', 'en']) {
    const hint = gate.hintMessage(lang, 200000, 'f.md', {}, undefined, true);
    assert.ok(hint.includes('clear_session self'), lang);
    assert.ok(!/붙여 넣을|one line the user can paste/.test(hint), lang);
    const tc = gate.topicCheckMessage(lang, 210000, 'H.md', true);
    assert.ok(tc.includes('clear_session self') && !/CLI/.test(tc), lang);
    const g = gate.message(lang, 210000, 7200, false, 'H.md', true);
    assert.ok(g.includes('clear_session self') && !/CLI/.test(g), lang);
  }
});

test('non-app wording unchanged: still offers the paste line', () => {
  assert.ok(gate.hintMessage('ko', 200000, 'f.md', {}).includes('붙여 넣을 한 줄'));
  assert.ok(gate.hintMessage('en', 200000, 'f.md', {}, undefined, false).includes('one line the user can paste'));
  assert.ok(gate.topicCheckMessage('ko', 210000, 'H.md').includes('CLI: /clear 안내'));
});
