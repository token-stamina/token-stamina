'use strict';
// 0.4.6: status line launcher that follows updates, one-time switch from a version-folder status line, update notice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SL = require('../scripts/setup-statusline');
const fr = require('../scripts/first-run');
const FR = path.join(__dirname, '..', 'scripts', 'first-run.js');
const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stamina-v10-'));
const start = { hook_event_name: 'SessionStart', source: 'startup', session_id: 's1', cwd: '/w' };

function withHome(fn) {
  const h = tmp();
  const old = process.env.TOKEN_STAMINA_HOME;
  process.env.TOKEN_STAMINA_HOME = h;
  try { return fn(h); } finally { if (old === undefined) delete process.env.TOKEN_STAMINA_HOME; else process.env.TOKEN_STAMINA_HOME = old; }
}
function settingsFile(dir, obj) {
  const f = path.join(dir, 'settings.json');
  if (obj !== undefined) fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  return f;
}
// A fake plugin root whose status line prints a label.
function fakeRoot(label, version) {
  const r = tmp();
  fs.mkdirSync(path.join(r, 'scripts'));
  fs.writeFileSync(path.join(r, 'scripts', 'statusline.js'), `module.exports = { run: (raw) => ${JSON.stringify(label)} + ':' + JSON.parse(raw).x };`);
  if (version) {
    fs.mkdirSync(path.join(r, '.claude-plugin'));
    fs.writeFileSync(path.join(r, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  }
  return r;
}
function userHome(installed) {
  const u = tmp();
  fs.mkdirSync(path.join(u, '.claude', 'plugins'), { recursive: true });
  if (installed) fs.writeFileSync(path.join(u, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed }));
  return u;
}
function runNode(file, u, input, extraEnv, args) {
  const env = Object.assign({}, process.env, { USERPROFILE: u, HOME: u });
  delete env.TOKEN_STAMINA_HOME; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.CLAUDE_PLUGIN_ROOT;
  Object.assign(env, extraEnv || {});
  return execFileSync(process.execPath, [file].concat(args || []), { env, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
}

test('setup: no status line -> launcher written, settings point at it, backup kept', () => withHome((h) => {
  const d = tmp();
  const f = settingsFile(d, { model: 'opus' });
  const r = SL.apply({ settings: f }, ROOT, new Date('2026-10-24T00:00:00Z'));
  assert.ok(r.ok && r.changed && !r.wrap);
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(s.model, 'opus');
  assert.strictEqual(s.statusLine.command, `node "${path.join(h, SL.LAUNCHER).replace(/\\/g, '/')}"`);
  assert.ok(fs.existsSync(path.join(h, SL.LAUNCHER)));
  assert.ok(fs.existsSync(r.backup));
  assert.ok(fr.registered(s) && !fr.stale(s));
}));

test('setup: someone else\'s status line is wrapped; an old Token Stamina one is replaced, not wrapped', () => withHome((h) => {
  const d = tmp();
  const f = settingsFile(d, { statusLine: { type: 'command', command: 'npx ccstatusline' } });
  assert.strictEqual(SL.apply({ settings: f }, ROOT).wrap, 'npx ccstatusline');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h, 'config.json'), 'utf8')).wrap, 'npx ccstatusline');
  const g = settingsFile(tmp(), { statusLine: { type: 'command', command: 'node "C:/u/.claude/plugins/cache/token-stamina/token-stamina/0.4.5/scripts/statusline.js"' } });
  const r = SL.apply({ settings: g }, ROOT);
  assert.strictEqual(r.wrap, null);
  assert.match(JSON.parse(fs.readFileSync(g, 'utf8')).statusLine.command, /token-stamina-statusline\.js/);
  // running setup again over the launcher changes nothing and wraps nothing (no self-wrap loop)
  const again = SL.apply({ settings: g }, ROOT);
  assert.ok(!again.changed && !again.wrap && !again.backup);
}));

test('setup: dry run writes nothing', () => withHome((h) => {
  const f = settingsFile(tmp(), { statusLine: { command: 'npx x' } });
  const before = fs.readFileSync(f, 'utf8');
  const r = SL.apply({ settings: f, dryRun: true }, ROOT);
  assert.ok(r.ok && r.dryRun);
  assert.match(r.message, /dry run/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(h, SL.LAUNCHER)));
  assert.ok(!fs.existsSync(path.join(h, 'config.json')));
}));

