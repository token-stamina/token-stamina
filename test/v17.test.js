'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// W9-1g: default config keys == code constants, protected-by-default shape, fixed applied_by, agentModelDefault in the
// agent-model hook, commands/board.md steps 7-11, real home config bytes untouched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REAL_CFG = path.join(require('./helpers/temp-home').REAL_HOME, '.claude', 'token-stamina', 'config.json');
const hashReal = () => { try { return crypto.createHash('sha1').update(fs.readFileSync(REAL_CFG)).digest('hex'); } catch (e) { return 'absent'; } };
const REAL_BEFORE = hashReal();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-v17-'));
process.env.TOKEN_STAMINA_HOME = TMP;
const pace = require('../scripts/pace');
const D = require('../scripts/decisions');
const board = require('../scripts/board');
const agent = require('../scripts/agent-model');

const DEF = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.default.json'), 'utf8'));

test('config.default.json decision keys equal the code constants', () => {
  for (const k of Object.keys(D.DECISION_DEFAULTS)) assert.deepEqual(DEF[k], D.DECISION_DEFAULTS[k], k);
  assert.equal(DEF.agentModelDefault, null);
  assert.deepEqual(DEF.sessionRules, {});
  assert.deepEqual(DEF.managerProtectKeywords, D.PROTECT_KEYWORDS_DEFAULT);
  assert.deepEqual(board.DEFAULTS.managerProtectKeywords, D.PROTECT_KEYWORDS_DEFAULT);
  assert.ok(D.PROTECT_KEYWORDS_DEFAULT.includes('trading'));
});

test('protection by default: trading folders, managerProtectSegments, bot folders, case-insensitive, one function', () => {
  const none = {}; // no managerExcludeCwd at all
  for (const p of ['C:\\Trading\\x', 'c:\\trading\\x', 'D:/work/trading/z']) {
    assert.equal(board.isProtected(p, none), true, p);
    assert.equal(D.textProtected(p, none), true, p);
  }
  assert.equal(board.isProtected('C:\\Claude\\misc\\token-saver', none), false);
  // bot work folders from excludeCwd are protected too (the owner config lists them there)
  const owner = { excludeCwd: ['mybot_work', 'otherbot_work'] };
  assert.equal(board.isProtected('C:\\Claude\\OtherBot_Work\\a', owner), true);
  // a config that replaces the keyword list cannot unprotect the folder names
  assert.equal(board.isProtected('C:\\Trading\\x', { managerProtectKeywords: [] }), true);
  // managerProtectSegments: default protects only "trading"; a custom list replaces it; [] leaves keywords only
  assert.equal(board.isProtected('C:\\Claude\\ARCHIVE-X\\y', none), false);
  assert.equal(board.isProtected('C:\\Claude\\TRADING-ARCHIVE\\y', { managerProtectKeywords: [] }), false);
  const seg = { managerProtectSegments: ['trading-archive'], managerProtectKeywords: [] };
  assert.equal(board.isProtected('C:\\Claude\\TRADING-ARCHIVE\\y', seg), true);
  assert.equal(D.textProtected('C:\\Claude\\TRADING-ARCHIVE\\y', seg), true);
  assert.equal(D.textProtected('C:\\Trading\\x', seg), false);
  assert.equal(D.textProtected('C:\\Trading\\x', { managerProtectSegments: [], managerProtectKeywords: [] }), false);
  assert.equal(D.textProtected('C:\\Trading\\x', { managerProtectSegments: [] }), true); // keyword default still matches
  assert.deepEqual(DEF.managerProtectSegments, D.PROTECT_SEGMENTS);
  // row flag from the real row builder, and the decision-side check agree
  const m = board.metrics([], null, 1000, DEF);
  const r = board.row({ sid: 's1', cwd: 'C:\\Trading\\claude-trading' }, m, {}, 1000, {});
  assert.equal(r.protected, true);
  assert.equal(D.rowProtected({ cwd_tail: 'Trading' }, {}), true);
});

test('applied_by is the fixed value "sync" (no host name)', () => {
  const b = D.batchFor([{ pid: 'sm-aaaaaaaaaaaa', status: 'applied', recorded_at: '2026-10-27T00:00:00Z' }], null, 'MYPClocal');
  assert.equal(b.writes[0].data.applied_by, 'sync');
  assert.equal(D.safeHost('MYPClocal'), 'sync');
});

