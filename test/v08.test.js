'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// Rename Token Pacer -> Token Stamina: data folder follows the new name, old folder / old env name still work.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PACE = path.join(__dirname, '..', 'scripts', 'pace.js');

function homeIn(userHome, env) {
  const e = Object.assign({}, process.env, { USERPROFILE: userHome, HOME: userHome }, env || {});
  delete e.TOKEN_STAMINA_HOME; delete e.TOKEN_PACER_HOME;
  Object.assign(e, env || {});
  return execFileSync(process.execPath, ['-e', `const p=require(${JSON.stringify(PACE)});process.stdout.write(p.home())`], { env: e, encoding: 'utf8' });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stamina-v08-'));

test('fresh install uses ~/.claude/token-stamina and creates nothing', () => {
  const u = tmp();
  assert.strictEqual(homeIn(u), path.join(u, '.claude', 'token-stamina'));
  assert.ok(!fs.existsSync(path.join(u, '.claude')));
});

test('only the old folder exists: copied once, old folder left in place', () => {
  const u = tmp(), old = path.join(u, '.claude', 'token-pacer');
  fs.mkdirSync(path.join(old, 'handoff'), { recursive: true });
  fs.writeFileSync(path.join(old, 'state.json'), '{"a":1}');
  fs.writeFileSync(path.join(old, 'config.json'), '{"lang":"ko"}');
  fs.writeFileSync(path.join(old, 'handoff', 'n.md'), 'note');
  const nw = path.join(u, '.claude', 'token-stamina');
  assert.strictEqual(homeIn(u), nw);
  assert.strictEqual(fs.readFileSync(path.join(nw, 'state.json'), 'utf8'), '{"a":1}');
  assert.strictEqual(fs.readFileSync(path.join(nw, 'handoff', 'n.md'), 'utf8'), 'note');
  assert.ok(fs.existsSync(path.join(old, 'state.json')));
  // later writes to the old folder (a not-yet-updated install) are not copied again
  fs.writeFileSync(path.join(old, 'state.json'), '{"a":2}');
  homeIn(u);
  assert.strictEqual(fs.readFileSync(path.join(nw, 'state.json'), 'utf8'), '{"a":1}');
});

test('both folders exist: the new one wins untouched', () => {
  const u = tmp(), old = path.join(u, '.claude', 'token-pacer'), nw = path.join(u, '.claude', 'token-stamina');
  fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(nw, { recursive: true });
  fs.writeFileSync(path.join(old, 'state.json'), 'old'); fs.writeFileSync(path.join(nw, 'state.json'), 'new');
  homeIn(u);
  assert.strictEqual(fs.readFileSync(path.join(nw, 'state.json'), 'utf8'), 'new');
});

test('env: TOKEN_STAMINA_HOME wins, old TOKEN_PACER_HOME still honoured, no migration then', () => {
  const u = tmp(), a = path.join(u, 'a'), b = path.join(u, 'b');
  fs.mkdirSync(path.join(u, '.claude', 'token-pacer'), { recursive: true });
  assert.strictEqual(homeIn(u, { TOKEN_STAMINA_HOME: a, TOKEN_PACER_HOME: b }), a);
  assert.strictEqual(homeIn(u, { TOKEN_PACER_HOME: b }), b);
  assert.ok(!fs.existsSync(path.join(u, '.claude', 'token-stamina')));
});

test('handoff notes written under the old name are still recognised', () => {
  process.env.TOKEN_STAMINA_HOME = tmp();
  const handoff = require('../scripts/handoff');
  const mk = (n) => `<!-- ${n}-handoff session=s1 lastPromptTs=2026-10-23T10:00:00Z saved=2026-10-23T10:05:00Z -->\nx`;
  assert.strictEqual(handoff.parseMeta(mk('token-pacer')).session, 's1');
  assert.strictEqual(handoff.parseMeta(mk('token-stamina')).session, 's1');
});

test('no leftover old product name in shipped files', () => {
  const root = path.join(__dirname, '..');
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'v08.test.js') continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else if (/Token Pacer|token-pacer|TOKEN_PACER|tokenpacer/.test(fs.readFileSync(f, 'utf8'))) hits.push(path.relative(root, f).split(path.sep).join('/'));
  } };
  walk(root);
  // The legacy-folder fallback (scripts/pace.js and its mirror in hooks/register.ts). README no longer carries the old name.
  assert.deepStrictEqual(hits.sort(), ['hooks/register.ts', 'scripts/pace.js']);
});

test('W7 #16: every test file loads the temp-home helper before anything else, so no test touches the real data folder', () => {
  const root = path.join(__dirname, '..');
  const files = [
    ...fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => 'test/' + f),
    ...fs.readdirSync(path.join(root, 'hooks')).filter((f) => f.endsWith('.test.ts')).map((f) => 'hooks/' + f),
  ];
  assert.ok(files.length >= 30);
  const missing = files.filter((f) => {
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/);
    const first = lines.find((l) => /^\s*(require\(|import )/.test(l)) || '';
    return !/helpers\/temp-home/.test(first);
  });
  assert.deepStrictEqual(missing, []);
  const os = require('os');
  assert.ok(process.env.TOKEN_STAMINA_HOME.startsWith(os.tmpdir()), 'this process runs on a temp home');
  assert.notEqual(path.resolve(process.env.TOKEN_STAMINA_HOME), path.resolve(os.homedir(), '.claude', 'token-stamina'));
});

test('W7 #15: the README version heading matches plugin.json', () => {
  const root = path.join(__dirname, '..');
  const v = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const heads = fs.readFileSync(path.join(root, 'README.md'), 'utf8').split(/\r?\n/).filter((l) => /^## v\d/.test(l)).map((l) => l.match(/^## v([\d.]+)/)[1]);
  assert.strictEqual(heads[heads.length - 1], v);
});
