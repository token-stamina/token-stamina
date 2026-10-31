'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// Desktop-app clear_session runs no SessionStart hook: Stop leaves a marker, the new session's first prompt restores the note.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-v19-'));
process.env.TOKEN_STAMINA_HOME = TMP;

const pace = require('../scripts/pace');
const boundary = require('../scripts/boundary');
const handoff = require('../scripts/handoff');

const CWD = 'C:\\Work\\Clear';
const NOW = Date.now(); // fixed once per run; file mtimes are real, so prune (7d) must not see a far-future clock
const prompt = (t, ts) => ({ type: 'user', isSidechain: false, timestamp: ts, message: { role: 'user', content: t } });
const asst = (content) => ({ type: 'assistant', isSidechain: false, message: { model: 'm', role: 'assistant', content } });
const tu = (name, input) => ({ type: 'tool_use', id: 'tu_' + Math.random(), name, input });
// A clear_session call and its result (denied calls come back with is_error and must leave no marker).
const clearCall = (name, sid, err) => { const id = 'tu_' + Math.random(); return [asst([{ type: 'tool_use', id, name, input: { session_id: sid } }]), { type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!err, content: err ? 'denied' : 'queued' }] } }]; };
const title = (t) => ({ type: 'custom-title', customTitle: t });
const write = (name, entries) => { const f = path.join(TMP, name); fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n'); return f; };
const stopIn = (sid, f) => ({ hook_event_name: 'Stop', session_id: sid, cwd: CWD, transcript_path: f });
const promptIn = (sid, f) => ({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: CWD, transcript_path: f, prompt: 'hi' });
const HOST = 'local_host-1';
const marker = () => handoff.pendingFile(HOST);
const savedHost = process.env.CLAUDE_CODE_HOST_SESSION_ID;
test.beforeEach(() => { process.env.CLAUDE_CODE_HOST_SESSION_ID = HOST; });
test.after(() => { if (savedHost === undefined) delete process.env.CLAUDE_CODE_HOST_SESSION_ID; else process.env.CLAUDE_CODE_HOST_SESSION_ID = savedHost; });
const putMarker = (o) => { fs.mkdirSync(handoff.dirOf(), { recursive: true }); fs.writeFileSync(marker(), JSON.stringify(Object.assign({ from: 'old', host: HOST, cwd: CWD, at: NOW }, o))); };
const putNote = () => {
  fs.mkdirSync(handoff.dirOf(), { recursive: true });
  const f = handoff.sessionFile('old', true);
  fs.writeFileSync(f, '# Claude note\nDo the thing');
  fs.utimesSync(f, (NOW - 60000) / 1000, (NOW - 60000) / 1000);
};
const fresh = (extra) => write('new-' + Math.random() + '.jsonl', [title('My Task'), prompt('first', '2026-10-30T10:00:00Z')].concat(extra || []));
const reset = () => { try { fs.unlinkSync(marker()); } catch (e) { /* none */ } };

test('clear prompt: Stop writes a marker only for clear_session with session_id self', () => {
  reset();
  const turn = (sid) => write('old-' + sid + '.jsonl', [title('My Task'), prompt('go', '2026-10-30T09:00:00Z'), ...clearCall('mcp__ccd_session_mgmt__clear_session', sid)]);
  handoff.runStop(stopIn('old', turn('some-other-id')), NOW);
  assert.equal(fs.existsSync(marker()), false);
  handoff.runStop(stopIn('old', turn('self')), NOW);
  const mk = JSON.parse(fs.readFileSync(marker(), 'utf8'));
  assert.deepEqual(mk, { from: 'old', host: HOST, cwd: CWD, at: NOW });
  reset();
  // A clear in an earlier turn does not count.
  handoff.runStop(stopIn('old', write('old-late.jsonl', [prompt('a', 't1'), ...clearCall('x__clear_session', 'self'), prompt('b', 't2'), asst([tu('Edit', { file_path: 'C:\\a' })])])), NOW);
  assert.equal(fs.existsSync(marker()), false);
});

test('clear prompt: first prompt restores the note once and removes the marker', () => {
  reset(); putNote(); putMarker();
  const f = fresh();
  const out = JSON.parse(handoff.runPrompt(promptIn('new', f), NOW + 60000));
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith(handoff.HEADER + ' [claude note]\n'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Do the thing'));
  assert.equal(fs.existsSync(marker()), false);
  assert.equal(handoff.runPrompt(promptIn('new', f), NOW + 70000), '');
  assert.ok(fs.readFileSync(path.join(pace.home(), 'events.jsonl'), 'utf8').includes('"source":"clear_prompt"'));
});

test('clear prompt: dispatched through run() for UserPromptSubmit', () => {
  reset(); putNote(); putMarker({ at: Date.now() });
  const out = handoff.run(JSON.stringify(promptIn('new', fresh())));
  assert.ok(JSON.parse(out).hookSpecificOutput.additionalContext.includes('Do the thing'));
});

test('clear prompt: auto note is used when there is no fresh Claude note', () => {
  reset(); putMarker();
  try { fs.unlinkSync(handoff.sessionFile('old', true)); } catch (e) { /* none */ }
  fs.writeFileSync(handoff.sessionFile('old'), '<!-- token-stamina-handoff session=old lastPromptTs= saved=2026-10-30T09:00:00Z -->\n# Handoff note (auto, no LLM)\n- cwd: x\n');
  const out = JSON.parse(handoff.runPrompt(promptIn('new', fresh()), NOW + 1000));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Handoff note (auto'));
});

test('clear prompt: older than 60 minutes outputs nothing and drops the marker', () => {
  reset(); putNote(); putMarker();
  assert.equal(handoff.runPrompt(promptIn('new', fresh()), NOW + (handoff.CLEAR_LINK_MAX_SEC + 1) * 1000), '');
  assert.equal(fs.existsSync(marker()), false);
});

test('clear prompt: restores although the title differs and the session already has assistant lines', () => {
  reset(); putNote(); putMarker();
  const f = write('busy.jsonl', [title('Another Task'), prompt('first', 't'), asst([{ type: 'text', text: 'hello' }]), prompt('second', 't2')]);
  assert.ok(JSON.parse(handoff.runPrompt(promptIn('new', f), NOW + 1000)).hookSpecificOutput.additionalContext.includes('Do the thing'));
  assert.equal(fs.existsSync(marker()), false);
});

test('clear prompt: another host id restores nothing and keeps the marker; no host env writes and reads nothing', () => {
  reset(); putNote(); putMarker();
  process.env.CLAUDE_CODE_HOST_SESSION_ID = 'local_other';
  assert.equal(handoff.runPrompt(promptIn('new', fresh()), NOW + 1000), '');
  assert.equal(fs.existsSync(marker()), true);
  delete process.env.CLAUDE_CODE_HOST_SESSION_ID;
  assert.equal(handoff.runPrompt(promptIn('new', fresh()), NOW + 1000), '');
  handoff.runStop(stopIn('old', write('nohost.jsonl', [prompt('go', 't'), ...clearCall('x__clear_session', 'self')])), NOW);
  assert.equal(fs.existsSync(handoff.pendingFile('')), false);
  assert.equal(fs.existsSync(marker()), true); // untouched
});

test('clear prompt: SessionStart startup restores first, the prompt hook then adds nothing', () => {
  reset(); putNote(); putMarker();
  const f = fresh();
  const ss = JSON.parse(handoff.runStart({ source: 'startup', session_id: 'new', cwd: CWD }, NOW + 1000));
  assert.equal(ss.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(ss.hookSpecificOutput.additionalContext.includes('[claude note]'));
  assert.equal(handoff.runPrompt(promptIn('new', f), NOW + 2000), '');
});

test('clear prompt: clearedSelf accepts the host id as well as self', () => {
  const t = (id) => [prompt('go', 't'), ...clearCall('x__clear_session', id)];
  assert.equal(handoff.clearedSelf(t(HOST)), true);
  assert.equal(handoff.clearedSelf(t('self')), true);
  assert.equal(handoff.clearedSelf(t('local_other')), false);
  // Denied by the permission check (is_error) or no result yet: the session was not cleared.
  assert.equal(handoff.clearedSelf([prompt('go', 't'), ...clearCall('x__clear_session', 'self', true)]), false);
  assert.equal(handoff.clearedSelf([prompt('go', 't'), asst([tu('x__clear_session', { session_id: 'self' })])]), false);
  delete process.env.CLAUDE_CODE_HOST_SESSION_ID;
  assert.equal(handoff.clearedSelf(t(HOST)), false);
});

test('clear prompt: same session as the marker drops it', () => {
  reset(); putNote(); putMarker();
  assert.equal(handoff.runPrompt(promptIn('old', fresh()), NOW + 1000), '');
  assert.equal(fs.existsSync(marker()), false);
});

test('clear prompt: no marker returns empty without reading the transcript', () => {
  reset();
  const orig = boundary.readTail;
  let reads = 0;
  boundary.readTail = (...a) => { reads++; return orig(...a); };
  try { assert.equal(handoff.runPrompt(promptIn('new', fresh()), NOW), ''); } finally { boundary.readTail = orig; }
  assert.equal(reads, 0);
});

test('clear prompt: handoff:false returns empty', () => {
  reset(); putNote(); putMarker();
  const cfgFile = path.join(TMP, 'config.json');
  const prev = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null;
  fs.writeFileSync(cfgFile, JSON.stringify({ handoff: false }));
  try { assert.equal(handoff.runPrompt(promptIn('new', fresh()), NOW + 1000), ''); } finally { if (prev) fs.writeFileSync(cfgFile, prev); else fs.unlinkSync(cfgFile); }
});
