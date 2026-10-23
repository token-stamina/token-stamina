'use strict';
// v0.2 features: boundary hook, per-turn status line, ko agent-model messages, fixed-cost audit.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pacer-v02-'));
process.env.TOKEN_STAMINA_HOME = TMP;

const pace = require('../scripts/pace');
const agent = require('../scripts/agent-model');
const statusline = require('../scripts/statusline');
const boundary = require('../scripts/boundary');
const audit = require('../scripts/audit');

const cfg = Object.assign(pace.loadConfig(), { boundary: true });
const NOW = 1_800_000_000;
const red = { seven_day: { pct: 80, resets_at: NOW + Math.round(pace.WEEK * 0.5) }, recorded_at: NOW };
const noDef = { definitionHasModel: () => false };

const asst = (content, usage, extra) => Object.assign({ type: 'assistant', isSidechain: false,
  message: { model: 'm', role: 'assistant', content, usage } }, extra);
const prompt = (t) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: t || 'do it' } });
const toolUse = (name, input, id) => ({ type: 'tool_use', id: id || 'tu_' + Math.random(), name, input });
const text = (t) => ({ type: 'text', text: t });
const u = (n) => ({ input_tokens: 10, cache_read_input_tokens: n - 30, cache_creation_input_tokens: 20, output_tokens: 5 });
const commitCall = (msg) => toolUse('Bash', { command: `git commit -m "${msg}"` }, 'c1');
const writeJsonl = (file, entries) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n'); return file; };

test('boundary: context tokens come from last main assistant message, sidechain ignored', () => {
  const r = boundary.analyze([prompt(), asst([text('a')], u(120000)), asst([text('b')], u(999999), { isSidechain: true }), asst([text('c')], u(190000))]);
  assert.equal(r.tokens, 190000);
});

test('boundary: commit in this turn => boundary; earlier turn commit does not count', () => {
  const old = boundary.analyze([prompt('first'), asst([commitCall('old')], u(200000)), prompt('second'), asst([toolUse('Read', {})], u(200000)), asst([text('done')], u(200000))]);
  assert.equal(old.commitCount, 0);
  assert.equal(boundary.decide(old, cfg, undefined).notify, false);
  const cur = boundary.analyze([prompt(), asst([commitCall('feat: x')], u(200000)), asst([text('done')], u(200000))]);
  assert.deepEqual(cur.commits, ['feat: x']);
  assert.equal(boundary.decide(cur, cfg, undefined).kind, 'commit');
});

test('boundary: edit counts only when the turn ends with an answer', () => {
  const ended = boundary.analyze([prompt(), asst([toolUse('Edit', {})], u(200000)), asst([text('done')], u(200000))]);
  assert.equal(boundary.decide(ended, cfg, undefined).kind, 'edit');
  const midTool = boundary.analyze([prompt(), asst([text('x'), toolUse('Write', {})], u(200000))]);
  assert.equal(boundary.decide(midTool, cfg, undefined).notify, false);
  const none = boundary.analyze([prompt(), asst([text('just talk')], u(200000))]);
  assert.equal(boundary.decide(none, cfg, undefined).reason, 'not_boundary');
});

test('boundary: below threshold, no prompt in tail, failed commit => silent', () => {
  const low = boundary.analyze([prompt(), asst([commitCall('x')], u(100000)), asst([text('ok')], u(100000))]);
  assert.equal(boundary.decide(low, cfg, undefined).reason, 'below_threshold');
  const noTurn = boundary.analyze([asst([commitCall('x')], u(200000)), asst([text('ok')], u(200000))]);
  assert.equal(boundary.decide(noTurn, cfg, undefined).reason, 'no_turn');
  const failed = boundary.analyze([prompt(), asst([commitCall('x')], u(200000)),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'nothing to commit' }] } },
    asst([text('failed')], u(200000))]);
  assert.equal(failed.commitCount, 0);
});

test('boundary: renotify only after growth; shrink (compact) resets', () => {
  const r = boundary.analyze([prompt(), asst([commitCall('x')], u(200000)), asst([text('ok')], u(200000))]);
  assert.equal(boundary.decide(r, cfg, 200000).reason, 'renotify_suppressed');
  assert.equal(boundary.decide(r, cfg, 150000).reason, 'renotify_suppressed'); // +50k < 100k
  assert.equal(boundary.decide(r, cfg, 100000).notify, true); // +100k
  assert.equal(boundary.decide(r, cfg, 300000).notify, true); // context shrank since: start over
});

