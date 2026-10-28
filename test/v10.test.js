'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// Fleet observation: scripts/fleet.js + the status line token.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stamina-v10-'));
process.env.TOKEN_STAMINA_HOME = path.join(TMP, 'home');
const fleet = require('../scripts/fleet');
const statusline = require('../scripts/statusline');

const FIX = path.join(__dirname, 'fixtures', 'fleet');
const NOW = Math.floor(Date.now() / 1000);

// Copy the fixtures into <TMP>/<name>/s1/subagents with chosen mtimes; returns the transcript path.
function session(name, ages) {
  const root = path.join(TMP, name);
  const dir = path.join(root, 's1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(FIX).filter((x) => x.endsWith('.json'))) {
    fs.copyFileSync(path.join(FIX, f), path.join(dir, f));
    const age = (ages && ages[f]) != null ? ages[f] : 10;
    const t = new Date((NOW - age) * 1000);
    fs.utimesSync(path.join(dir, f), t, t);
  }
  return { transcript: path.join(root, 's1.jsonl'), dir };
}

test('scan: running / finished / stale counted, broken meta ignored', () => {
  const s = session('basic', { 'agent-cstale03.meta.json': 5000 });
  const snap = fleet.scan(s.dir, NOW, {});
  assert.strictEqual(snap.running, 1);
  assert.strictEqual(snap.finished, 1);
  assert.strictEqual(snap.stale, 1);
  assert.strictEqual(snap.total, 3);
  assert.deepStrictEqual(snap.models, { S: 1 });
});

test('scan: missing folder -> empty snapshot', () => {
  const snap = fleet.scan(path.join(TMP, 'nope', 'subagents'), NOW, {});
  assert.strictEqual(snap.total, 0);
  assert.strictEqual(snap.truncated, false);
});

test('scan: more than 64 records -> newest 64, truncated', () => {
  const dir = path.join(TMP, 'big', 's1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(dir, `agent-n${i}.meta.json`), '{"model":"haiku","description":"x"}');
  const snap = fleet.scan(dir, NOW, {});
  assert.strictEqual(snap.truncated, true);
  assert.strictEqual(snap.total, 64);
});

test('sessionDir: derived from transcript path', () => {
  assert.strictEqual(fleet.sessionDir('/p/s.jsonl'), '/p/s/subagents');
  assert.strictEqual(fleet.sessionDir(undefined), null);
});

test('segment: shows from 2 running, hidden below, off switches', () => {
  const two = { running: 3, models: { S: 2, O: 1 } };
  assert.strictEqual(fleet.segment(two, {}), '🤖3 (2S·1O)');
  assert.strictEqual(fleet.segment({ running: 1, models: { S: 1 } }, {}), '');
  assert.strictEqual(fleet.segment(two, { fleet: false }), '');
  assert.strictEqual(fleet.segment(two, { fleetShowAt: 0 }), '');
});

test('table: ko output and empty', () => {
  const s = session('tbl', { 'agent-cstale03.meta.json': 5000 });
  const out = fleet.table(fleet.scan(s.dir, NOW, {}), 'ko');
  assert.match(out, /실행 중 1/);
  assert.match(out, /Collect sample logs/);
  assert.match(fleet.table(fleet.scan(path.join(TMP, 'none'), NOW, {}), 'en'), /No subagent records/);
});

test('scanAll: sweeps projects/<slug>/<session>/subagents', () => {
  const root = path.join(TMP, 'projects');
  const dir = path.join(root, 'slug1', 'sess1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-z.meta.json'), '{"model":"opus"}');
  const snap = fleet.scanAll(NOW, {}, root);
  assert.strictEqual(snap.running, 1);
  assert.deepStrictEqual(snap.models, { O: 1 });
});

test('statusline: fleet token appears with 2+ running, writes only the cache under home', () => {
  const s = session('sl', { 'agent-cstale03.meta.json': 5000 });
  // make two running: add a second running meta
  fs.writeFileSync(path.join(s.dir, 'agent-erun05.meta.json'), '{"model":"opus","description":"Another task"}');
  const raw = JSON.stringify({ transcript_path: s.transcript, context_window: { used_percentage: 10 } });
  const out = statusline.run(raw);
  assert.match(out, /🤖2 \(1O·1S\)/);
  assert.ok(fs.existsSync(path.join(process.env.TOKEN_STAMINA_HOME, 'fleet-cache.json')));
});

