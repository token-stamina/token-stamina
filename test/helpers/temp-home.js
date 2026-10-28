'use strict';
// Loaded FIRST by every test file (test/*.test.js and hooks/*.test.ts): the data folder is a fresh temp directory, so
// no test can read or write the real ~/.claude/token-stamina, whatever the test file itself forgets to set.
// The folder is removed when the test process exits (only this exact folder, created here: never a path from the env).
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEGACY = ['TOKEN', 'PACER', 'HOME'].join('_'); // old folder variable; must not point anywhere real either
delete process.env[LEGACY];
const PREFIX = 'ts-home-';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
process.env.TOKEN_STAMINA_HOME = HOME;

function cleanup() {
  // guard by shape: a direct child of the temp dir with our prefix, i.e. the folder mkdtempSync just made
  if (path.dirname(HOME) !== path.resolve(os.tmpdir()) || !path.basename(HOME).startsWith(PREFIX)) return;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}
process.once('exit', cleanup);

module.exports = { HOME, PREFIX, cleanup };
