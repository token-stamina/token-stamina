'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// First-run setup prompt: asked once at startup when the status line is not Token Stamina's, never again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FR = path.join(__dirname, '..', 'scripts', 'first-run.js');
const fr = require(FR);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stamina-v09-'));
const start = (source) => ({ hook_event_name: 'SessionStart', source, session_id: 's1', cwd: '/w' });

function hook(userHome, input, extraEnv) {
  const env = Object.assign({}, process.env, { USERPROFILE: userHome, HOME: userHome, CLAUDE_PLUGIN_ROOT: '/plug' });
  delete env.TOKEN_STAMINA_HOME; delete env.CLAUDE_CODE_ENTRYPOINT;
  Object.assign(env, extraEnv || {});
  noUpdateCheck(userHome);
  return execFileSync(process.execPath, [FR], { env, input: JSON.stringify(input), encoding: 'utf8' });
}
// Keep the hook off the network in tests: the update check is covered in v046.
function noUpdateCheck(userHome) {
  const f = path.join(userHome, '.claude', 'token-stamina', 'config.json');
  let c = {};
  try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* none yet */ }
  if (c.updateCheck !== undefined) return;
  c.updateCheck = false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(c));
}
function writeSettings(userHome, obj) {
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(userHome, '.claude', 'settings.json'), JSON.stringify(obj));
}

test('registered: Token Stamina status line by path or by plugin root variable', () => {
  assert.ok(fr.registered({ statusLine: { command: 'node "C:/Users/x/.claude/plugins/cache/token-stamina/token-stamina/0.4.5/scripts/statusline.js"' } }));
  assert.ok(fr.registered({ statusLine: { command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js"' } }));
  assert.ok(!fr.registered({ statusLine: { command: 'npx ccstatusline' } }));
  // a source checkout in a folder with another name: recognised by the pace.js next to it
  const dev = path.join(tmp(), 'my checkout', 'scripts');
  fs.mkdirSync(dev, { recursive: true });
  fs.writeFileSync(path.join(dev, 'statusline.js'), ''); fs.writeFileSync(path.join(dev, 'pace.js'), '');
  assert.ok(fr.registered({ statusLine: { command: `node "${path.join(dev, 'statusline.js')}"` } }));
  assert.ok(!fr.registered({ statusLine: { command: `node "${path.join(tmp(), 'statusline.js')}"` } }));
  assert.ok(!fr.registered({}));
  assert.ok(!fr.registered(null));
});

test('decide: only startup, only once, not when registered or turned off', () => {
  const cfg = { lang: 'en' };
  assert.ok(fr.decide(start('startup'), {}, cfg, {}));
  assert.ok(fr.decide({ hook_event_name: 'SessionStart', session_id: 's' }, {}, cfg, {}));   // no source field: treat as startup
  for (const s of ['resume', 'clear', 'compact']) assert.strictEqual(fr.decide(start(s), {}, cfg, {}), null);
  assert.strictEqual(fr.decide({ hook_event_name: 'UserPromptSubmit' }, {}, cfg, {}), null);
  assert.strictEqual(fr.decide(start('startup'), {}, cfg, { asked: '2026-10-24T00:00:00Z' }), null);
  assert.strictEqual(fr.decide(start('startup'), {}, { lang: 'en', setupPrompt: false }, {}), null);
  assert.strictEqual(fr.decide(start('startup'), { statusLine: { command: 'node "/h/.claude/token-stamina/token-stamina-statusline.js"' } }, cfg, {}), null);
  // registered through the plugin root variable: no setup question, but the one-time switch to the launcher (0.4.6)
  assert.strictEqual(fr.decide(start('startup'), { statusLine: { command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js"' } }, cfg, {}).kind, 'migrate');
});

test('fresh install: asks once with the setup file path, then stays quiet', () => {
  const u = tmp();
  const out = JSON.parse(hook(u, start('startup')));
  assert.match(out.systemMessage, /token-stamina:setup/);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(ctx.includes(path.join('/plug', 'commands', 'setup.md')));
  assert.match(ctx, /will not come back/);
  assert.ok(fs.existsSync(path.join(u, '.claude', 'token-stamina', 'first-run.json')));
  assert.strictEqual(hook(u, start('startup')), '');
});

test('already set up, or a resumed session: no output and nothing written', () => {
  const u = tmp();
  writeSettings(u, { statusLine: { type: 'command', command: 'node "/p/token-stamina/scripts/statusline.js"' } });
  assert.strictEqual(hook(u, start('startup')), '');
  const v = tmp();
  assert.strictEqual(hook(v, start('resume')), '');
  assert.ok(!fs.existsSync(path.join(u, '.claude', 'token-stamina', 'first-run.json')));
  assert.ok(!fs.existsSync(path.join(v, '.claude', 'token-stamina', 'first-run.json')));
});

test('someone else\'s status line still gets the one question', () => {
  const u = tmp();
  writeSettings(u, { statusLine: { type: 'command', command: 'npx ccstatusline' } });
  assert.ok(JSON.parse(hook(u, start('startup'))).systemMessage);
});

test('Korean config: Korean notice, Korean attribution', () => {
  const u = tmp();
  fs.mkdirSync(path.join(u, '.claude', 'token-stamina'), { recursive: true });
  fs.writeFileSync(path.join(u, '.claude', 'token-stamina', 'config.json'), '{"lang":"ko"}');
  const out = JSON.parse(hook(u, start('startup')));
  assert.match(out.systemMessage, /상태줄/);
  assert.match(out.hookSpecificOutput.additionalContext, /Token Stamina 알림/);
});

test('headless runs are skipped', () => {
  assert.strictEqual(hook(tmp(), start('startup'), { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }), '');
});

test('hooks.json runs first-run.js on startup only', () => {
  const h = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  const e = h.hooks.SessionStart.find((x) => x.hooks.some((k) => /first-run\.js/.test(k.command)));
  assert.strictEqual(e.matcher, 'startup');
});