test('boundary: wording, max 2 commit subjects, new-session level', () => {
  const r = boundary.analyze([prompt(), asst([
    toolUse('PowerShell', { command: 'git commit -m "feat: a"' }, 'a'),
    toolUse('Bash', { command: "git -C x commit -m 'fix: b'" }, 'b'),
    toolUse('Bash', { command: 'git commit -m "third"' }, 'c')], u(190000)), asst([text('ok')], u(190000))]);
  assert.deepEqual(r.commits, ['feat: a', 'fix: b']);
  const ko = boundary.message(r, 'ko', 'compact');
  assert.ok(ko.includes('컨텍스트 19만 토큰') && ko.includes('/compact feat: a · fix: b') && !ko.includes('<'));
  assert.ok(boundary.message(r, 'en', 'compact').includes('190k'));
  assert.equal(boundary.decide(Object.assign({}, r, { tokens: 420000 }), cfg, undefined).level, 'new_session');
  assert.ok(boundary.message(Object.assign({}, r, { tokens: 420000, commits: [] }), 'ko', 'new_session').includes('새 세션 권장'));
  assert.ok(boundary.message(Object.assign({}, r, { commits: [] }), 'ko', 'compact').includes('(남길 결정·남은 일)'));
  const heredoc = "git commit -m \"$(cat <<'EOF'\nfeat: heredoc subject\n\nbody\nEOF\n)\"";
  assert.equal(boundary.commitSubject(heredoc), 'feat: heredoc subject');
});

test('boundary: run() tails a big file, emits systemMessage only, dedups per session', () => {
  const entries = [];
  for (let i = 0; i < 300; i++) entries.push({ type: 'attachment', pad: 'x'.repeat(2000) }); // ~600KB > 256KB tail
  entries.push(prompt(), asst([commitCall('feat: big')], u(200000)), asst([text('done')], u(200000)));
  const f = writeJsonl(path.join(TMP, 'big.jsonl'), entries);
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ boundary: true }));
  const raw = JSON.stringify({ hook_event_name: 'Stop', session_id: 'bs1', transcript_path: f });
  const out = JSON.parse(boundary.run(raw));
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  assert.ok(out.systemMessage.includes('feat: big'));
  assert.equal(boundary.run(raw), '');
  const events = fs.readFileSync(path.join(TMP, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.event === 'boundary' && e.session === 'bs1' && e.level === 'compact'));
  assert.equal(boundary.run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', transcript_path: f })), '');
  assert.throws(() => boundary.run(JSON.stringify({ hook_event_name: 'Stop', transcript_path: path.join(TMP, 'missing.jsonl') }))); // wrapper swallows
  fs.rmSync(path.join(TMP, 'config.json'), { force: true });
});

test('statusline: per-turn cost label and markers', () => {
  const run = (cw, lang) => {
    fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ lang }));
    const o = statusline.run(JSON.stringify({ context_window: cw }));
    fs.rmSync(path.join(TMP, 'config.json'));
    return o;
  };
  const usage = (n) => ({ input_tokens: 1000, cache_read_input_tokens: n - 3000, cache_creation_input_tokens: 2000 });
  assert.equal(run({ used_percentage: 19, current_usage: usage(190000) }, 'ko'), 'ctx 19% (190k/턴) 🔴');
  assert.equal(run({ used_percentage: 19, current_usage: usage(190000) }, 'en'), 'ctx 19% (190k/turn) 🔴');
  assert.equal(run({ used_percentage: 12, current_usage: usage(120000) }, 'en'), 'ctx 12% (120k/turn) 🟡');
  assert.equal(run({ used_percentage: 5, current_usage: usage(50000) }, 'en'), 'ctx 5% (50k/turn)');
  assert.equal(run({ used_percentage: 7, total_input_tokens: 70000 }, 'en'), 'ctx 7% (70k/turn)');
  assert.equal(run({ used_percentage: 7 }, 'en'), 'ctx 7%');
});

test('agent-model: ko messages when lang is ko, en otherwise', () => {
  const k = Object.assign({}, cfg, { lang: 'ko' });
  const input = { tool_name: 'Agent', cwd: TMP, tool_input: { prompt: 'implement the parser', description: 'impl' } };
  const inj = agent.decide(input, red, k, NOW, noDef);
  assert.ok(/[가-힣]/.test(inj.message) && inj.message.includes('model="sonnet"'));
  assert.ok(/[가-힣]/.test(agent.decide({ tool_name: 'Agent', tool_input: { prompt: 'review the design' } }, red, k, NOW, noDef).message));
  assert.ok(/[가-힣]/.test(agent.decide(input, red, Object.assign({}, k, { mode: 'suggest' }), NOW, noDef).message));
  assert.ok(!/[가-힣]/.test(agent.decide(input, red, Object.assign({}, cfg, { lang: 'en' }), NOW, noDef).message));
});

test('audit: token estimate and cwd encoding', () => {
  assert.equal(audit.estimateTokens('abcd'.repeat(10)), 10);
  assert.equal(audit.estimateTokens('가나다'), 2);
  assert.equal(audit.estimateTokens('abcd가나'), 2); // 1 + 1.33
  assert.equal(audit.encodeCwd('C:\\Projects'), 'C--Projects');
  assert.equal(audit.encodeCwd('C:\\Projects\\my-app\\.claude\\worktrees\\x'), 'C--Projects-my-app--claude-worktrees-x');
  assert.equal(audit.parseAlwaysOn('  Always-on:   ~79 tok   added'), 79);
  assert.equal(audit.parseAlwaysOn('Always-on: ~3.5k tok'), 3500);
});

