'use strict';
// Records the language for Token Stamina's own lines (status line, hints) in the Token Stamina config.
// Only run after the user picked a language. --dry-run writes nothing.
// Usage: node setup-lang.js --lang auto|en|ko|ja|zh [--dry-run]
const path = require('path');
const pace = require('./pace');

const SUPPORTED = ['auto', 'en', 'ko', 'ja', 'zh'];

function parseArgs(argv) {
  const o = { lang: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang') o.lang = String(argv[++i] || '').toLowerCase();
    else if (argv[i] === '--dry-run') o.dryRun = true;
  }
  return o;
}

// Returns {ok, message, changed}. Keeps every other key in config.json.
function apply(opts) {
  if (!SUPPORTED.includes(opts.lang)) return { ok: false, message: `Pass --lang ${SUPPORTED.join('|')}.` };
  const cfgFile = path.join(pace.home(), 'config.json');
  const cfg = pace.readJson(cfgFile, {}) || {};
  const before = cfg.lang || '(unset, auto)';
  const changed = cfg.lang !== opts.lang;
  const line = `token-stamina config lang: ${before} -> ${opts.lang}`;
  if (opts.dryRun) return { ok: true, dryRun: true, changed, message: line + '\n(dry run: nothing written)' };
  if (changed) { cfg.lang = opts.lang; pace.writeJson(cfgFile, cfg); }
  return { ok: true, dryRun: false, changed, message: line + (changed ? `\nwritten: ${cfgFile}` : '\n(already set; nothing changed)') };
}

module.exports = { apply, parseArgs, SUPPORTED };

if (require.main === module) {
  const r = apply(parseArgs(process.argv.slice(2)));
  process.stdout.write(r.message + '\n');
  process.exit(r.ok ? 0 : 1);
}
