'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// W9-1a: layer-0 efficiency rows (scripts/board.js). Fixtures in test/fixtures/board/ with hand-computed expected.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FX = path.join(__dirname, 'fixtures', 'board');
const EXP = JSON.parse(fs.readFileSync(path.join(FX, 'expected.json'), 'utf8'));
const T0 = 1793145600;

// Isolated data folder (never the real home).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-board-'));
process.env.TOKEN_STAMINA_HOME = HOME;
const board = require('../scripts/board');
const pace = require('../scripts/pace');

const load = (n) => board.turnsFromTail(fs.readFileSync(path.join(FX, n + '.jsonl'), 'utf8'));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const cfg = Object.assign({}, pace.loadConfig(), { lang: 'en' });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Runs the real hook script in a child process with an isolated home. Returns the board folder's file names.
function hookRun(home, input, userCfg, env) {
  if (userCfg) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(userCfg));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'board.js')], {
    input: JSON.stringify(input), env: Object.assign({}, process.env, { TOKEN_STAMINA_HOME: home, CLAUDE_CODE_ENTRYPOINT: 'cli' }, env || {}), encoding: 'utf8',
  });
  let files = [];
  try { files = fs.readdirSync(path.join(home, 'board')); } catch (e) { /* none */ }
  return { status: r.status, stdout: r.stdout, files };
}

test('E1: A in_last / in_med10 / trend sign / spark', () => {
  const m = board.metrics(load('A'), null, T0 + 1600, cfg);
  const e = EXP.A;
  assert.equal(m.sample_turns, e.sample_turns);
  assert.equal(m.in_last, e.in_last);
  assert.equal(m.in_med10, e.in_med10);
  assert.equal(m.in_trend, e.in_trend);
  assert.ok(m.in_trend > 0);
  assert.equal(m.spark.length, e.spark_len);
  assert.equal(m.spark[0], e.spark_first);
  assert.equal(m.spark[19], e.spark_last);
  assert.equal(m.ctx_tokens, e.ctx_tokens);
  assert.equal(m.last_user_ts, e.last_user_ts);
  assert.equal(m.last_ts, e.last_ts);
});

test('E1: B has 8 turns -> sample_turns 8, spark = turn count, trend null', () => {
  const m = board.metrics(load('B'), null, T0 + 600, cfg);
  assert.equal(m.sample_turns, 8);
  assert.equal(m.spark.length, 8);
  assert.equal(m.in_trend, null);
  assert.equal(m.fit, 'fit');
});

test('E2: A hit 0.9; C three idle misses excluded from hit_active; zero denominator -> null', () => {
  const a = board.metrics(load('A'), null, T0 + 1600, cfg);
  near(a.hit, 0.9); near(a.hit_active, 0.9); assert.equal(a.miss_after_idle, 0);
  const c = board.metrics(load('C'), null, T0 + 5000, cfg);
  assert.equal(c.miss_after_idle, EXP.C.miss_after_idle);
  near(c.hit, EXP.C.hit); near(c.hit_active, EXP.C.hit_active);
  const zero = [{ ts: 1, role: 'assistant', model: 'claude-opus-5', usage: { input: 0, cache_read: 0, cache_creation: 0, output: 5 } }];
  const z = board.metrics(zero, null, 100, cfg);
  assert.equal(z.hit, null); assert.equal(z.hit_active, null);
});

test('E3: lower_candidate, judgment_on_lower, en/ja/ko keyword lists, always estimated', () => {
  const a = board.metrics(load('A'), null, T0 + 1600, cfg);
  assert.equal(a.fit, 'lower_candidate'); assert.equal(a.estimated, true); assert.equal(a.j, 0);
  const b = load('B');
  const jp = board.metrics(b, ['please design this', 'architecture review', 'security audit'], T0 + 600, cfg);
  assert.equal(jp.fit, 'judgment_on_lower'); assert.ok(jp.j >= 3);
  assert.equal(board.metrics(b, ['x'], 1, cfg).j, 0);
  assert.equal(board.metrics(b, ['design it'], 1, cfg).j, 1);
  assert.equal(board.metrics(b, ['設計して'], 1, cfg).j, 1);
  assert.equal(board.metrics(b, ['설계 해줘'], 1, cfg).j, 1);
  assert.equal(board.metrics(load('A'), ['review the design'], 1, cfg).fit, 'fit');
});

