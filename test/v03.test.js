'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// v0.3 features: handoff (Stop + SessionStart restore), topic gate, updated boundary wording.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pacer-v03-'));
process.env.TOKEN_STAMINA_HOME = TMP;

const pace = require('../scripts/pace');
const boundary = require('../scripts/boundary');
const handoff = require('../scripts/handoff');
const gate = require('../scripts/topic-gate');

const cfg = Object.assign(pace.loadConfig(), { boundary: true });
const asst = (content, usage, extra) => Object.assign({ type: 'assistant', isSidechain: false, message: { model: 'm', role: 'assistant', content, usage } }, extra);
const prompt = (t, ts) => ({ type: 'user', isSidechain: false, timestamp: ts, message: { role: 'user', content: t } });
const tu = (name, input, id) => ({ type: 'tool_use', id: id || 'tu_' + Math.random(), name, input });
const text = (t) => ({ type: 'text', text: t });
const u = (n) => ({ input_tokens: 10, cache_read_input_tokens: n - 30, cache_creation_input_tokens: 20, output_tokens: 5 });
const writeJsonl = (file, entries) => { fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n'); return file; };

function transcript(name, extra) {
  const entries = [
    prompt('first request', '2026-10-23T10:00:00Z'), asst([tu('Edit', { file_path: 'C:\\a.js' })], u(100000)),
    prompt('second ' + 'x'.repeat(400), '2026-10-23T10:05:00Z'),
    asst([tu('Bash', { command: 'git commit -m "feat: one"' }, 'k1'), tu('Write', { file_path: 'C:\\b.js' }),
      tu('TodoWrite', { todos: [{ content: 'step A', status: 'completed' }, { content: 'step B', status: 'pending' }] })], u(180000)),
    prompt('third request', '2026-10-23T10:10:00Z'), asst([text('done')], u(180000), { timestamp: '2026-10-23T10:11:00Z' }),
  ].concat(extra || []);
  return writeJsonl(path.join(TMP, name), entries);
}

test('handoff: scan extracts prompts, commits, files, todos', () => {
  const f = transcript('t1.jsonl');
  const s = handoff.scan(boundary.readTail(f, 1 << 20));
  assert.equal(s.prompts.length, 3);
  assert.deepEqual(s.commits.map((c) => c.s), ['feat: one']);
  assert.deepEqual(s.files, ['C:\\a.js', 'C:\\b.js']);
  assert.equal(s.todos.length, 2);
  assert.equal(s.lastPromptTs, '2026-10-23T10:10:00Z');
});

test('handoff: Stop writes session + latest notes, truncates prompts, caps size, accumulates commits', () => {
  const f = transcript('t2.jsonl');
  const input = { hook_event_name: 'Stop', session_id: 'sess-1', cwd: 'C:\\Work', transcript_path: f };
  const r = handoff.runStop(input, Date.now());
  const md = fs.readFileSync(handoff.sessionFile('sess-1'), 'utf8');
  assert.ok(md.includes('- cwd: C:\\Work') && md.includes('feat: one') && md.includes('[pending] step B') && md.includes('C:\\b.js'));
  assert.ok(!md.includes('x'.repeat(250))); // prompt clipped to ~200
  assert.equal(fs.readFileSync(handoff.latestFile('C:\\Work'), 'utf8'), md);
  assert.ok(r.tokens <= 1500);
  // second Stop with a different tail: earlier commit stays through the sidecar
  const f2 = writeJsonl(path.join(TMP, 't2b.jsonl'), [prompt('later', '2026-10-23T11:00:00Z'), asst([text('ok')], u(10000))]);
  handoff.runStop(Object.assign({}, input, { transcript_path: f2 }), Date.now());
  assert.ok(fs.readFileSync(handoff.sessionFile('sess-1'), 'utf8').includes('feat: one'));
  // tiny cap forces shrinking
  const many = [prompt('p', '2026-10-23T10:00:00Z')];
  for (let i = 0; i < 80; i++) many.push(asst([tu('Edit', { file_path: 'C:\\very\\long\\path\\number\\' + i + '\\file.js' })], u(1000)));
  const f3 = writeJsonl(path.join(TMP, 't2c.jsonl'), many);
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ handoffMaxTokens: 120 }));
  const r3 = handoff.runStop({ hook_event_name: 'Stop', session_id: 'sess-cap', cwd: 'C:\\Cap', transcript_path: f3 }, Date.now());
  fs.rmSync(path.join(TMP, 'config.json'));
  assert.ok(r3.tokens <= 120 + 5);
});

