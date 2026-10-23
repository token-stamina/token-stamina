'use strict';
// Auto-compact window choice: setup-compact.js and threshold scaling. Uses temp files only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pacer-v03b-'));
process.env.TOKEN_STAMINA_HOME = TMP;

const pace = require('../scripts/pace');
const sc = require('../scripts/setup-compact');
const boundary = require('../scripts/boundary');
const gate = require('../scripts/topic-gate');

const mkSettings = (obj) => { const f = path.join(TMP, 'settings-' + Math.random().toString(36).slice(2) + '.json'); fs.writeFileSync(f, JSON.stringify(obj, null, 2)); return f; };
const cfgFile = path.join(TMP, 'config.json');

test('setup-compact: dry run writes nothing', () => {
  const f = mkSettings({ theme: 'dark' });
  const before = fs.readFileSync(f, 'utf8');
  const r = sc.apply({ window: '400000', dryRun: true, settings: f });
  assert.ok(r.ok && r.dryRun && r.message.includes('(unset) -> 400000'));
  assert.equal(fs.readFileSync(f, 'utf8'), before);
  assert.equal(fs.existsSync(cfgFile), false);
  assert.deepEqual(fs.readdirSync(TMP).filter((n) => n.includes('.bak-')), []);
});

test('setup-compact: applies with timestamped backup, keeps other keys, records config', () => {
  const f = mkSettings({ theme: 'dark', env: { A: '1' } });
  const r = sc.apply({ window: '300000', dryRun: false, settings: f }, new Date('2026-10-23T14:00:00Z'));
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '300000');
  assert.equal(s.env.A, '1');
  assert.equal(s.theme, 'dark');
  assert.ok(r.backup.includes('.bak-token-stamina-2026-10-23T14-00-00-000Z'));
  assert.deepEqual(JSON.parse(fs.readFileSync(r.backup, 'utf8')), { theme: 'dark', env: { A: '1' } });
  assert.equal(pace.readJson(cfgFile, {}).compactWindowTokens, 300000);
});

test('setup-compact: default removes the key (and empty env) and the config value; same value => no backup', () => {
  const f = mkSettings({ theme: 'dark', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' } });
  const same = sc.apply({ window: '400000', dryRun: false, settings: f });
  assert.equal(same.changed, false);
  assert.equal(same.backup, null);
  const r = sc.apply({ window: 'default', dryRun: false, settings: f });
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(s.env, undefined);
  assert.equal(s.theme, 'dark');
  assert.ok(r.backup);
  assert.equal(pace.readJson(cfgFile, {}).compactWindowTokens, undefined);
});

test('setup-compact: rejects bad values and bad files, touching nothing', () => {
  const f = mkSettings({});
  assert.equal(sc.apply({ window: 'abc', settings: f }).ok, false);
  assert.equal(sc.apply({ window: '5000', settings: f }).ok, false);
  assert.equal(sc.apply({ window: '400000', settings: path.join(TMP, 'nope.json') }).ok, false);
  const bad = path.join(TMP, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.equal(sc.apply({ window: '400000', settings: bad }).ok, false);
  assert.equal(fs.readFileSync(bad, 'utf8'), '{not json');
});

test('thresholds: defaults, scaled from window, explicit key wins', () => {
  fs.rmSync(cfgFile, { force: true });
  const base = pace.loadConfig();
  assert.deepEqual(pace.thresholds(base), { compactAt: 150000, newAt: 400000, gateAt: 200000 });
  fs.writeFileSync(cfgFile, JSON.stringify({ compactWindowTokens: 600000 }));
  assert.deepEqual(pace.thresholds(pace.loadConfig()), { compactAt: 240000, newAt: 570000, gateAt: 300000 });
  fs.writeFileSync(cfgFile, JSON.stringify({ compactWindowTokens: 400000 }));
  assert.deepEqual(pace.thresholds(pace.loadConfig()), { compactAt: 160000, newAt: 380000, gateAt: 200000 });
  fs.writeFileSync(cfgFile, JSON.stringify({ compactWindowTokens: 400000, compactAtTokens: 123000 }));
  assert.equal(pace.thresholds(pace.loadConfig()).compactAt, 123000);
});

test('boundary and gate follow the window', () => {
  const res = { tokens: 200000, turnFound: true, commitCount: 1, commits: [], edited: false, endsWithAnswer: true };
  fs.writeFileSync(cfgFile, JSON.stringify({ compactWindowTokens: 600000, boundary: true })); // compact hint at 240k
  assert.equal(boundary.decide(res, pace.loadConfig(), undefined).reason, 'below_threshold');
  fs.writeFileSync(cfgFile, JSON.stringify({ compactWindowTokens: 300000, boundary: true })); // 120k
  assert.equal(boundary.decide(res, pace.loadConfig(), undefined).notify, true);
  assert.equal(boundary.decide(Object.assign({}, res, { tokens: 290000 }), pace.loadConfig(), undefined).level, 'new_session'); // >= 285k
  const info = { tokens: 160000, lastAssistantMs: 0, nowMs: 1, cwd: 'a' };
  fs.writeFileSync(cfgFile, JSON.stringify({ compactWindowTokens: 300000 })); // gate at 150k
  assert.equal(gate.decide(info, pace.loadConfig(), { cwd: 'b' }).gate, true);
  fs.writeFileSync(cfgFile, JSON.stringify({ compactWindowTokens: 600000 })); // gate at 300k
  assert.equal(gate.decide(info, pace.loadConfig(), { cwd: 'b' }).gate, false);
  fs.rmSync(cfgFile, { force: true });
});

test('inline compact hint: threshold, once per growth, reset after compact, one-click clear wording', () => {
  const c = { compactWindowTokens: 400000 }; // compactAt 160k
  assert.equal(gate.decideHint(150000, c, null).hint, false);
  const a = gate.decideHint(170000, c, null);
  assert.equal(a.hint, true);
  assert.equal(gate.decideHint(200000, c, a.hintAt).hint, false);
  assert.equal(gate.decideHint(280000, c, a.hintAt).hint, true);
  assert.equal(gate.decideHint(90000, c, 280000).hintAt, null); // compacted
  assert.equal(gate.decideHint(170000, { inlineCompactHint: false }, null).hint, false);
  const ko = gate.hintMessage('ko', 241000, 'H.claude.md');
  assert.ok(ko.includes('24.1만') && ko.includes('clear_session self') && ko.includes('H.claude.md'));
  assert.ok(gate.hintMessage('en', 241000, 'H.claude.md').includes('241k'));
});

test('model-facing lines tell Claude to name Token Stamina when relaying (v0.3.6)', () => {
  const ko = pace.attributed('Token Stamina: x', 'ko');
  assert.ok(ko.startsWith('Token Stamina: x') && ko.includes('"Token Stamina 알림:"'));
  assert.ok(pace.attributed('Token Stamina: x', 'en').includes('start with "Token Stamina:"'));
  assert.ok(pace.attributed('y', undefined).includes('Token Stamina:'));
});