test('E4: clear_candidate boundary 1799 / 1800 with ctx >= gate', () => {
  const t = load('A');
  const c2 = Object.assign({}, cfg, { gateAtTokens: 1500 });
  assert.equal(board.metrics(t, null, EXP.A.last_user_ts + 1799, c2).clear_candidate, false);
  assert.equal(board.metrics(t, null, EXP.A.last_user_ts + 1800, c2).clear_candidate, true);
  assert.equal(board.metrics(t, null, EXP.A.last_user_ts + 1800, Object.assign({}, cfg, { gateAtTokens: 2001 })).clear_candidate, false);
});

test('W7 E5 unit: notification totalTokens (a last-turn value) is parsed but never summed into agent tokens', () => {
  const t = load('D');
  assert.deepEqual(t.filter((x) => x.is_task_notification).map((x) => x.total_tokens), EXP.D.notified_last_turn_totals);
  const d = board.metrics(t, null, T0 + 400, cfg);
  assert.deepEqual(d.agent_done_ids, EXP.D.agent_done_ids);
  assert.equal(d.main_tokens_sum, EXP.D.main_tokens_sum);
  assert.ok(!('agent_tokens_done' in d));
  assert.deepEqual(board.metrics(load('A'), null, T0, cfg).agent_done_ids, []);
  const txt = board.turnsFromTail(JSON.stringify({ type: 'attachment', timestamp: '2026-10-28T00:00:00Z', attachment: { type: 'queued_command', prompt: '<task-notification><task-id>y</task-id><usage><subagent_tokens>777</subagent_tokens></usage></task-notification>' } }));
  assert.equal(txt[0].total_tokens, 777);
  assert.deepEqual(board.metrics(txt, null, 1, cfg).agent_done_ids, ['y']);
  // row(): only the caller's same-unit doneTokens count
  const r = board.row({ sid: 's', cwd: 'x' }, d, { running: 0, items: [] }, T0, cfg);
  assert.equal(r.agent_tokens_done, null);
  assert.equal(r.agent_share, null);
});

