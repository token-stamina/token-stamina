'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate all state before loading modules.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pacer-test-'));
process.env.TOKEN_STAMINA_HOME = TMP;

const pace = require('../scripts/pace');
const agent = require('../scripts/agent-model');
const nudge = require('../scripts/nudge');
const statusline = require('../scripts/statusline');

const NOW = 1_800_000_000;
const cfg = pace.loadConfig();
// 7d window, fraction `e` elapsed, used `u`.
const week = (u, e) => ({ pct: u, resets_at: NOW + Math.round(pace.WEEK * (1 - e)) });
const five = (u, e) => ({ pct: u, resets_at: NOW + Math.round(pace.FIVE * (1 - e)) });
const st = (d7, h5) => ({ seven_day: d7, five_hour: h5, recorded_at: NOW });

test('pace: grades by margin against elapsed', () => {
  assert.equal(pace.assess(st(week(40, 0.5)), NOW, cfg).grade, 'green');
  assert.equal(pace.assess(st(week(55, 0.5)), NOW, cfg).grade, 'yellow');
  assert.equal(pace.assess(st(week(61, 0.5)), NOW, cfg).grade, 'red');
  assert.equal(pace.assess(st(week(90, 0.99)), NOW, cfg).grade, 'red'); // u >= 90
});

test('pace: window just started (e ~ 0)', () => {
  const a = pace.assess(st(week(0, 0.0)), NOW, cfg);
  assert.equal(a.grade, 'green');
  assert.ok(Math.abs(a.d7.elapsedPct) < 0.01);
  assert.equal(pace.assess(st(week(5, 0.0)), NOW, cfg).grade, 'yellow');
});

test('pace: reset already passed => window ignored', () => {
  const s = st({ pct: 95, resets_at: NOW - 10 }, null);
  assert.equal(pace.assess(s, NOW, cfg).grade, null);
});

test('pace: missing fields and null state', () => {
  assert.equal(pace.assess(null, NOW, cfg).grade, null);
  assert.equal(pace.assess({}, NOW, cfg).grade, null);
  assert.equal(pace.assess({ seven_day: { pct: 'x' } }, NOW, cfg).grade, null);
  assert.equal(pace.assess({ seven_day: { pct: 50 } }, NOW, cfg).grade, null);
});

test('pace: worse window wins, calm 5h never upgrades', () => {
  const a = pace.assess(st(week(80, 0.5), five(1, 0.5)), NOW, cfg);
  assert.equal(a.grade, 'red');
  assert.equal(a.worst, '7d');
  const b = pace.assess(st(week(10, 0.5), five(90, 0.5)), NOW, cfg);
  assert.equal(b.grade, 'red');
  assert.equal(b.worst, '5h');
});

test('pace: 5h floors stop early-window red', () => {
  // 5% used 10 minutes into the 5h window is far ahead of linear pace but not a real risk.
  assert.equal(pace.assess(st(week(10, 0.5), five(5, 10 / 300)), NOW, cfg).grade, 'green');
  assert.equal(pace.assess(st(week(10, 0.5), five(30, 0.05)), NOW, cfg).grade, 'yellow');
  assert.equal(pace.assess(st(week(10, 0.5), five(55, 0.2)), NOW, cfg).grade, 'red');
  // 7d keeps no floor: 11% one hour after reset is still red.
  assert.equal(pace.assess(st(week(11, 1 / 168)), NOW, cfg).grade, 'red');
});

test('pace: daily quota and 5h exhaust projection', () => {
  const a = pace.assess(st(week(50, 0.5)), NOW, cfg);
  assert.ok(Math.abs(a.quota - 50 / 3.5) < 0.01);
  // 50% used with half the window gone => hits 100% exactly at reset => null
  assert.equal(pace.exhaustAt(five(50, 0.5), pace.FIVE, NOW), null);
  const t = pace.exhaustAt(five(80, 0.5), pace.FIVE, NOW);
  assert.ok(t > NOW && t < NOW + pace.FIVE / 2);
  assert.equal(pace.exhaustAt(five(0, 0.5), pace.FIVE, NOW), null);
});

