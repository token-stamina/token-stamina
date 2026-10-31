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

// The user's home is swapped too, so nothing that defaults to ~/.claude (projects, settings.json, agents) can reach
// the real one: without this the fleet scan counted this PC's live sessions and tests passed or failed with them.
// REAL_HOME is kept only for tests that check the real data folder was left untouched.
const REAL_HOME = os.homedir();
const USER_PREFIX = 'ts-user-';
const USER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), USER_PREFIX));
process.env.HOME = USER_HOME;
process.env.USERPROFILE = USER_HOME;

function cleanup() {
  // guard by shape: a direct child of the temp dir with our prefix, i.e. the folder mkdtempSync just made
  for (const [dir, prefix] of [[HOME, PREFIX], [USER_HOME, USER_PREFIX]]) {
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith(prefix)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}
process.once('exit', cleanup);

module.exports = { HOME, PREFIX, USER_HOME, REAL_HOME, cleanup };
