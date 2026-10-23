'use strict';
// Registers the Token Stamina status line through a small launcher in the Token Stamina folder, so the entry in
// settings.json never names a version folder and keeps working after plugin updates. An existing status line that is
// not Token Stamina's is kept and wrapped. Only run after the user agreed. --dry-run writes nothing.
// Usage: node setup-statusline.js [--dry-run] [--settings <path>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const pace = require('./pace');

const LAUNCHER = 'token-stamina-statusline.js';

function parseArgs(argv) {
  const o = { dryRun: false, settings: path.join(os.homedir(), '.claude', 'settings.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') o.dryRun = true;
    else if (argv[i] === '--settings') o.settings = argv[++i];
  }
  return o;
}

function launcherPath() { return path.join(pace.home(), LAUNCHER); }

// The launcher looks up the installed plugin in Claude Code's plugin list on every run and falls back to the root
// that wrote it. It must stay self-contained: it is copied out of the plugin folder.
function launcherSource(root) {
  return `'use strict';
// Token Stamina status line launcher (written by setup; refreshed at startup). Runs the installed version.
const fs = require('fs');
const os = require('os');
const path = require('path');
const FALLBACK = ${JSON.stringify(path.resolve(root))};
function roots() {
  const out = [];
  try {
    const list = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
    const keys = Object.keys(list).filter((k) => /^token-stamina@/.test(k)).sort((a, b) => (b === 'token-stamina@token-stamina') - (a === 'token-stamina@token-stamina'));
    for (const k of keys) for (const e of [].concat(list[k] || [])) if (e && e.installPath) out.push(e.installPath);
  } catch (e) { /* no list: use the fallback */ }
  out.push(FALLBACK);
  return out;
}
const root = roots().find((r) => fs.existsSync(path.join(r, 'scripts', 'statusline.js')));
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try { if (root) process.stdout.write(require(path.join(root, 'scripts', 'statusline.js')).run(raw)); } catch (e) { /* silent */ }
  process.exit(0);
});
`;
}

// Writes the launcher when missing or different. Returns true when the file changed.
function writeLauncher(root) {
  const file = launcherPath();
  const src = launcherSource(root);
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch (e) { /* missing */ }
  if (cur === src) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, src);
  return true;
}

function command() { return `node "${launcherPath().replace(/\\/g, '/')}"`; }

function stamp(d) { return d.toISOString().replace(/[:.]/g, '-'); }

// Returns {ok, message, ...}. Pure apart from the files it is told to touch.
function apply(opts, root, now) {
  now = now || new Date();
  const ours = require('./first-run').registered;
  let raw;
  try { raw = fs.readFileSync(opts.settings, 'utf8'); } catch (e) { raw = null; }
  let settings = {};
  if (raw !== null) {
    try { settings = JSON.parse(raw); } catch (e) { return { ok: false, message: 'Settings file is not valid JSON; nothing changed.' }; }
  }
  const before = settings.statusLine && settings.statusLine.command ? String(settings.statusLine.command) : null;
  const target = command();
  const cfgFile = path.join(pace.home(), 'config.json');
  const cfg = pace.readJson(cfgFile, {}) || {};
  // Wrap only someone else's status line; an older Token Stamina entry is replaced, never wrapped (it would run twice).
  const wrap = before && before !== target && !ours(settings) ? before : null;
  const lines = [`settings: ${opts.settings}`, `statusLine: ${before === null ? '(none)' : before} -> ${target}`,
    `launcher: ${launcherPath()} (runs the installed version; falls back to ${path.resolve(root)})`];
  if (wrap) lines.push(`kept and wrapped (config wrap): ${wrap}`);
  if (opts.dryRun) return { ok: true, dryRun: true, changed: before !== target, wrap, message: lines.join('\n') + '\n(dry run: nothing written)' };
  writeLauncher(root);
  if (wrap) { cfg.wrap = wrap; pace.writeJson(cfgFile, cfg); }
  let backup = null;
  if (before !== target) {
    if (raw !== null) {
      backup = opts.settings + '.bak-token-stamina-' + stamp(now);
      fs.copyFileSync(opts.settings, backup);
    }
    const next = raw !== null ? JSON.parse(raw) : {};
    next.statusLine = Object.assign({}, next.statusLine, { type: 'command', command: target });
    const indent = raw && /^\{\r?\n( +)"/.exec(raw);
    fs.mkdirSync(path.dirname(opts.settings), { recursive: true });
    fs.writeFileSync(opts.settings, JSON.stringify(next, null, indent ? indent[1].length : 2) + '\n');
  }
  return { ok: true, dryRun: false, changed: before !== target, wrap, backup,
    message: lines.join('\n') + (backup ? `\nbackup: ${backup}` : before === target ? '\n(status line already set; launcher refreshed)' : '') };
}

module.exports = { apply, parseArgs, launcherPath, launcherSource, writeLauncher, command, LAUNCHER };

if (require.main === module) {
  const r = apply(parseArgs(process.argv.slice(2)), process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..'));
  process.stdout.write(r.message + '\n');
  process.exit(r.ok ? 0 : 1);
}