test('W7 E5: done (own transcripts) + live tokens + main in one unit -> row share (fixture copied so mtime is fresh)', () => {
  const dir = tmp('ts-boardfx-');
  fs.cpSync(FX, dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  // cpSync keeps the source mtime on Windows, so touch the agent files or they age past fleetStaleSec.
  for (const f of fs.readdirSync(path.join(dir, 'D', 'subagents'))) fs.utimesSync(path.join(dir, 'D', 'subagents', f), now, now);
  const r = board.buildRow({ session_id: 'sidD', transcript_path: path.join(dir, 'D.jsonl'), cwd: 'C:\\Work\\proj' }, 'claude-desktop', now, cfg);
  assert.equal(r.agents_running, EXP.D.agents_running);
  assert.equal(r.agent_tokens_done, EXP.D.agent_tokens_done);
  assert.equal(r.agent_tokens_live, EXP.D.agent_tokens_live);
  near(r.agent_share, EXP.D.agent_share);
});

test('E: no assistant turns -> nulls, not zeros', () => {
  const m = board.metrics(load('E'), null, T0 + 100, cfg);
  for (const k of ['in_last', 'in_med10', 'in_trend', 'hit', 'hit_active', 'ctx_tokens', 'fit', 'model']) assert.equal(m[k], null, k);
  assert.equal(m.sample_turns, 0); assert.deepEqual(m.spark, []);
});

test('suggest: priority and null', () => {
  const normal = { sample_turns: 20, hit: 0.9, hit_active: 0.9, miss_after_idle: 0, fit: 'fit', clear_candidate: false, in_med10: 50000, agents_running: 0, agent_tokens_done: 5, agents_upper: 0, agent_share: 0.1 };
  const en = { lang: 'en' };
  assert.equal(board.suggest(normal, { grade: 'green' }, en), null);
  const both = Object.assign({}, normal, { clear_candidate: true, fit: 'lower_candidate' });
  const red = board.suggest(both, { grade: 'red' }, en);
  assert.match(red, /Budget is red/); assert.ok(!red.includes('\n'));
  assert.match(board.suggest(both, { grade: 'green' }, en), /Clear candidate/);
  assert.match(board.suggest(Object.assign({}, normal, { fit: 'lower_candidate' }), {}, en), /Sonnet/);
  assert.match(board.suggest(Object.assign({}, normal, { hit_active: 0.4 }), {}, en), /re-read/);
  assert.match(board.suggest(Object.assign({}, normal, { in_med10: 210000 }), {}, en), /topic changes/);
  assert.match(board.suggest(Object.assign({}, normal, { in_med10: 410000 }), {}, en), /new session/i);
  assert.match(board.suggest(Object.assign({}, normal, { agent_share: 0.8, agents_upper: 1 }), {}, en), /subagent model/);
  assert.match(board.suggest(normal, { stale: true }, en), /stale/);
});

test('suggest: ko / en / ja snapshots for the same state', () => {
  const r = { sample_turns: 20, fit: 'lower_candidate', clear_candidate: false, hit_active: 0.9, hit: 0.9, miss_after_idle: 0 };
  assert.equal(board.suggest(r, {}, { lang: 'ko' }), '이 세션은 Sonnet 으로 낮춰도 돼요(앱 모델 메뉴).');
  assert.equal(board.suggest(r, {}, { lang: 'en' }), 'This session can run on Sonnet (app model menu).');
  assert.equal(board.suggest(r, {}, { lang: 'ja' }), 'このセッションは Sonnet で十分です(アプリのモデルメニュー)。');
  assert.equal(board.suggest(r, {}, { lang: 'zh' }), board.suggest(r, {}, { lang: 'en' }));
});

test('row: whitelist keys only, no prompt / full path / transcript path; cwd_tail is the last folder', () => {
  const m = board.metrics(load('A'), null, T0 + 1600, cfg);
  const r = board.row({ sid: 's1', cwd: 'C:\\Users\\x\\secret-project', entrypoint: 'cli', transcript_path: 'C:\\a\\b.jsonl' }, m, { running: 0, items: [] }, T0 + 1600, cfg);
  assert.deepEqual(Object.keys(r).sort(), board.ROW_KEYS.slice().sort());
  assert.equal(r.cwd_tail, 'secret-project');
  const s = JSON.stringify(r);
  assert.ok(!s.includes('hello number') && !s.includes('Users') && !s.includes('b.jsonl'));
  assert.equal(r.updated_at, new Date((T0 + 1600) * 1000).toISOString());
});

test('protected: managerExcludeCwd match; bot folder (excludeCwd) writes no row', () => {
  const m = board.metrics(load('A'), null, T0, cfg);
  const mk = (cwd, c) => board.row({ sid: 's', cwd }, m, {}, T0, Object.assign({}, cfg, c));
  assert.equal(mk('C:\\Trading\\x', { managerExcludeCwd: ['Trading'] }).protected, true);
  assert.equal(mk('C:\\Work\\x', { managerExcludeCwd: ['Trading'] }).protected, false);
  // W9-1g decision: the Trading folder is protected by code default even with no config (was false before).
  assert.equal(mk('C:\\Trading\\x', {}).protected, true);
  const out = hookRun(tmp('ts-botrow-'), { hook_event_name: 'Stop', session_id: 'botsid', transcript_path: path.join(FX, 'A.jsonl'), cwd: 'C:\\Trading\\claude-trading' }, { excludeCwd: ['claude-trading'] });
  assert.equal(out.files.length, 0);
});

test('hook: writes board/<sid>.json; sdk entrypoint, board:false, bad sid, wrong event write nothing', () => {
  const home = tmp('ts-boardhook-');
  const input = { hook_event_name: 'Stop', session_id: 'abc-123', transcript_path: path.join(FX, 'A.jsonl'), cwd: 'C:\\Work\\proj' };
  const ok = hookRun(home, input);
  assert.equal(ok.status, 0); assert.equal(ok.stdout, '');
  assert.deepEqual(ok.files, ['abc-123.json']);
  const row = JSON.parse(fs.readFileSync(path.join(home, 'board', 'abc-123.json'), 'utf8'));
  assert.equal(row.sid, 'abc-123'); assert.equal(row.in_med10, 2000); assert.equal(row.cwd_tail, 'proj');
  assert.equal(hookRun(tmp('ts-b2-'), input, null, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }).files.length, 0);
  assert.equal(hookRun(tmp('ts-b3-'), input, { board: false }).files.length, 0);
  assert.equal(hookRun(tmp('ts-b4-'), Object.assign({}, input, { session_id: '../evil' })).files.length, 0);
  assert.equal(hookRun(tmp('ts-b5-'), Object.assign({}, input, { hook_event_name: 'SessionStart' })).files.length, 0);
  // nothing but board/ (and the fleet memo) appears in the home
  assert.ok(fs.readdirSync(home).every((n) => ['board', 'fleet-cache.json'].includes(n)), fs.readdirSync(home).join());
});