const red = st(week(80, 0.5));
const call = (ti, extra) => Object.assign({ tool_name: 'Agent', tool_input: ti, cwd: TMP }, extra);
const noDef = { definitionHasModel: () => false };

test('agent-model: passes when model given / fork / definition model', () => {
  assert.equal(agent.decide(call({ prompt: 'x', model: 'opus' }), red, cfg, NOW, noDef).reason, 'has_model');
  assert.equal(agent.decide(call({ prompt: 'x', subagent_type: 'fork' }), red, cfg, NOW, noDef).reason, 'fork');
  assert.equal(agent.decide(call({ prompt: 'x', subagent_type: 'mine' }), red, cfg, NOW, { definitionHasModel: () => true }).reason, 'definition_model');
});

test('agent-model: definitionHasModel reads frontmatter', () => {
  const dir = path.join(TMP, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pinned.md'), '---\nname: pinned\nmodel: haiku\n---\nbody');
  fs.writeFileSync(path.join(dir, 'inh.md'), '---\nname: inh\nmodel: inherit\n---\nbody');
  assert.equal(agent.definitionHasModel('pinned', TMP, TMP), true);
  assert.equal(agent.definitionHasModel('inh', TMP, TMP), false);
  assert.equal(agent.definitionHasModel('Explore', TMP, TMP), true);
  assert.equal(agent.definitionHasModel('../x', TMP, TMP), false);
});

test('agent-model: grade not red => nothing; no state => nothing', () => {
  const ti = { prompt: 'list files', description: 'list' };
  assert.equal(agent.decide(call(ti), st(week(40, 0.5)), cfg, NOW, noDef).action, 'pass');
  assert.equal(agent.decide(call(ti), st(week(55, 0.5)), cfg, NOW, noDef).reason, 'grade_yellow');
  assert.equal(agent.decide(call(ti), null, cfg, NOW, noDef).reason, 'no_state');
});

test('agent-model: red => judgment suggest, simple haiku, other sonnet', () => {
  const j = agent.decide(call({ prompt: 'Please review the architecture', description: 'x' }), red, cfg, NOW, noDef);
  assert.equal(j.action, 'suggest');
  assert.equal(agent.output(call({}), j).hookSpecificOutput.updatedInput, undefined);
  const s = agent.decide(call({ prompt: 'grep for TODO and list them', description: 'find todos' }), red, cfg, NOW, noDef);
  assert.equal(s.model, 'haiku');
  const o = agent.decide(call({ prompt: 'implement the parser', description: 'impl' }), red, cfg, NOW, noDef);
  assert.equal(o.action, 'inject');
  assert.equal(o.model, 'sonnet');
});

test('agent-model: inject returns the whole input plus model, no permissionDecision', () => {
  const input = call({ prompt: 'implement the parser', description: 'impl', subagent_type: 'general-purpose', run_in_background: false });
  const d = agent.decide(input, red, cfg, NOW, noDef);
  const out = agent.output(input, d).hookSpecificOutput;
  assert.deepEqual(out.updatedInput, { prompt: 'implement the parser', description: 'impl', subagent_type: 'general-purpose', run_in_background: false, model: 'sonnet' });
  assert.equal(out.permissionDecision, undefined);
  assert.ok(out.additionalContext.includes('sonnet'));
});

test('agent-model: modes suggest / off', () => {
  const input = call({ prompt: 'implement the parser', description: 'impl' });
  const s = agent.decide(input, red, Object.assign({}, cfg, { mode: 'suggest' }), NOW, noDef);
  assert.equal(s.action, 'suggest');
  assert.equal(agent.output(input, s).hookSpecificOutput.updatedInput, undefined);
  assert.equal(agent.decide(input, red, Object.assign({}, cfg, { mode: 'off' }), NOW, noDef).action, 'pass');
});

test('agent-model: run() ignores other tools and bad input without throwing output', () => {
  assert.equal(agent.run(JSON.stringify({ tool_name: 'Bash', tool_input: {} })), '');
  assert.throws(() => agent.run('not json')); // main wrapper swallows this and exits 0
});

test('nudge: only on grade change, once per grade', () => {
  const ev = { hook_event_name: 'UserPromptSubmit' };
  const g = st(week(40, 0.5));
  const y = st(week(55, 0.5));
  const r = st(week(80, 0.5));
  assert.equal(nudge.decide(ev, g, cfg, NOW, undefined).text, null); // first green: silent
  const d1 = nudge.decide(ev, y, cfg, NOW, 'green');
  assert.ok(d1.text);
  assert.equal(nudge.decide(ev, y, cfg, NOW, d1.grade).text, null); // duplicate suppressed
  const d2 = nudge.decide(ev, r, cfg, NOW, 'yellow');
  assert.ok(d2.text);
  assert.equal(nudge.decide(ev, r, cfg, NOW, 'red').text, null);
  assert.equal(nudge.decide(ev, g, cfg, NOW, 'red').text, null); // back to green: silent
});

test('nudge: SessionStart repeats red; messages distinguish windows', () => {
  const r = st(week(80, 0.5));
  assert.ok(nudge.decide({ hook_event_name: 'SessionStart' }, r, cfg, NOW, 'red').text);
  const m7 = nudge.decide({ hook_event_name: 'UserPromptSubmit' }, r, cfg, NOW, 'green').text;
  const m5 = nudge.decide({ hook_event_name: 'UserPromptSubmit' }, st(week(10, 0.5), five(95, 0.5)), cfg, NOW, 'green').text;
  assert.ok(/weekly/.test(m7) && /5-hour/.test(m5));
});

test('nudge: run() persists per-session grade', () => {
  const state = st(week(80, 0.5));
  state.recorded_at = Math.floor(Date.now() / 1000);
  state.seven_day.resets_at = state.recorded_at + Math.round(pace.WEEK * 0.5);
  pace.writeState(state);
  const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });
  assert.ok(nudge.run(raw).includes('additionalContext'));
  assert.equal(nudge.run(raw), '');
});