// ---- agent-model: agentModelDefault
const NOW = 1_800_000_000;
const week = (u, e) => ({ pct: u, resets_at: NOW + Math.round(pace.WEEK * (1 - e)) });
const st = (d7) => ({ seven_day: d7, recorded_at: NOW });
const green = st(week(40, 0.5));
const red = st(week(80, 0.5));
const base = Object.assign({}, pace.loadConfig(), { lang: 'en' });
const call = (ti, extra) => Object.assign({ tool_name: 'Agent', tool_input: ti, cwd: TMP }, extra);
const noDef = { definitionHasModel: () => false };
const dec = (ti, state, c, extra) => agent.decide(call(ti, extra), state, Object.assign({}, base, c), NOW, noDef);

test('agent-model: agentModelDefault null/absent changes nothing', () => {
  assert.equal(pace.loadConfig().agentModelDefault, null);
  assert.equal(dec({ prompt: 'implement the parser', description: 'impl' }, green, {}).action, 'pass');
  assert.equal(dec({ prompt: 'implement the parser', description: 'impl' }, green, { agentModelDefault: 'opus' }).action, 'pass');
});

test('agent-model: default applies to a model-less Agent call, even when usage is green', () => {
  const d = dec({ prompt: 'implement the parser', description: 'impl' }, green, { agentModelDefault: 'sonnet' });
  assert.equal(d.action, 'inject'); assert.equal(d.reason, 'agent_default'); assert.equal(d.model, 'sonnet');
  assert.equal(agent.output(call({ prompt: 'x' }), d).hookSpecificOutput.updatedInput.model, 'sonnet');
  // no state at all: still applies (the owner approved it)
  assert.equal(dec({ prompt: 'implement', description: 'x' }, null, { agentModelDefault: 'haiku' }).model, 'haiku');
});

test('agent-model: pressure downgrade and default - the lower model wins', () => {
  // red + simple words -> haiku from the pressure rule; default sonnet must not raise it
  const a = dec({ prompt: 'grep for TODO and list them', description: 'find todos' }, red, { agentModelDefault: 'sonnet' });
  assert.equal(a.model, 'haiku'); assert.notEqual(a.reason, 'agent_default');
  // red + normal work -> sonnet from the pressure rule; default haiku is lower -> haiku
  const b = dec({ prompt: 'implement the parser', description: 'impl' }, red, { agentModelDefault: 'haiku' });
  assert.equal(b.action, 'inject'); assert.equal(b.model, 'haiku');
  // same level -> the pressure result is returned unchanged
  const c = dec({ prompt: 'implement the parser', description: 'impl' }, red, { agentModelDefault: 'sonnet' });
  assert.equal(c.reason, 'red_downgrade');
});

test('agent-model: exceptions stay - judgment word, explicit model, fork, definition model, suggest mode, start_session', () => {
  const c = { agentModelDefault: 'sonnet' };
  assert.notEqual(dec({ prompt: 'review the architecture', description: 'design' }, green, c).action, 'inject');
  assert.notEqual(dec({ prompt: 'review the architecture', description: 'x' }, red, c).action, 'inject');
  assert.equal(dec({ prompt: 'x', model: 'opus' }, green, c).reason, 'has_model');
  assert.equal(dec({ prompt: 'x', subagent_type: 'fork' }, green, c).reason, 'fork');
  assert.equal(agent.decide(call({ prompt: 'x', subagent_type: 'mine' }), green, Object.assign({}, base, c), NOW, { definitionHasModel: () => true }).reason, 'definition_model');
  assert.notEqual(dec({ prompt: 'implement', description: 'x' }, green, Object.assign({ mode: 'suggest' }, c)).action, 'inject');
  assert.equal(dec({ prompt: 'implement', description: 'x' }, green, Object.assign({ mode: 'off' }, c)).reason, 'mode_off');
  assert.equal(dec({ prompt: 'implement', description: 'x' }, green, c, { kind: 'session' }).action, 'pass');
});