test('readBoard: 25h row excluded, broken json skipped, manager.json ignored; prune touches only the board folder', () => {
  const home = tmp('ts-rb-');
  process.env.TOKEN_STAMINA_HOME = home;
  try {
    const now = 1_800_000_000;
    const dir = path.join(home, 'board');
    fs.mkdirSync(dir, { recursive: true });
    const w = (n, o) => fs.writeFileSync(path.join(dir, n), typeof o === 'string' ? o : JSON.stringify(o));
    w('fresh.json', { sid: 'fresh', updated_at: new Date((now - 60) * 1000).toISOString() });
    w('old.json', { sid: 'old', updated_at: new Date((now - 25 * 3600) * 1000).toISOString() });
    w('broken.json', '{"sid":');
    w('manager.json', { log: [] });
    fs.writeFileSync(path.join(home, 'state.json'), '{}');
    assert.deepEqual(board.readBoard(now, cfg).map((r) => r.sid), ['fresh']);
    assert.deepEqual(board.prune(now, cfg).sort(), ['old.json']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['broken.json', 'fresh.json', 'manager.json']);
    assert.ok(fs.existsSync(path.join(home, 'state.json')));
  } finally { process.env.TOKEN_STAMINA_HOME = HOME; }
});

test('H1: Stop board.run() keeps board/decisions.json (prune deletes rows by shape, not by name)', () => {
  const home = tmp('ts-h1-');
  process.env.TOKEN_STAMINA_HOME = home;
  try {
    const dir = path.join(home, 'board');
    fs.mkdirSync(dir, { recursive: true });
    const ledger = JSON.stringify({ rows: [{ pid: 'p1', status: 'applied', recorded_at: new Date().toISOString() }], proposals: {} });
    fs.writeFileSync(path.join(dir, 'decisions.json'), ledger);
    // a file whose content sid differs from its name is not a row either, even when expired
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ sid: 'someone-else', updated_at: '2000-01-01T00:00:00Z' }));
    const input = { hook_event_name: 'Stop', session_id: 'h1-sid', transcript_path: path.join(FX, 'A.jsonl'), cwd: 'C:\Work\proj' };
    board.run(JSON.stringify(input));
    board.run(JSON.stringify(input));
    assert.equal(fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8'), ledger);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['decisions.json', 'h1-sid.json', 'other.json']);
    assert.equal(board.isRowFile('decisions.json', JSON.parse(ledger)), false);
    assert.equal(board.isRowFile('h1-sid.json', { sid: 'h1-sid' }), true);
    // a session whose id is "decisions" cannot overwrite the ledger either
    assert.equal(board.writeRow({ sid: 'decisions', updated_at: new Date().toISOString() }), false);
    assert.equal(fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8'), ledger);
  } finally { process.env.TOKEN_STAMINA_HOME = HOME; }
});

test('tail read: a 5 MiB file is read only boardTailBytes (readTail result + readSync length)', () => {
  const f = path.join(tmp('ts-big-'), 'big.jsonl');
  const line = JSON.stringify({ type: 'user', timestamp: '2026-10-28T00:00:00Z', message: { role: 'user', content: 'x'.repeat(900) } }) + '\n';
  fs.writeFileSync(f, line.repeat(Math.ceil(5 * 1024 * 1024 / line.length)));
  const text = board.readTail(f, 262144);
  assert.ok(text.length <= 262144 && text.length > 200000, String(text.length));
  assert.ok(text.startsWith('{'));
  const orig = fs.readSync; let maxLen = 0;
  fs.readSync = function (fd, buf, off, len) { maxLen = Math.max(maxLen, len); return orig.apply(this, arguments); };
  try { board.buildRow({ session_id: 'big', transcript_path: f, cwd: 'x' }, null, 1, Object.assign({}, cfg, { boardTailBytes: 100000 })); } finally { fs.readSync = orig; }
  assert.ok(maxLen <= 100000 && maxLen > 0, String(maxLen));
});