test('setup: invalid settings JSON is left alone', () => withHome(() => {
  const f = path.join(tmp(), 'settings.json');
  fs.writeFileSync(f, '{ broken');
  assert.ok(!SL.apply({ settings: f }, ROOT).ok);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{ broken');
}));

test('launcher runs the installed version, not the one that wrote it', () => {
  const oldRoot = fakeRoot('old');
  const newRoot = fakeRoot('new');
  const u = userHome({ 'token-stamina@token-stamina': [{ scope: 'user', installPath: newRoot, version: '0.4.7' }] });
  const l = path.join(tmp(), SL.LAUNCHER);
  fs.writeFileSync(l, SL.launcherSource(oldRoot));
  assert.strictEqual(runNode(l, u, { x: 1 }), 'new:1');
  // no plugin list, or an installPath that is gone: falls back to the root that wrote it
  assert.strictEqual(runNode(l, userHome(), { x: 2 }), 'old:2');
  const gone = userHome({ 'token-stamina@token-stamina': [{ installPath: path.join(tmp(), 'deleted') }] });
  assert.strictEqual(runNode(l, gone, { x: 3 }), 'old:3');
  // nothing runnable at all: empty output, exit 0
  const l2 = path.join(tmp(), SL.LAUNCHER);
  fs.writeFileSync(l2, SL.launcherSource(path.join(tmp(), 'nothing')));
  assert.strictEqual(runNode(l2, userHome(), { x: 4 }), '');
});

test('launcher end to end with the real status line script', () => {
  const u = userHome({ 'token-stamina@token-stamina': [{ installPath: ROOT }] });
  const l = path.join(tmp(), SL.LAUNCHER);
  fs.writeFileSync(l, SL.launcherSource(ROOT));
  const input = { session_id: 't', cwd: '/w', model: { id: 'claude-opus-5-5' }, rate_limits: { seven_day: { used_percentage: 40, resets_at: Math.floor(Date.now() / 1000) + 3 * 86400 } } };
  const direct = runNode(path.join(ROOT, 'scripts', 'statusline.js'), u, input, { TOKEN_STAMINA_HOME: tmp() });
  assert.strictEqual(runNode(l, u, input, { TOKEN_STAMINA_HOME: tmp() }), direct);
  assert.ok(direct.length > 0);
});

test('stale: version folder or plugin root variable; not the launcher, not a dev checkout', () => {
  const c = (command) => ({ statusLine: { command } });
  assert.ok(fr.stale(c('node "C:/Users/x/.claude/plugins/cache/token-stamina/token-stamina/0.4.5/scripts/statusline.js"')));
  assert.ok(fr.stale(c('node "/home/x/.claude/plugins/cache/token-stamina/token-stamina/0.4.5/scripts/statusline.js"')));
  assert.ok(fr.stale(c('node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js"')));
  assert.ok(!fr.stale(c('node "C:/Users/x/.claude/token-stamina/token-stamina-statusline.js"')));
  assert.ok(!fr.stale(c('node "C:/src/token-stamina/scripts/statusline.js"')));
  assert.ok(!fr.stale(c('npx ccstatusline')));
});

test('newer: numeric compare', () => {
  assert.ok(fr.newer('0.4.10', '0.4.9'));
  assert.ok(fr.newer('1.0.0', '0.9.9'));
  assert.ok(!fr.newer('0.4.6', '0.4.6'));
  assert.ok(!fr.newer('0.4.5', '0.4.6'));
  assert.ok(!fr.newer('garbage', '0.4.6'));
  assert.ok(fr.newer('0.4.6', null));
});

test('decide: migrate once, update once per version, both switchable off', () => {
  const cfg = { lang: 'en' };
  const old = { statusLine: { command: 'node "/h/.claude/plugins/cache/token-stamina/token-stamina/0.4.5/scripts/statusline.js"' } };
  const launcher = { statusLine: { command: 'node "/h/.claude/token-stamina/token-stamina-statusline.js"' } };
  assert.strictEqual(fr.decide(start, old, cfg, {}).kind, 'migrate');
  assert.strictEqual(fr.decide(start, old, cfg, { migrateAsked: 'x' }), null);
  assert.strictEqual(fr.decide(start, old, { lang: 'en', setupPrompt: false }, {}), null);
  assert.strictEqual(fr.decide(start, launcher, cfg, {}), null);
  const v = { installed: '0.4.6', latest: '0.4.7' };
  const d = fr.decide(start, launcher, cfg, {}, v);
  assert.ok(d.update === '0.4.7' && d.kind === null);
  assert.strictEqual(fr.decide(start, launcher, cfg, { notified: '0.4.7' }, v), null);
  assert.strictEqual(fr.decide(start, launcher, cfg, { notified: '0.4.7' }, { installed: '0.4.6', latest: '0.4.8' }).update, '0.4.8');
  assert.strictEqual(fr.decide(start, launcher, { lang: 'en', updateCheck: false }, {}, v), null);
  assert.strictEqual(fr.decide(start, launcher, cfg, {}, { installed: '0.4.7', latest: '0.4.7' }), null);
  assert.strictEqual(fr.decide(Object.assign({}, start, { source: 'resume' }), launcher, cfg, {}, v), null);
  // a fresh install with an update waiting: both lines
  const both = fr.decide(start, {}, cfg, {}, v);
  assert.ok(both.kind === 'setup' && both.update === '0.4.7');
});

test('startCheck: skipped when off or checked within a day', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  assert.strictEqual(fr.startCheck({ updateCheck: false }, {}, now), false);
  assert.strictEqual(fr.startCheck({}, { fetched: '2026-10-24T01:00:00Z' }, now), false);
});

