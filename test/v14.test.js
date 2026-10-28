'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// 0.4.9-fleet W5: agent-model run() wiring (TEST-PLAN-v2 W5): fleet scan -> decide -> event fleet_running.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stamina-v14-'));
process.env.TOKEN_STAMINA_HOME = path.join(TMP, 'home');
const am = require('../scripts/agent-model');
const pace = require('../scripts/pace');
const savings = require('../scripts/savings');

const NOW = Math.floor(Date.now() / 1000);
const proj = path.join(TMP, 'projects', 'p');
const transcript = path.join(proj, 'sess1.jsonl');
const subDir = path.join(proj, 'sess1', 'subagents');
const evFile = () => path.join(pace.home(), 'events.jsonl');

function reset(cfg, state) {
  fs.rmSync(pace.home(), { recursive: true, force: true });
  fs.mkdirSync(pace.home(), { recursive: true });
  fs.writeFileSync(path.join(pace.home(), 'state.json'), JSON.stringify(state === undefined
    ? { seven_day: { pct: 55, resets_at: NOW + 302400 }, recorded_at: NOW } : state));
  fs.writeFileSync(path.join(pace.home(), 'config.json'), JSON.stringify(Object.assign({ lang: 'en' }, cfg || {})));
}
function metas(n) {
  fs.rmSync(path.join(proj, 'sess1'), { recursive: true, force: true });
  fs.mkdirSync(subDir, { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(subDir, 'agent-a' + i + '.meta.json'), JSON.stringify({ description: 'x', model: 'opus' }));
}
const call = (extra, tool) => JSON.stringify(Object.assign({ tool_name: tool || 'Agent', session_id: 's1', tool_use_id: 't1', cwd: TMP,
  tool_input: { subagent_type: 'general-purpose', description: 'collect logs' } }, extra));
const lastEvent = () => { const l = fs.readFileSync(evFile(), 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]); };

test('W5-1: yellow + 3 running -> updatedInput.model sonnet/haiku, event fleet_running 3', () => {
  reset(); metas(3);
  const out = JSON.parse(am.run(call({ transcript_path: transcript })));
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'haiku'); // "collect" is a simple keyword
  assert.equal(lastEvent().fleet_running, 3);
  assert.equal(lastEvent().reason, 'fleet_yellow');
});

test('W5-2: no transcript_path -> fleet_running null, pre-fleet decision', () => {
  reset(); metas(3);
  assert.equal(am.run(call({})), '');
  assert.equal(lastEvent().fleet_running, null);
});

test('W5-3: no subagents folder -> running 0, pre-fleet decision', () => {
  reset(); fs.rmSync(path.join(proj, 'sess1'), { recursive: true, force: true });
  assert.equal(am.run(call({ transcript_path: transcript })), '');
  assert.equal(lastEvent().fleet_running, 0);
});

test('W5-4: fleet:false -> fleet_running null', () => {
  reset({ fleet: false }); metas(3);
  assert.equal(am.run(call({ transcript_path: transcript })), '');
  assert.equal(lastEvent().fleet_running, null);
});

test('W5-5: legacy tool name Task behaves the same; non-agent tools are ignored', () => {
  reset(); metas(3);
  const out = JSON.parse(am.run(call({ transcript_path: transcript }, 'Task')));
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'haiku');
  assert.equal(lastEvent().fleet_running, 3);
  assert.equal(am.run(call({ transcript_path: transcript }, 'Bash')), '');
});

test('W5: below the threshold the call is still recorded with its count', () => {
  reset(); metas(1);
  assert.equal(am.run(call({ transcript_path: transcript })), '');
  assert.equal(lastEvent().fleet_running, 1);
});

test('W5: a bad transcript_path never breaks the hook', () => {
  reset();
  for (const tp of [123, {}, '\0bad', 'x']) assert.doesNotThrow(() => am.run(call({ transcript_path: tp })));
});

test('W5-6: savings counts reason fleet_yellow inject (reason-agnostic)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'savings.js'), 'utf8');
  assert.match(src, /e\.action !== 'inject'\) continue/);
  assert.doesNotMatch(src, /red_downgrade/);
  assert.ok(savings);
});