test('hooks.json and config.default.json carry the board entries', () => {
  const cfgDef = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.default.json'), 'utf8'));
  for (const k of ['board', 'boardTailBytes', 'boardKeepSec', 'boardIdleSec', 'dashboardMaskTitles', 'managerExcludeCwd', 'managerProtectKeywords']) assert.ok(k in cfgDef, k);
  const hj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  for (const ev of ['UserPromptSubmit', 'Stop']) {
    const cmds = JSON.stringify(hj.hooks && hj.hooks[ev]);
    assert.ok(cmds.includes('scripts/board.js') && cmds.includes('"timeout":5'), ev);
  }
});

// ---- W9-1b: --rows / --titles / --record-push ----
const NOW = T0 + 3600;
const iso = (s) => new Date(s * 1000).toISOString();
const baseRow = (sid, over) => Object.assign(board.row({ sid, cwd: 'C:\\x\\' + sid, entrypoint: 'cli' }, board.metrics(load('A'), null, NOW, cfg), { running: 0, items: [] }, NOW, cfg), over || {});
const redState = { seven_day: { pct: 80, resets_at: NOW + 3.5 * 86400 }, five_hour: { pct: 5, resets_at: NOW + 3600 }, recorded_at: NOW - 60 };
const threeRows = () => [baseRow('s1', { hit: 0.9, fit: 'lower_candidate', clear_candidate: false }),
  baseRow('s2', { hit: 0.6, fit: 'fit', clear_candidate: true }), baseRow('s3', { hit: 0.3, fit: 'fit', clear_candidate: false, agents_running: 2 })];
const rcfg = Object.assign({}, cfg, { lang: 'en' });
const payload = (o) => board.rowsPayload(Object.assign({ now: NOW, cfg: rcfg, state: redState, rows: threeRows(), activeSessions: 3, titles: null, versions: null, eventsText: '', last: null, pending: 0, manager: null }, o || {}));

test('rows: 3 rows + red state -> account red, summary counts, <=1 suggestion per session', () => {
  const p = payload();
  assert.equal(p.skip, false);
  assert.equal(p.account.grade, 'red');
  assert.equal(p.account.stale, false);
  assert.equal(p.summary.sessions, 3); assert.equal(p.summary.lower, 1); assert.equal(p.summary.clear, 1); assert.equal(p.summary.agents, 2);
  near(p.summary.hit, 0.6);
  for (const s of p.sessions) assert.ok(s.suggestion === null || (typeof s.suggestion === 'string' && !s.suggestion.includes('\n')));
  assert.match(p.sessions[0].suggestion, /Budget is red/);
  assert.deepEqual(p.log, []);
});