test('handoff: prune removes files older than 7 days', () => {
  const dir = handoff.dirOf();
  const old = path.join(dir, 'old.md');
  fs.writeFileSync(old, 'x');
  const past = new Date(Date.now() - 8 * 86400000);
  fs.utimesSync(old, past, past);
  handoff.prune(dir, Date.now());
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(handoff.sessionFile('sess-1')), true);
});

test('handoff: SessionStart restores same session on compact, skips the auto note on clear', () => {
  const now = Date.now();
  const c = JSON.parse(handoff.runStart({ source: 'compact', session_id: 'sess-1', cwd: 'C:\\Work' }, now)).hookSpecificOutput;
  assert.equal(c.hookEventName, 'SessionStart');
  assert.ok(c.additionalContext.startsWith(handoff.HEADER + '\n'));
  assert.ok(c.additionalContext.includes('feat: one') && !c.additionalContext.includes('<!--'));
  assert.equal(handoff.runStart({ source: 'clear', session_id: 'brand-new', cwd: 'C:\\Work' }, now), ''); // auto note is not replayed after /clear
  assert.equal(handoff.runStart({ source: 'clear', session_id: 'brand-new', cwd: 'C:\\Other' }, now), '');
  assert.equal(handoff.runStart({ source: 'startup', session_id: 'sess-1', cwd: 'C:\\Work' }, now), '');
  assert.equal(handoff.runStart({ source: 'clear', session_id: 'brand-new', cwd: 'C:\\Work' }, now + 2 * 86400000), ''); // fallback too old
  assert.equal(handoff.run(JSON.stringify({ hook_event_name: 'Other' })), '');
});

test('handoff: Claude-written note wins only when newer than the last user prompt', () => {
  const f = transcript('t5.jsonl');
  // Clock pinned next to the fixture's prompts: with the real clock the 10/23 notes aged past prune's 7 days and vanished.
  const NOW = Date.parse('2026-10-23T11:00:00Z');
  handoff.runStop({ hook_event_name: 'Stop', session_id: 'sess-c', cwd: 'C:\\Rich', transcript_path: f }, NOW);
  const cf = handoff.sessionFile('sess-c', true);
  fs.writeFileSync(cf, '# Rich note from Claude\nkeep X');
  const old = new Date('2026-10-23T09:00:00Z'); // before the last prompt (10:10)
  fs.utimesSync(cf, old, old);
  assert.equal(handoff.pick('sess-c', 'C:\\Rich', NOW).kind, 'auto');
  const fresh = new Date('2026-10-23T10:30:00Z');
  fs.utimesSync(cf, fresh, fresh);
  const p = handoff.pick('sess-c', 'C:\\Rich', NOW);
  assert.equal(p.kind, 'claude');
  assert.ok(handoff.additionalContext(p).includes('keep X'));
  // next Stop copies it to latest-<cwd>.claude.md so a /clear in a new session finds it
  handoff.runStop({ hook_event_name: 'Stop', session_id: 'sess-c', cwd: 'C:\\Rich', transcript_path: f }, NOW);
  assert.ok(fs.existsSync(handoff.latestFile('C:\\Rich', true)));
});

test('handoff: handoff=false disables both hooks', () => {
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ handoff: false }));
  const f = transcript('t6.jsonl');
  assert.equal(handoff.runStop({ session_id: 'off', cwd: 'C:\\Off', transcript_path: f }), null);
  assert.equal(handoff.runStart({ source: 'compact', session_id: 'sess-1', cwd: 'C:\\Work' }), '');
  fs.rmSync(path.join(TMP, 'config.json'));
});

test('topic-gate: decide thresholds, idle or cwd change, regrowth', () => {
  const now = 1_800_000_000_000;
  const base = { tokens: 420000, lastAssistantMs: now - 3 * 3600 * 1000, nowMs: now, cwd: 'C:\\A' };
  assert.equal(gate.decide(base, cfg, undefined).gate, true);
  assert.equal(gate.decide(Object.assign({}, base, { tokens: 150000 }), cfg, undefined).reason, 'below_threshold');
  assert.equal(gate.decide(Object.assign({}, base, { lastAssistantMs: now - 600000 }), cfg, { cwd: 'C:\\A' }).reason, 'no_gap');
  const cw = gate.decide(Object.assign({}, base, { lastAssistantMs: now - 600000 }), cfg, { cwd: 'C:\\B' });
  assert.equal(cw.gate, true);
  assert.equal(cw.cwdChanged, true);
  assert.equal(gate.decide(base, cfg, { cwd: 'C:\\A', gatedAt: 420000 }).reason, 'renotify_suppressed');
  assert.equal(gate.decide(base, cfg, { cwd: 'C:\\A', gatedAt: 300000 }).gate, true); // +100k
  assert.equal(gate.decide(base, cfg, { cwd: 'C:\\A', gatedAt: 900000 }).gate, true); // shrank since
  assert.equal(gate.decide(base, Object.assign({}, cfg, { topicGate: false }), undefined).gate, false);
});