// Fake HOME with config, project files and transcripts.
function fakeHome() {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const proj = path.join(home, 'work', 'proj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'a'.repeat(400));
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '가'.repeat(150));
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'), 'b'.repeat(40));
  const memDir = path.join(home, '.claude', 'projects', audit.encodeCwd(proj), 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), 'm'.repeat(80));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'used@mk': true, 'idle@mk': true, 'hooky@mk': true, 'off@mk': false } }));
  const inst = {};
  for (const n of ['used', 'idle', 'hooky', 'off']) {
    const ip = path.join(home, 'plug', n);
    fs.mkdirSync(path.join(ip, 'hooks'), { recursive: true });
    if (n === 'hooky') fs.writeFileSync(path.join(ip, 'hooks', 'hooks.json'), '{}');
    inst[n + '@mk'] = [{ scope: 'user', version: '1.0.0', installPath: ip }];
  }
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: inst }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { srvused: {}, srvidle: {} } }));
  const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const call = (name, input, d) => asst([toolUse(name, input)], u(1000), { timestamp: iso(d) });
  writeJsonl(path.join(home, '.claude', 'projects', 'p1', 's1.jsonl'), [
    call('mcp__srvused__a', {}, 1), call('mcp__srvused__b', {}, 2), call('mcp__ccd_session__x', {}, 1),
    call('mcp__plugin_used_thing__t', {}, 3), call('Skill', { skill: 'used:cmd' }, 1), call('Skill', { skill: 'plain' }, 2),
    call('mcp__oldsrv__a', {}, 90), // outside the 30-day window by timestamp
  ]);
  return { home, proj };
}

test('audit: always-loaded files, server/skill counts, classification, recommendations', async () => {
  const { home, proj } = fakeHome();
  const opts = { cwd: proj, days: 30, details: false, cli: false, cache: false, homeDir: home };
  const r = await audit.buildReport(opts);
  // The tmp dir lives under the real home, so ancestors may add real files: only look inside the fake home.
  const mine = r.always_loaded.files.filter((f) => f.path.startsWith(home));
  const names = mine.map((f) => path.basename(f.path));
  assert.deepEqual(names.sort(), ['CLAUDE.local.md', 'CLAUDE.md', 'CLAUDE.md', 'MEMORY.md']);
  assert.equal(mine.reduce((a, f) => a + f.tokens_est, 0), 100 + 100 + 10 + 20);
  const srv = Object.fromEntries(r.mcp_usage.map((s) => [s.name, s]));
  assert.equal(srv.srvused.calls, 2);
  assert.equal(srv.oldsrv, undefined);
  assert.equal(srv.ccd_session.kind, 'builtin');
  assert.equal(srv.plugin_used_thing.kind, 'plugin:used');
  assert.equal(r.skill_usage.find((s) => s.name === 'plain').calls, 1);
  const plug = Object.fromEntries(r.plugins.map((p) => [p.name, p]));
  assert.equal(plug.used.calls, 2); // skill used:cmd + server plugin_used_thing
  const cand = r.candidates.map((c) => c.name).sort();
  assert.deepEqual(cand, ['idle@mk', 'srvidle']); // not: used, hook-only plugin, disabled plugin, used server
  assert.equal(r.candidates.find((c) => c.name === 'idle@mk').how, 'claude plugin disable idle@mk');
  const txt = audit.render(r, 'ko');
  assert.ok(txt.includes('끄기 후보') && txt.includes('이 기록에 안 남아요'));
  assert.ok(audit.render(r, 'en').includes('Candidates to turn off'));
});

test('audit: cache reuses unchanged files and rescans changed ones', async () => {
  const { home, proj } = fakeHome();
  const opts = { cwd: proj, days: 30, details: false, cli: false, cache: true, homeDir: home };
  const a = await audit.buildReport(opts);
  assert.equal(a.scan.files_scanned, 1);
  const b = await audit.buildReport(opts);
  assert.equal(b.scan.files_cached, 1);
  assert.equal(b.scan.files_scanned, 0);
  assert.deepEqual(b.mcp_usage, a.mcp_usage);
  fs.appendFileSync(path.join(home, '.claude', 'projects', 'p1', 's1.jsonl'),
    JSON.stringify(asst([toolUse('mcp__srvused__c', {})], u(1000), { timestamp: new Date().toISOString() })) + '\n');
  const c = await audit.buildReport(opts);
  assert.equal(c.scan.files_scanned, 1);
  assert.equal(c.mcp_usage.find((s) => s.name === 'srvused').calls, 3);
});