test('rows: stale state -> stale true, no forecast keys anywhere', () => {
  const p = payload({ state: Object.assign({}, redState, { recorded_at: NOW - 7 * 3600 }) });
  assert.equal(p.account.stale, true);
  const all = JSON.stringify(p);
  assert.ok(!/forecast|"eta|exhaust/i.test(all), 'no extrapolated keys');
  assert.match(p.sessions[0].suggestion, /stale|Budget is red/i);
});

test('rows: page key table (every key the page reads exists with the right type)', () => {
  // measured_at is the 7d window's own stamp (L2), so the state carries one as every 0.5 writer does
  const p = payload({ state: Object.assign({}, redState, { seven_day: Object.assign({}, redState.seven_day, { recorded_at: NOW - 60 }) }) });
  const a = p.account;
  for (const k of ['updated_at', 'measured_at', 'resets_at']) assert.ok(!isNaN(Date.parse(a[k])), k);
  for (const k of ['pct_7d', 'pct_5h', 'vs_share_pp']) assert.equal(typeof a[k], 'number', k);
  assert.equal(typeof a.grade, 'string'); assert.equal(typeof a.stale, 'boolean');
  for (const k of ['sessions', 'agents', 'hit', 'lower', 'clear']) assert.ok(k in p.summary, k);
  const s = p.sessions[0];
  for (const k of ['sid', 'cwd_tail', 'model', 'protected', 'in_last', 'in_med10', 'in_trend', 'spark', 'hit', 'hit_active', 'ctx_tokens', 'fit', 'clear_candidate', 'agents_running', 'agent_tokens_done', 'agent_tokens_live', 'sample_turns', 'updated_at', 'last_ts', 'suggestion']) assert.ok(k in s, k);
  assert.ok(!isNaN(Date.parse(s.last_ts)) && !isNaN(Date.parse(s.updated_at)));
  for (const k of Object.keys(s)) assert.ok(board.ROW_KEYS.includes(k) || k === 'title' || k === 'suggestion', k);
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  for (const f of ['lower_candidate', 'fit', 'judgment_on_lower']) assert.ok(html.includes(f + ':'), f);
});

test('rows: batch shape - collections account/summary/sessions, doc ids, if_version only for known docs, deletes for vanished', () => {
  const p = payload({ versions: { 'sessions/s1': 4, 'account/now': 9, 'sessions/gone': 2 } });
  const keys = p.writes.map((w) => `${w.op}:${w.collection}/${w.doc_id}${w.if_version ? '@' + w.if_version : ''}`);
  assert.deepEqual(keys, ['set:account/now@9', 'set:summary/now', 'set:sessions/s1@4', 'set:sessions/s2', 'set:sessions/s3', 'delete:sessions/gone@2']);
  assert.ok(p.writes.length <= 50);
  assert.equal(p.writes[0].data.updated_at, iso(NOW));
});

test('rows: --titles added, dashboardMaskTitles masks to 12 chars + ellipsis', () => {
  const t = [{ sessionId: 's1', title: 'A very long session title indeed' }, { sessionId: 's2', title: 'short' }];
  const open = payload({ titles: t });
  assert.equal(open.sessions[0].title, 'A very long session title indeed');
  const masked = payload({ titles: t, cfg: Object.assign({}, rcfg, { dashboardMaskTitles: true }) });
  assert.equal(masked.sessions[0].title, 'A very long …');
  assert.equal(masked.sessions[1].title, 'short');
  assert.equal(masked.sessions[2].title, undefined);
  assert.equal(board.cleanTitle('a\nb\u0000c', false), 'a b c');
});

test('rows: board_push budget 150,001 -> skip budget (150,000 -> go), hourly retry allowed', () => {
  const ev = (tokens, agoSec) => JSON.stringify({ ts: iso(NOW - agoSec), event: 'board_push', tokens }) + '\n';
  assert.equal(payload({ eventsText: ev(150001, 100), last: { ts: NOW - 100, hash: 'x' } }).reason, 'budget');
  assert.equal(payload({ eventsText: ev(150000, 100), last: { ts: NOW - 100, hash: 'x' } }).skip, false);
  assert.equal(payload({ eventsText: ev(150001, 100) + ev(5, 90000), last: { ts: NOW - 100, hash: 'x' } }).reason, 'budget');
  assert.equal(payload({ eventsText: ev(150001, 4000), last: { ts: NOW - 4000, hash: 'x' } }).skip, false);
  assert.equal(board.pushTokens24h(ev(7, 90000), NOW), 0);
});

test('rows: unchanged skip needs same hash, no pending approvals, fresh last push', () => {
  const first = payload();
  const last = { ts: NOW - 600, hash: first.hash };
  const again = payload({ last });
  assert.equal(again.skip, true); assert.equal(again.reason, 'unchanged');
  assert.equal(payload({ last, pending: 1 }).skip, false);
  assert.equal(payload({ last: { ts: NOW - 1600, hash: first.hash } }).skip, false);
  const drift = payload({ now: NOW + 120, rows: threeRows().map((r) => Object.assign(r, { idle_sec: 999, updated_at: iso(NOW + 100) })) });
  assert.equal(drift.hash, first.hash);
  const changed = payload({ rows: threeRows().map((r) => Object.assign(r, { in_last: 7 })) });
  assert.notEqual(changed.hash, first.hash);
  assert.equal(payload({ last: { ts: NOW - 600, hash: first.hash }, titles: { s1: 'new title' } }).skip, false);
});

test('rows: CLI end to end in an isolated home - files, skip after record-push, event line, log', () => {
  const home = tmp('ts-rows-');
  const run = (...args) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'board.js'), ...args], { env: Object.assign({}, process.env, { TOKEN_STAMINA_HOME: home }), encoding: 'utf8' });
    return JSON.parse(r.stdout);
  };
  const now = Math.floor(Date.now() / 1000);
  fs.mkdirSync(path.join(home, 'board'));
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ seven_day: { pct: 10, resets_at: now + 5 * 86400 }, five_hour: { pct: 1, resets_at: now + 3600 }, recorded_at: now - 30 }));
  const r = baseRow('cli1', { updated_at: iso(now), last_ts: now - 10 });
  fs.writeFileSync(path.join(home, 'board', 'cli1.json'), JSON.stringify(r));
  const out = run('--rows');
  assert.equal(out.skip, false); assert.equal(out.rows, 1); assert.equal(out.writes_count, 3);
  assert.ok(out.writes.every((w) => w.file_path && fs.existsSync(w.file_path)));
  assert.equal(JSON.parse(fs.readFileSync(out.batch_file, 'utf8')).writes.length, 3);
  assert.deepEqual(out.log, []);
  assert.deepEqual(fs.readdirSync(path.join(home, 'board')), ['cli1.json']);
  const rec = run('--record-push', 'tokens=1800', 'rows=1');
  assert.equal(rec.recorded, true);
  const ev = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'board_push');
  assert.equal(ev.length, 1); assert.equal(ev[0].tokens, 1800); assert.equal(ev[0].rows, 1);
  const second = run('--rows');
  assert.equal(second.skip, true); assert.equal(second.reason, 'unchanged');
  assert.equal(run('--rows', '--pending', '1').skip, false);
  fs.writeFileSync(path.join(home, 'board', 'manager.json'), JSON.stringify({ log: [{ ts: 'x', action: 'a' }] }));
  assert.equal(run('--rows', '--pending', '1').log.length, 1);
});