test('update-check: parses only a real version; a failed fetch keeps the last known one', () => {
  const uc = require('../scripts/update-check');
  assert.strictEqual(uc.parse('{"name":"token-stamina","version":"0.4.7"}'), '0.4.7');
  assert.strictEqual(uc.parse('{"version":"latest"}'), null);
  assert.strictEqual(uc.parse('<html>'), null);
  assert.strictEqual(uc.URL, 'https://raw.githubusercontent.com/token-stamina/token-stamina/main/.claude-plugin/plugin.json');
  const h = tmp();
  fs.writeFileSync(path.join(h, 'update-check.json'), JSON.stringify({ latest: '0.4.6' }));
  runNode(path.join(ROOT, 'scripts', 'update-check.js'), userHome(), '', { TOKEN_STAMINA_HOME: h }, ['https://127.0.0.1:1/plugin.json']);
  const j = JSON.parse(fs.readFileSync(path.join(h, 'update-check.json'), 'utf8'));
  assert.strictEqual(j.latest, '0.4.6');
  assert.ok(j.checked);
});

test('hook: update notice once, launcher refreshed, nothing spawned within the day', () => {
  const u = userHome();
  const home = path.join(u, '.claude', 'token-stamina');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'update-check.json'), JSON.stringify({ latest: '9.9.9' }));
  fs.writeFileSync(path.join(home, 'first-run.json'), JSON.stringify({ asked: 'x', fetched: new Date().toISOString() }));
  fs.writeFileSync(path.join(home, SL.LAUNCHER), '// stale launcher');
  fs.mkdirSync(path.join(u, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(u, '.claude', 'settings.json'), JSON.stringify({ statusLine: { command: `node "${path.join(home, SL.LAUNCHER)}"` } }));
  const out = JSON.parse(runNode(FR, u, start, { CLAUDE_PLUGIN_ROOT: ROOT }));
  assert.match(out.systemMessage, /9\.9\.9/);
  assert.match(out.systemMessage, /claude plugin update token-stamina@token-stamina/);
  assert.ok(!out.hookSpecificOutput);
  assert.strictEqual(fs.readFileSync(path.join(home, SL.LAUNCHER), 'utf8'), SL.launcherSource(ROOT));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'first-run.json'), 'utf8')).notified, '9.9.9');
  assert.strictEqual(runNode(FR, u, start, { CLAUDE_PLUGIN_ROOT: ROOT }), '');
});

test('hook: an old version-folder status line gets the one switch question, in Korean when set', () => {
  const u = userHome();
  const home = path.join(u, '.claude', 'token-stamina');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), '{"lang":"ko","updateCheck":false}');
  fs.writeFileSync(path.join(home, 'first-run.json'), JSON.stringify({ asked: 'x' }));
  fs.writeFileSync(path.join(u, '.claude', 'settings.json'), JSON.stringify({ statusLine: { command: 'node "C:/u/.claude/plugins/cache/token-stamina/token-stamina/0.4.5/scripts/statusline.js"' } }));
  const out = JSON.parse(runNode(FR, u, start, { CLAUDE_PLUGIN_ROOT: ROOT }));
  assert.match(out.systemMessage, /업데이트를 따라가지/);
  assert.ok(out.hookSpecificOutput.additionalContext.includes(path.join(ROOT, 'scripts', 'setup-statusline.js')));
  assert.ok(!fs.existsSync(path.join(home, SL.LAUNCHER)));   // asking writes no launcher; setup does
  assert.strictEqual(runNode(FR, u, start, { CLAUDE_PLUGIN_ROOT: ROOT }), '');
});