test('commands/board.md: Haiku first line kept, steps 7-11 present with the hard rules', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'commands', 'board.md'), 'utf8');
  assert.ok(/\r?\n\r?\nHaiku 세션에서 돌리세요/.test(md));
  for (const s of ['--apply', '--record-apply', '--live', '--self', 'set_session_model', 'offer_clear', 'unexpected_tool_result', 'settings/requested', 'decisions', 'proposals']) assert.ok(md.includes(s), s);
  assert.ok(/clear_session[^\r\n]*(직접|호출하지|않아요)/.test(md), 'clear_session is forbidden as a direct call');
  assert.ok(/3/.test(md.slice(md.indexOf('회차'))), 'round limit 3');
  const fm = md.split('---')[1];
  assert.ok(fm.includes('mcp__ccd_session_mgmt__get_session') && fm.includes('mcp__ccd_session_mgmt__set_session_model'));
  assert.ok(!fm.includes('clear_session'), 'clear_session is not in allowed-tools');
});

// H2: the start_session hook (sessionModelInject:true by default) must not put a model into a protected session.
function sessionHook(toolInput, lang, extra) {
  const { spawnSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-h2-'));
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ seven_day: { pct: 95, resets_at: now + 86400, recorded_at: now },
    five_hour: { pct: 50, resets_at: now + 3600, recorded_at: now }, recorded_at: now }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ lang }));
  const input = Object.assign({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'mcp__ccd_session__start_session', cwd: 'C:\\Claude', tool_input: toolInput }, extra || {});
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'agent-model.js')], { input: JSON.stringify(input),
    env: Object.assign({}, process.env, { TOKEN_STAMINA_HOME: home, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), encoding: 'utf8' });
  let ev = null;
  try { ev = JSON.parse(fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').pop()); } catch (e) { /* none */ }
  return { stdout: r.stdout, ev };
}

test('H2: start_session into a protected session (Trading cwd, trading prompt, no cwd) gets no model', () => {
  const cases = [
    { cwd: 'C:\\Trading', title: 'trade check', prompt: 'trading log cleanup' },
    { cwd: 'C:\\Trading', title: 'logs', prompt: 'collect logs' },
    { cwd: 'C:\\Work\\proj', title: 'logs', prompt: 'trading ledger summary' },
    { title: 'logs', prompt: 'collect logs' }, // cwd unknown -> protected
  ];
  for (const ti of cases) {
    const r = sessionHook(ti, 'ko');
    assert.equal(r.stdout, '', JSON.stringify(ti));
    assert.equal(r.ev && r.ev.reason, 'protected', JSON.stringify(ti));
  }
  // the calling session's own cwd protects too
  const r = sessionHook({ cwd: 'C:\\Work\\proj', title: 'logs', prompt: 'collect logs' }, 'en', { cwd: 'C:\\Trading\\claude-trading' });
  assert.equal(r.stdout, '');
  assert.equal(agent.sessionProtected({ tool_input: { cwd: 'C:\\Work\\proj', title: 'x', prompt: 'y' }, cwd: 'C:\\Claude' }, {}), false);
});

test('H2: an ordinary start_session is still downgraded on red, with session wording (ko/en), never "this subagent"', () => {
  for (const lang of ['ko', 'en']) {
    const r = sessionHook({ cwd: 'C:\\Work\\proj', title: 'collect logs', prompt: 'collect the build logs' }, lang);
    const out = JSON.parse(r.stdout);
    assert.ok(['sonnet', 'haiku'].includes(out.hookSpecificOutput.updatedInput.model));
    assert.equal(out.hookSpecificOutput.updatedInput.cwd, 'C:\\Work\\proj');
    const msg = out.hookSpecificOutput.additionalContext;
    assert.ok(lang === 'ko' ? msg.includes('이 새 세션') : msg.includes('this new session'), msg);
    assert.ok(!msg.includes('for this subagent') && !msg.includes('이 하위 에이전트'), msg);
    assert.equal(r.ev.reason, 'red_downgrade');
  }
  // every session row that names a target is overridden in both tables
  for (const lang of ['en', 'ko']) {
    const t = agent.textsFor({ kind: 'session' }, lang);
    for (const k of Object.keys(agent.T_SESSION.en)) {
      const s = String(t[k]('7d', 'sonnet', 'red', '7d'));
      assert.ok(!s.includes('this subagent') && !s.includes('이 하위 에이전트') && !s.includes('description') && !s.includes('설명에'), k + ': ' + s);
    }
  }
});

test('real home config.json bytes unchanged by this file', () => {
  assert.equal(hashReal(), REAL_BEFORE);
});