test('rows: readVersions reads a map file and an out_dir tree', () => {
  const d = tmp('ts-ver-');
  fs.mkdirSync(path.join(d, 'sessions')); fs.mkdirSync(path.join(d, 'account'));
  fs.writeFileSync(path.join(d, 'sessions', 'a.json'), JSON.stringify({ version: 3 }));
  fs.writeFileSync(path.join(d, 'account', 'now.json'), JSON.stringify({ version: 5 }));
  assert.deepEqual(board.readVersions(d), { 'sessions/a': 3, 'account/now': 5 });
  const f = path.join(d, 'map.json'); fs.writeFileSync(f, JSON.stringify({ 'summary/now': 2 }));
  assert.deepEqual(board.readVersions(f), { 'summary/now': 2 });
});

test('commands/board.md: first body line says Haiku; config has boardDailyTokens', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'commands', 'board.md'), 'utf8').split(/\r?\n/);
  const body = md.slice(md.indexOf('---', 1) + 1).filter((l) => l.trim());
  assert.ok(body.some((l) => l.startsWith('Haiku 세션에서 돌리세요')));
  const cfgDef = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.default.json'), 'utf8'));
  assert.equal(cfgDef.boardDailyTokens, 150000);
});

test('W7 #6: a status line render (scanCached, items emptied) right before does not hide agents from the board row', () => {
  const fleet = require('../scripts/fleet');
  const T = tmp('ts-w7-6-');
  const dir = path.join(T, 'p', 's1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const FF = path.join(__dirname, 'fixtures', 'fleet');
  for (const f of fs.readdirSync(FF).filter((x) => x.endsWith('.json'))) { fs.copyFileSync(path.join(FF, f), path.join(dir, f)); fs.utimesSync(path.join(dir, f), new Date(), new Date()); }
  const tp = path.join(T, 'p', 's1.jsonl');
  fs.writeFileSync(tp, '');
  const now = Math.floor(Date.now() / 1000);
  const direct = fleet.scan(dir, now, {});
  const upper = direct.items.filter((i) => i.state === 'running' && /opus/i.test(i.model || '')).length;
  assert.ok(upper >= 1, 'fixture has a running upper-model agent');
  fleet.scanCached(fleet.sessionDir(tp), now, {}); // status line render memo (items: [])
  const r = board.buildRow({ session_id: 's1', transcript_path: tp, cwd: 'C:/work/x' }, null, now, {});
  assert.strictEqual(r.agents_running, direct.running);
  assert.strictEqual(r.agents_upper, upper);
});