test('topic-gate: wording and run() end to end', () => {
  const ko = gate.message('ko', 420000, 3 * 3600, false, 'P.claude.md');
  assert.ok(ko.includes('42만') && ko.includes('3시간') && ko.includes('P.claude.md') && ko.includes('무시'));
  assert.ok(gate.message('en', 420000, 3 * 3600, false, 'P').includes('420k, 3h idle'));
  const ent = [prompt('hi', '2020-01-01T00:00:00Z'), asst([text('old answer')], u(420000), { timestamp: '2020-01-01T00:05:00Z' })];
  const f = writeJsonl(path.join(TMP, 'g1.jsonl'), ent);
  const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'g1', cwd: 'C:\\A', transcript_path: f });
  const out = JSON.parse(gate.run(raw)).hookSpecificOutput;
  assert.equal(out.hookEventName, 'UserPromptSubmit');
  assert.ok(out.additionalContext.includes(path.join('handoff', 'g1.claude.md')));
  const again = gate.run(raw); // same growth: the idle gate stays quiet, only the 0.4.2 topic-check line remains
  assert.ok(again.includes('different topic') && !again.includes('idle'));
  const small = writeJsonl(path.join(TMP, 'g2.jsonl'), [prompt('hi', '2020-01-01T00:00:00Z'), asst([text('a')], u(50000), { timestamp: '2020-01-01T00:05:00Z' })]);
  assert.equal(gate.run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'g2', cwd: 'C:\\A', transcript_path: small })), '');
});

test('boundary v0.3 wording mentions plain /compact and restore', () => {
  const r = { tokens: 190000, commits: [] };
  assert.ok(boundary.message(r, 'ko', 'compact').includes('그냥 /compact 만 쳐도 돼요'));
  assert.ok(boundary.message(r, 'ko', 'new_session').includes('/clear 뒤에도'));
  assert.ok(boundary.message(r, 'en', 'compact').includes('Plain /compact'));
});

test('after /clear only a fresh Claude-written note is restored', () => {
  const f = transcript('t5.jsonl');
  handoff.runStop({ hook_event_name: 'Stop', session_id: 'sess-clr', cwd: 'C:\ClearCase', transcript_path: f }, Date.now());
  const now = new Date('2026-10-23T10:40:00Z').getTime();
  assert.equal(handoff.pick('sess-new', 'C:\ClearCase', now, 'clear'), null);
  assert.equal(handoff.pick('sess-clr', 'C:\ClearCase', now, 'clear'), null);
  assert.equal(handoff.pick('sess-clr', 'C:\ClearCase', now, 'compact').kind, 'auto');
  const cf = handoff.sessionFile('sess-clr', true);
  fs.writeFileSync(cf, '# Claude note\nnext: Y');
  const fresh = new Date('2026-10-23T10:30:00Z');
  fs.utimesSync(cf, fresh, fresh);
  assert.equal(handoff.pick('sess-clr', 'C:\ClearCase', now, 'clear').kind, 'claude');
  assert.equal(handoff.pick('sess-clr', 'C:\ClearCase', now + 2 * 3600e3, 'clear'), null);
});

test('skipHook: headless entrypoint and excluded cwd', () => {
  const prev = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
  assert.equal(pace.skipHook({ cwd: 'C:\Work' }, {}), true);
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  assert.equal(pace.skipHook({ cwd: 'C:\Work' }, {}), false);
  assert.equal(pace.skipHook({ cwd: 'C:\Temp\Botwork' }, { excludeCwd: ['botwork'] }), true);
  assert.equal(pace.skipHook({ cwd: 'C:\Work' }, { excludeCwd: ['botwork'] }), false);
  if (prev === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = prev;
});

test('topic-gate: moving into a parent or child folder is not a cwd change', () => {
  assert.equal(gate.sameTree('C:\\Projects', 'C:\\Projects\\misc\\app'), true);
  assert.equal(gate.sameTree('c:/projects/misc/', 'C:\\Projects'), true);
  assert.equal(gate.sameTree('C:\\Projects', 'C:\\Other'), false);
  assert.equal(gate.sameTree('C:\\Projects', 'C:\\ProjectsX'), false);
});