test('statusline: fleet:false (user config) removes the token', () => {
  const s = session('sl2');
  fs.writeFileSync(path.join(s.dir, 'agent-erun05.meta.json'), '{"model":"opus"}');
  const cfg = { lang: 'en', fleet: false };
  const input = { transcript_path: s.transcript, context_window: { used_percentage: 10 } };
  assert.strictEqual(statusline.segment(input, null, NOW, cfg), 'ctx 10%');
  assert.strictEqual(statusline.segment(input, null, NOW, { lang: 'en', fleetShowAt: 0 }), 'ctx 10%');
});

test('statusline: no transcript_path -> same output as before', () => {
  const input = { context_window: { used_percentage: 41.3 } };
  assert.strictEqual(statusline.segment(input, null, NOW, { lang: 'en' }), 'ctx 41%');
});

test('W3 sessionDir: subagent transcript normalizes to the parent subagents folder', () => {
  assert.strictEqual(fleet.sessionDir('/p/S/subagents/agent-abc.jsonl'), '/p/S/subagents');
  assert.strictEqual(fleet.sessionDir(String.raw`C:\p\S\subagents\agent-abc.jsonl`), 'C:/p/S/subagents');
  assert.strictEqual(fleet.sessionDir('/p/S.jsonl'), '/p/S/subagents');
});

test('W3 scanDir keeps requestShape and nonInteractive', () => {
  const s = session('w3shape', { 'agent-cstale03.meta.json': 5000 });
  const snap = fleet.scan(s.dir, NOW, {});
  const run = snap.items.find((i) => i.state === 'running');
  assert.strictEqual(run.requestShape, 'background');
  assert.strictEqual(run.nonInteractive, true);
});

test('W3 pressure: only running/models/truncated, no items', () => {
  const s = session('w3press', { 'agent-cstale03.meta.json': 5000 });
  const p = fleet.pressure(fleet.scan(s.dir, NOW, {}));
  assert.deepStrictEqual(Object.keys(p).sort(), ['models', 'running', 'truncated']);
  assert.deepStrictEqual(p, { running: 1, models: { S: 1 }, truncated: false });
  assert.deepStrictEqual(fleet.pressure(null), { running: 0, models: {}, truncated: false });
});

test('W3 table: budgetLine is the first line; null is byte-identical to before', () => {
  const s = session('w3tbl', { 'agent-cstale03.meta.json': 5000 });
  const snap = fleet.scan(s.dir, NOW, {});
  const base = fleet.table(snap, 'en');
  assert.strictEqual(fleet.table(snap, 'en', null), base);
  assert.strictEqual(fleet.table(snap, 'en', 'BUDGET').split('\n')[0], 'BUDGET');
  assert.strictEqual(fleet.table(snap, 'en', 'BUDGET'), 'BUDGET\n\n' + base);
});

test('W3 scanCached is used only by the status line (not by hooks/agent-model)', () => {
  const root = path.join(__dirname, '..');
  const users = [];
  for (const d of ['scripts', 'hooks']) {
    for (const f of fs.readdirSync(path.join(root, d))) {
      const p = path.join(root, d, f);
      if (fs.statSync(p).isFile() && /\.(js|ts)$/.test(f) && fs.readFileSync(p, 'utf8').includes('scanCached')) users.push(f);
    }
  }
  assert.deepStrictEqual(users.filter((f) => !['fleet.js', 'statusline.js', 'fleet.ts', 'board.js'].includes(f)), []);
});

test('W3 scan: 65 records -> truncated, running counted within the newest 64', () => {
  const dir = path.join(TMP, 'w3big', 's1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 65; i++) {
    const f = path.join(dir, `agent-n${i}.meta.json`);
    fs.writeFileSync(f, '{"model":"haiku"}');
    const t = new Date((NOW - 10 - i) * 1000);
    fs.utimesSync(f, t, t);
  }
  const snap = fleet.scan(dir, NOW, {});
  assert.strictEqual(snap.truncated, true);
  assert.strictEqual(snap.running, 64);
});

