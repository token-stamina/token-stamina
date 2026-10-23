'use strict';
// Sets (or removes) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW in a settings.json and records compactWindowTokens in the
// Token Stamina config. Only run after the user picked a value. --dry-run writes nothing.
// Usage: node setup-compact.js --window 400000|default [--dry-run] [--settings <path>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const pace = require('./pace');

const KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

function parseArgs(argv) {
  const o = { window: null, dryRun: false, settings: path.join(os.homedir(), '.claude', 'settings.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--window') o.window = argv[++i];
    else if (argv[i] === '--dry-run') o.dryRun = true;
    else if (argv[i] === '--settings') o.settings = argv[++i];
  }
  return o;
}

function stamp(d) { return d.toISOString().replace(/[:.]/g, '-'); }

// Returns {ok, message, ...}. Pure apart from the files it is told to touch.
function apply(opts, now) {
  now = now || new Date();
  let target = null;
  if (opts.window === 'default') target = null;
  else {
    const n = Number(opts.window);
    if (!/^\d+$/.test(String(opts.window)) || n < 100000 || n > 2000000) return { ok: false, message: 'Pass --window <100000..2000000> or --window default.' };
    target = n;
  }
  let raw;
  try { raw = fs.readFileSync(opts.settings, 'utf8'); } catch (e) { return { ok: false, message: 'Cannot read settings file: ' + opts.settings }; }
  let settings;
  try { settings = JSON.parse(raw); } catch (e) { return { ok: false, message: 'Settings file is not valid JSON; nothing changed.' }; }
  const before = settings.env && settings.env[KEY] !== undefined ? String(settings.env[KEY]) : null;
  const next = JSON.parse(raw);
  if (target === null) {
    if (next.env) { delete next.env[KEY]; if (!Object.keys(next.env).length) delete next.env; }
  } else {
    next.env = Object.assign({}, next.env, { [KEY]: String(target) });
  }
  const after = target === null ? null : String(target);
  const lines = [`settings: ${opts.settings}`, `env.${KEY}: ${before === null ? '(unset)' : before} -> ${after === null ? '(unset, Claude Code default)' : after}`,
    `token-stamina config compactWindowTokens: ${target === null ? '(removed)' : target}`];
  if (opts.dryRun) return { ok: true, dryRun: true, changed: before !== after, message: lines.join('\n') + '\n(dry run: nothing written)' };
  let backup = null;
  if (before !== after) {
    backup = opts.settings + '.bak-token-stamina-' + stamp(now);
    fs.copyFileSync(opts.settings, backup);
    const indent = /^\{\n( +)"/.exec(raw);
    fs.writeFileSync(opts.settings, JSON.stringify(next, null, indent ? indent[1].length : 2) + '\n');
  }
  const cfgFile = path.join(pace.home(), 'config.json');
  const cfg = pace.readJson(cfgFile, {}) || {};
  if (target === null) delete cfg.compactWindowTokens; else cfg.compactWindowTokens = target;
  pace.writeJson(cfgFile, cfg);
  return { ok: true, dryRun: false, changed: before !== after, backup, message: lines.join('\n') + (backup ? `\nbackup: ${backup}` : '\n(settings already had this value; no backup needed)') };
}

module.exports = { apply, parseArgs, KEY };

if (require.main === module) {
  const r = apply(parseArgs(process.argv.slice(2)));
  process.stdout.write(r.message + '\n');
  process.exit(r.ok ? 0 : 1);
}
