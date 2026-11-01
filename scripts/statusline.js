'use strict';
// Shipped as scripts/statusline.js in the mod build, for users upgrading from the Node versions.
// Their settings.json still runs the launcher that setup wrote (~/.claude/token-stamina/token-stamina-statusline.js),
// which loads scripts/statusline.js from the installed version. The mod draws its own status row, so this
// prints no Token Stamina segment (no second row); it only keeps the user's own status line (config.wrap)
// running until /token-stamina:setup removes the old entry.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function home() {
  return process.env.TOKEN_STAMINA_HOME || process.env.TOKEN_PACER_HOME || path.join(os.homedir(), '.claude', 'token-stamina');
}

function run(raw) {
  let wrap = '';
  try {
    wrap = JSON.parse(fs.readFileSync(path.join(home(), 'config.json'), 'utf8')).wrap || '';
  } catch (e) { /* no config: nothing to run */ }
  if (typeof wrap !== 'string' || !wrap) return '';
  try {
    const r = cp.spawnSync(wrap, { input: raw, shell: true, encoding: 'utf8', timeout: 3000 });
    return (r.stdout || '').replace(/\s+$/, '');
  } catch (e) {
    return '';
  }
}

module.exports = { run };