test('W3 stale: default 600s; sibling agent-<id>.jsonl mtime keeps a running agent alive', () => {
  const dir = path.join(TMP, 'w3live', 's1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date((NOW - 5000) * 1000);
  fs.writeFileSync(path.join(dir, 'agent-live.meta.json'), '{"model":"sonnet"}');
  fs.utimesSync(path.join(dir, 'agent-live.meta.json'), old, old);
  fs.writeFileSync(path.join(dir, 'agent-dead.meta.json'), '{"model":"sonnet"}');
  fs.utimesSync(path.join(dir, 'agent-dead.meta.json'), old, old);
  fs.writeFileSync(path.join(dir, 'agent-live.jsonl'), '{}\n'); // fresh mtime
  const snap = fleet.scan(dir, NOW, fleet.DEFAULTS);
  assert.strictEqual(snap.running, 1);
  assert.strictEqual(snap.stale, 1);
  assert.strictEqual(fleet.DEFAULTS.fleetStaleSec, 600);
});

test('W3 scan: subagents/workflows/<wf>/ metas are included, within the 64 cap', () => {
  const dir = path.join(TMP, 'w3wf', 's1', 'subagents');
  const wf = path.join(dir, 'workflows', 'wf_abc');
  fs.mkdirSync(wf, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-top.meta.json'), '{"model":"opus"}');
  fs.writeFileSync(path.join(wf, 'agent-w1.meta.json'), '{"model":"haiku"}');
  fs.writeFileSync(path.join(wf, 'agent-w2.meta.json'), '{"model":"haiku"}');
  const snap = fleet.scan(dir, NOW, {});
  assert.strictEqual(snap.total, 3);
  assert.deepStrictEqual(snap.models, { H: 2, O: 1 });
  for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(wf, `agent-x${i}.meta.json`), '{}');
  const big = fleet.scan(dir, NOW, {});
  assert.strictEqual(big.total, 64);
  assert.strictEqual(big.truncated, true);
});

// ---- W4b-2: session scan ----
const SFIX = path.join(FIX, 'sessions');
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}
function touch(p, ageSec) { const t = new Date((NOW - ageSec) * 1000); fs.utimesSync(p, t, t); }
// Fresh copy of the session fixtures under TMP/<name>; every jsonl 30 s old except old.jsonl (2 h).
function projects(name) {
  const root = path.join(TMP, name);
  copyTree(SFIX, root);
  for (const slug of fs.readdirSync(root)) {
    for (const n of fs.readdirSync(path.join(root, slug))) {
      if (n.endsWith('.jsonl')) touch(path.join(root, slug, n), n === 'old.jsonl' ? 7200 : 30);
    }
  }
  return root;
}
const SCFG = { excludeCwd: ['mybot_work'] };

test('W4b-2 normalizeSlug / excludedBySlug', () => {
  assert.strictEqual(fleet.normalizeSlug('mybot_work'), 'mybot-work');
  assert.strictEqual(fleet.excludedBySlug('C--Users-x-Temp-mybot-work', undefined, ['mybot_work']), true);
  assert.strictEqual(fleet.excludedBySlug('C--Work', 'C:\\Users\\x\\Temp\\mybot_work', ['mybot_work']), true);
  assert.strictEqual(fleet.excludedBySlug('C-newsbot-translate-work', undefined, ['newsbot']), true);
  assert.strictEqual(fleet.excludedBySlug('C--Claude', undefined, ['mybot_work']), false);
  assert.strictEqual(fleet.excludedBySlug('C--Claude', undefined, undefined), false);
});

test('W4b-2 readHead + parseHead: bot entrypoint sits behind a 14 KB record', () => {
  const root = projects('w42head');
  const bot = path.join(root, 'C--Users-x-Temp-mybot-work', 'bot.jsonl');
  assert.ok(fs.statSync(bot).size > 13000);
  const h = fleet.readHead(bot, fleet.HEAD_BYTES);
  assert.deepStrictEqual(fleet.parseHead(h.text, h.cut), { entrypoint: 'sdk-cli', cwd: 'C:/Users/x/Temp/mybot_work' });
  const bad = fleet.readHead(path.join(root, 'C--Trading', 'notjson.jsonl'), fleet.HEAD_BYTES);
  assert.deepStrictEqual(fleet.parseHead(bad.text, bad.cut), { entrypoint: null, cwd: null });
  assert.strictEqual(fleet.readHead(path.join(root, 'nope.jsonl'), 100), null);
});

