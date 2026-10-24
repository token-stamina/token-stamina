'use strict';
// 0.4.7: yes/no and pick-one questions are asked with buttons (AskUserQuestion), not typed answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const fr = require('../scripts/first-run');
const ROOT = path.join(__dirname, '..');

test('first-run questions ask for buttons, with a text fallback', () => {
  for (const s of [fr.context(ROOT), fr.migrateContext(ROOT)]) {
    assert.match(s, /AskUserQuestion/);
    assert.match(s, /one short line instead if that tool is unavailable/);
  }
});

test('setup and autocompact ask fixed-answer questions with AskUserQuestion', () => {
  for (const f of ['setup.md', 'autocompact.md']) {
    const s = fs.readFileSync(path.join(ROOT, 'commands', f), 'utf8');
    assert.match(s, /^allowed-tools: .*AskUserQuestion$/m);
    assert.match(s, /with the AskUserQuestion tool/);
  }
});
