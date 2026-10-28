// Ported from test/v09.test.js's isOurCommand/classify/decide fixtures (lines 21-74). The legacy
// `classify(settingsPath)` reads settings.json via node:fs; this port's pure core is
// `classifyText(raw, readErrorCode)`, which takes the already-attempted read's outcome (text, or a
// read-error code when the read failed) as explicit parameters instead of touching the filesystem --
// so every legacy `classify(settingsFile(...))` call is ported as a direct `classifyText(json, null)`
// call, and the "no settings.json at all" case is ported as `classifyText(null, 'ENOENT')`.
//
// NOT ported: v09's `run(...)` tests (lines 76-125) exercise the impure SessionStart orchestration
// (reads stdin, lang.withLang(pace.loadConfig()), cfg.setupNudge gate, reads/writes the global
// "shown" flag file, appends an event, formats the final hookSpecificOutput via pace.attributed) --
// that is register.ts's `classic.SessionStart` handler's job (desktop-only, unverified on this PC).
// `classify()` itself (the impure node:fs wrapper) and `flagFileName()`/`defaultSettingsPath()` (pure
// path builders with no standalone legacy fixture) are exercised only indirectly/not at all here, by
// the same convention used for agent-model.ts's `definitionHasModel`.

import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { isOurCommand, classifyText, decide, message, flagFileName, defaultSettingsPath } from './core/setup-nudge.ts';

test('isOurCommand: matches the literal ${CLAUDE_PLUGIN_ROOT} template written by /token-stamina:setup', () => {
  assert.ok(isOurCommand('node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js"'));
  assert.ok(isOurCommand('node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js"'.toUpperCase()));
});

test('isOurCommand: matches an already-resolved path containing the product name', () => {
  assert.ok(isOurCommand('node "/home/u/.claude/plugins/token-stamina/scripts/statusline.js"'));
});

test("isOurCommand: false for someone else's status line, or no command at all", () => {
  assert.ok(!isOurCommand('node /home/u/some-other-plugin/statusline.js'));
  assert.ok(!isOurCommand('npx ccusage statusline'));
  assert.ok(!isOurCommand(undefined));
  assert.ok(!isOurCommand(42));
});

test('classifyText: no settings.json at all (ENOENT) -> other (eligible)', () => {
  assert.strictEqual(classifyText(null, 'ENOENT'), 'other');
});

test('classifyText: a read failure other than ENOENT never nags on a detection gap', () => {
  assert.strictEqual(classifyText(null, 'EACCES'), 'ambiguous');
  assert.strictEqual(classifyText(undefined, undefined), 'ambiguous');
});

test('classifyText: settings.json with no statusLine key -> other', () => {
  assert.strictEqual(classifyText(JSON.stringify({ permissions: {} })), 'other');
});

test('classifyText: statusLine is ours -> ours', () => {
  const raw = JSON.stringify({ statusLine: { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js"' } });
  assert.strictEqual(classifyText(raw), 'ours');
});

test("classifyText: statusLine is someone else's -> other", () => {
  const raw = JSON.stringify({ statusLine: { type: 'command', command: 'npx ccusage statusline' } });
  assert.strictEqual(classifyText(raw), 'other');
});

test('classifyText: corrupt JSON -> ambiguous, never nags on a detection gap', () => {
  assert.strictEqual(classifyText('{not json'), 'ambiguous');
});

test('classifyText: statusLine present but shape is unexpected -> ambiguous', () => {
  assert.strictEqual(classifyText(JSON.stringify({ statusLine: 'just a string' })), 'ambiguous');
  assert.strictEqual(classifyText(JSON.stringify({ statusLine: {} })), 'ambiguous');
  assert.strictEqual(classifyText(JSON.stringify({ statusLine: { command: 7 } })), 'ambiguous');
  assert.strictEqual(classifyText('42'), 'ambiguous'); // valid JSON, not an object
});

test('decide: already shown wins over everything', () => {
  assert.strictEqual(decide('other', true).show, false);
});

test('decide: ours -> no nudge; ambiguous -> no nudge; other + not shown -> nudge', () => {
  assert.strictEqual(decide('ours', false).show, false);
  assert.equal(decide('ours', false).reason, 'ours');
  assert.strictEqual(decide('ambiguous', false).show, false);
  assert.equal(decide('ambiguous', false).reason, 'ambiguous');
  assert.strictEqual(decide('other', false).show, true);
  assert.equal(decide('other', false).reason, 'other');
});

// Not a direct legacy port -- message()/flagFileName()/defaultSettingsPath() have no standalone
// legacy unit test (message() is only exercised indirectly inside run()'s hookSpecificOutput, and
// the path builders are pure helpers with no fixture at all). Tested here directly, same convention
// as lang.test.ts's 'isAuto/withLang'.
test('message: mentions the setup command in both languages; path builders are plain joins', () => {
  assert.ok(message('ko').includes('/token-stamina:setup'));
  assert.ok(message('en').includes('/token-stamina:setup'));
  assert.equal(message('fr'), message('en')); // unknown lang falls back to en
  assert.equal(flagFileName('C:\\home'), 'C:\\home\\setup-nudge.json');
  assert.ok(defaultSettingsPath('C:\\home').endsWith('.claude\\settings.json'));
});