test('W4b-2 classifySession: self / interactive / headless / excluded / old / unknown', () => {
  const root = projects('w42cls');
  const info = (slug, id, entrypoint, cwd) => ({ slug, path: path.join(root, slug, id + '.jsonl'), entrypoint, cwd });
  const self = path.join(root, 'C--Claude', 'self.jsonl');
  assert.strictEqual(fleet.classifySession(info('C--Claude', 'self', 'claude-desktop'), NOW - 30, NOW, self, SCFG), 'self');
  assert.strictEqual(fleet.classifySession(info('C--Claude', 'other', 'claude-desktop'), NOW - 30, NOW, self, SCFG), 'interactive');
  assert.strictEqual(fleet.classifySession(info('C--Work', 'cli', 'cli'), NOW - 30, NOW, self, SCFG), 'interactive');
  assert.strictEqual(fleet.classifySession(info('C--Foo', 'x', 'sdk-cli'), NOW - 30, NOW, self, SCFG), 'headless');
  // excluded wins over headless: counted once, as excluded
  assert.strictEqual(fleet.classifySession(info('C--Users-x-Temp-mybot-work', 'bot', 'sdk-cli'), NOW - 30, NOW, self, SCFG), 'excluded');
  assert.strictEqual(fleet.classifySession(info('C--Trading', 'old', 'cli'), NOW - 7200, NOW, self, SCFG), 'old');
  assert.strictEqual(fleet.classifySession(info('C--Trading', 'notjson', null), NOW - 30, NOW, self, SCFG), 'unknown');
});

test('W4b-2 scanSessions: counts, subagents/ ignored, truncated, count flags', () => {
  const root = projects('w42scan');
  const self = path.join(root, 'C--Claude', 'self.jsonl');
  const s = fleet.scanSessions(root, self, NOW, SCFG);
  assert.deepStrictEqual([s.sessions, s.headless, s.excluded, s.unknown, s.truncated], [2, 0, 1, 1, false]);
  assert.ok(!s.items.some((i) => i.id === 'agent-1' || i.id === 'self' || i.id === 'old'));
  const t = fleet.scanSessions(root, self, NOW, Object.assign({ fleetSessionsMax: 1 }, SCFG));
  assert.strictEqual(t.truncated, true);
  // without excludeCwd the bot is read and lands as headless
  const h = fleet.scanSessions(root, self, NOW, {});
  assert.deepStrictEqual([h.sessions, h.headless, h.excluded], [2, 1, 0]);
  assert.strictEqual(fleet.scanSessions(root, self, NOW, Object.assign({ fleetSessionsCountExcluded: true }, SCFG)).sessions, 3);
  assert.strictEqual(fleet.scanSessions(root, self, NOW, { fleetSessionsCountHeadless: true }).sessions, 3);
  // the subagent transcript of a session maps to that session's own jsonl
  const viaSub = fleet.scanSessions(root, path.join(root, 'C--Claude', 'self', 'subagents', 'agent-1.jsonl'), NOW, SCFG);
  assert.strictEqual(viaSub.sessions, 2);
  assert.strictEqual(fleet.scanSessions(path.join(TMP, 'does-not-exist'), null, NOW, SCFG), null);
});

test('W4b-2 scanSessions reads heads only for non-excluded active candidates', () => {
  const root = projects('w42io');
  const self = path.join(root, 'C--Claude', 'self.jsonl');
  const before = fleet.io.head;
  fleet.scanSessions(root, self, NOW, SCFG);
  // candidates: other, cli, notjson (self, old, bot are not read) -> 3 head reads
  assert.strictEqual(fleet.io.head - before, 3);
});

test('W4b-2 scanSessionsCached: second call within 30 s does no readdir; 31 s later rescans; agent memo kept', () => {
  const root = projects('w42cache');
  const self = path.join(root, 'C--Claude', 'self.jsonl');
  fs.rmSync(path.join(process.env.TOKEN_STAMINA_HOME, 'fleet-cache.json'), { force: true });
  const r0 = fleet.io.readdir;
  const a = fleet.scanSessionsCached(root, self, NOW, SCFG);
  const r1 = fleet.io.readdir;
  assert.ok(r1 > r0);
  const b = fleet.scanSessionsCached(root, self, NOW + 10, SCFG);
  assert.strictEqual(fleet.io.readdir, r1);
  assert.deepStrictEqual([b.sessions, b.excluded], [a.sessions, a.excluded]);
  fleet.scanSessionsCached(root, self, NOW + 31, SCFG);
  assert.ok(fleet.io.readdir > r1);
  // the status line memo and the sessions memo share the file without erasing each other
  const sub = session('w42memo', {});
  fleet.scanCached(sub.dir, NOW, {});
  fleet.scanSessionsCached(root, self, NOW + 100, SCFG);
  fleet.scanCached(sub.dir, NOW + 100, { fleetCacheSec: 5 });
  const book = JSON.parse(fs.readFileSync(path.join(process.env.TOKEN_STAMINA_HOME, 'fleet-cache.json'), 'utf8'));
  assert.ok(book.sessions && book[sub.dir]);
});