test('statusline: no rate_limits => context only, no state written', () => {
  fs.rmSync(path.join(TMP, 'state.json'), { force: true });
  const out = statusline.run(JSON.stringify({ context_window: { used_percentage: 41.3 } }));
  assert.equal(out, 'ctx 41%');
  assert.equal(fs.existsSync(path.join(TMP, 'state.json')), false);
  assert.equal(statusline.run('garbage'), '');
});

test('statusline: records rate_limits and prints segment', () => {
  const now = Math.floor(Date.now() / 1000);
  const out = statusline.run(JSON.stringify({
    context_window: { used_percentage: 10 },
    rate_limits: { seven_day: { used_percentage: 80, resets_at: now + Math.round(pace.WEEK * 0.5) },
                   five_hour: { used_percentage: 85, resets_at: now + Math.round(pace.FIVE * 0.5) } },
  }));
  assert.ok(out.startsWith('7d 80%'));
  assert.ok(out.includes('🔴') && out.includes('5h 85%') && out.includes('ctx 10%'));
  assert.equal(pace.readState().seven_day.pct, 80);
});

test('statusline: wrap command output is kept', () => {
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ wrap: 'node -e "process.stdout.write(\'base\')"' }));
  const out = statusline.run(JSON.stringify({ context_window: { used_percentage: 5 } }));
  fs.rmSync(path.join(TMP, 'config.json'));
  assert.ok(out.startsWith('base'));
  assert.ok(out.includes('ctx 5%'));
});
