'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// Language pick in setup: writes only lang, keeps other keys, rejects unsupported values.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pacer-v05-'));
process.env.TOKEN_STAMINA_HOME = TMP;
const lang = require('../scripts/setup-lang');
const pace = require('../scripts/pace');
const CFG = path.join(TMP, 'config.json');

test('setup-lang: dry run writes nothing', () => {
  const r = lang.apply({ lang: 'ko', dryRun: true });
  assert.ok(r.ok && r.changed && r.message.includes('(unset, auto) -> ko'));
  assert.ok(!fs.existsSync(CFG));
});

test('setup-lang: sets lang and keeps other keys', () => {
  fs.writeFileSync(CFG, JSON.stringify({ wrap: 'old cmd', compactWindowTokens: 400000 }));
  const r = lang.apply({ lang: 'ko', dryRun: false });
  assert.ok(r.ok && r.changed);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(CFG, 'utf8')), { wrap: 'old cmd', compactWindowTokens: 400000, lang: 'ko' });
  assert.strictEqual(pace.loadConfig().lang, 'ko');
  assert.ok(!lang.apply({ lang: 'ko', dryRun: false }).changed);
});

test('setup-lang: rejects unsupported language and leaves config alone', () => {
  const before = fs.readFileSync(CFG, 'utf8');
  for (const x of ['fr', '', null]) assert.ok(!lang.apply({ lang: x, dryRun: false }).ok);
  assert.strictEqual(fs.readFileSync(CFG, 'utf8'), before);
  assert.deepStrictEqual(lang.parseArgs(['--lang', 'KO', '--dry-run']), { lang: 'ko', dryRun: true });
});