test('W4b-2 fleetPressure / pressure(snap, sessionsSnap)', () => {
  assert.strictEqual(fleet.fleetPressure({ running: 3 }, {}), true);
  assert.strictEqual(fleet.fleetPressure({ running: 1, sessions: 3 }, {}), true);
  assert.strictEqual(fleet.fleetPressure({ running: 1, sessions: 2 }, {}), false);
  assert.strictEqual(fleet.fleetPressure({ running: 1, sessions: null }, {}), false);
  assert.strictEqual(fleet.fleetPressure({ running: 5 }, {}, 'hard'), true);
  assert.strictEqual(fleet.fleetPressure({ running: 3, sessions: 4 }, {}, 'hard'), true);
  const s = session('w42p', {});
  const snap = fleet.scan(s.dir, NOW, {});
  // regression: no sessions argument -> the old exact shape (no sessions key at all)
  assert.deepStrictEqual(fleet.pressure(snap), { running: 2, models: { S: 1, O: 1 }, truncated: false });
  assert.deepStrictEqual(Object.keys(fleet.pressure(snap)), ['running', 'models', 'truncated']);
  assert.strictEqual(fleet.pressure(snap, { sessions: 2 }).sessions, 2);
  assert.strictEqual(fleet.pressure(snap, null).sessions, null);
  assert.strictEqual(fleet.fleetPressure(fleet.pressure(snap), {}), fleet.fleetPressure(Object.assign(fleet.pressure(snap), { sessions: undefined }), {}));
});

test('W4b-2 table sessions line (ko/en/ja), absent when ss is null, after the budget line', () => {
  const s = session('w42t', {});
  const snap = fleet.scan(s.dir, NOW, {});
  const ss = { sessions: 2, headless: 0, excluded: 6, unknown: 1, truncated: false, items: [] };
  assert.strictEqual(fleet.table(snap, 'en', null, null), fleet.table(snap, 'en'));
  assert.match(fleet.table(snap, 'ko', null, ss), /^세션 2개\(대화형\) · 제외 6 · 헤드리스 0 · 미확인 1 · 이 세션 에이전트 2개 \(1O·1S\)\n/);
  assert.match(fleet.table(snap, 'en', 'BUDGET', ss), /^BUDGET\n\nsessions 2 \(interactive\) · excluded 6 · headless 0 · unknown 1 · agents here 2 \(1O·1S\)\n/);
  assert.match(fleet.table(snap, 'ja', null, ss, true), /^セッション 2件.*全体のエージェント 2件/);
});

test('W4b-2 main --all prints the sessions line; fleetSessions:false drops it; no writes under projects', () => {
  const { spawnSync } = require('child_process');
  const home = path.join(TMP, 'home-main');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ lang: 'en' }));
  fs.mkdirSync(path.join(TMP, 'fakehome', '.claude', 'projects', 'C--Z'), { recursive: true });
  const run = (args, h) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'fleet.js'), '--lang', 'en'].concat(args), { env: Object.assign({}, process.env, { TOKEN_STAMINA_HOME: h, HOME: path.join(TMP, 'fakehome'), USERPROFILE: path.join(TMP, 'fakehome') }), encoding: 'utf8' });
  const o = run(['--all'], home);
  assert.match(o.stdout, /sessions \d+ \(interactive\) · excluded \d+ · headless \d+ · agents total \d+/);
  const home2 = path.join(TMP, 'home-main2');
  fs.mkdirSync(home2, { recursive: true });
  fs.writeFileSync(path.join(home2, 'config.json'), JSON.stringify({ lang: 'en', fleetSessions: false }));
  assert.ok(!/sessions \d/.test(run(['--all'], home2).stdout));
});

test('W4b-2 perf: 3,000 session files scan under 1 s, head reads limited to active candidates', () => {
  const root = path.join(TMP, 'w42big');
  for (let i = 0; i < 30; i++) {
    const d = path.join(root, 'C--P' + i);
    fs.mkdirSync(d, { recursive: true });
    for (let j = 0; j < 100; j++) {
      const f = path.join(d, `s${j}.jsonl`);
      fs.writeFileSync(f, '{"entrypoint":"cli","cwd":"C:/p"}\n');
      touch(f, j < 3 ? 60 : 99999); // only 3 per folder are active
    }
  }
  const before = fleet.io.head;
  const t0 = Date.now();
  const s = fleet.scanSessions(root, null, NOW, { fleetSessionsMax: 20 });
  assert.ok(Date.now() - t0 < 1000);
  assert.strictEqual(s.truncated, true);
  assert.strictEqual(fleet.io.head - before, 20);
  assert.strictEqual(s.sessions, 20);
});

test('W4b-2 scanSessions never writes under the projects folder', () => {
  const root = projects('w42ro');
  const snapshot = () => JSON.stringify(fs.readdirSync(root, { recursive: true }).sort().map((p) => [p, fs.statSync(path.join(root, p)).mtimeMs]));
  const before = snapshot();
  fleet.scanSessions(root, null, NOW, SCFG);
  assert.strictEqual(snapshot(), before);
});

// ---- W7 #11: the sessions memo is per (projectsDir, self) key ----
test('W7 #11 scanSessionsCached: two sessions asking in turn each keep their own memo (no overwrite)', () => {
  const root = projects('w7memo');
  const selfA = path.join(root, 'C--Claude', 'self.jsonl');
  const selfB = path.join(root, 'C--Claude', 'other.jsonl');
  fs.rmSync(path.join(process.env.TOKEN_STAMINA_HOME, 'fleet-cache.json'), { force: true });
  const a = fleet.scanSessionsCached(root, selfA, NOW, SCFG);
  const r1 = fleet.io.readdir;
  const b = fleet.scanSessionsCached(root, selfB, NOW + 1, SCFG);
  assert.ok(fleet.io.readdir > r1, 'B is not answered from A memo');
  const r2 = fleet.io.readdir;
  const a2 = fleet.scanSessionsCached(root, selfA, NOW + 2, SCFG);
  const b2 = fleet.scanSessionsCached(root, selfB, NOW + 3, SCFG);
  assert.strictEqual(fleet.io.readdir, r2, 'both memos survive each other');
  assert.deepStrictEqual([a2.sessions, b2.sessions], [a.sessions, b.sessions]);
  const book = JSON.parse(fs.readFileSync(path.join(process.env.TOKEN_STAMINA_HOME, 'fleet-cache.json'), 'utf8'));
  assert.strictEqual(Object.keys(book.sessions).length, 2);
  // capped at SESSIONS_MEMO_MAX keys
  for (let i = 0; i < fleet.SESSIONS_MEMO_MAX + 3; i++) fleet.scanSessionsCached(root, path.join(root, 'x' + i + '.jsonl'), NOW + 10 + i, SCFG);
  const book2 = JSON.parse(fs.readFileSync(path.join(process.env.TOKEN_STAMINA_HOME, 'fleet-cache.json'), 'utf8'));
  assert.strictEqual(Object.keys(book2.sessions).length, fleet.SESSIONS_MEMO_MAX);
  // an old single-slot memo {ts,key,snap} is not trusted as a hit
  fs.writeFileSync(path.join(process.env.TOKEN_STAMINA_HOME, 'fleet-cache.json'), JSON.stringify({ sessions: { ts: NOW + 50, key: root + '|' + selfA, snap: { sessions: 99 } } }));
  assert.notStrictEqual(fleet.scanSessionsCached(root, selfA, NOW + 51, SCFG).sessions, 99);
});

// ---- W7 #12: FLEET_BUDGET_MS is a real cap ----
test('W7 #12 deadline: a passed deadline stops the scans before any read; fleetInput then gives no fleet input', () => {
  const s = session('w7budget', {});
  const root = projects('w7budget-p');
  const self = path.join(root, 'C--Claude', 'self.jsonl');
  const h0 = fleet.io.head, d0 = fleet.io.readdir;
  const snap = fleet.scan(s.dir, NOW, {}, Date.now() - 1);
  assert.strictEqual(snap.over_budget, true);
  assert.strictEqual(snap.items.length, 0);
  assert.strictEqual(fleet.scanSessions(root, self, NOW, SCFG, Date.now() - 1), null);
  assert.deepStrictEqual([fleet.io.head - h0, fleet.io.readdir - d0], [0, 0], 'no head reads, no readdir past the deadline');
  assert.strictEqual(fleet.scan(s.dir, NOW, {}, Date.now() + 60000).over_budget, undefined);
  const am = require('../scripts/agent-model');
  const nowReal = Math.floor(Date.now() / 1000);
  assert.strictEqual(am.fleetInput({ transcript_path: s.transcript }, { fleetSessions: false }, nowReal, -1), null);
  const ok = am.fleetInput({ transcript_path: s.transcript }, { fleetSessions: false }, nowReal);
  assert.ok(ok && typeof ok.running === 'number');
  assert.strictEqual(am.FLEET_BUDGET_MS, 2000);
});
