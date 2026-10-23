'use strict';
// Background update check, started by first-run.js at most once a day. Reads the published plugin.json version from
// GitHub (one GET, nothing sent but the request itself) and writes it to update-check.json; the next startup compares.
// Usage: node update-check.js [<url>]
const https = require('https');
const path = require('path');
const pace = require('./pace');

const URL = 'https://raw.githubusercontent.com/token-stamina/token-stamina/main/.claude-plugin/plugin.json';
const FILE = () => path.join(pace.home(), 'update-check.json');

function parse(body) {
  try { const v = JSON.parse(body).version; return /^\d+\.\d+\.\d+/.test(String(v)) ? String(v) : null; } catch (e) { return null; }
}

function check(url, done) {
  let finished = false;
  const end = (v) => { if (!finished) { finished = true; done(v); } };
  try {
    const req = https.get(url, { timeout: 5000, headers: { 'user-agent': 'token-stamina-update-check' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return end(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
      res.on('end', () => end(parse(body)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => end(null));
  } catch (e) { end(null); }
}

module.exports = { parse, check, URL, FILE };

if (require.main === module) {
  check(process.argv[2] || URL, (latest) => {
    const prev = pace.readJson(FILE(), {}) || {};
    pace.writeJson(FILE(), { checked: new Date().toISOString(), latest: latest || prev.latest || null });
    process.exit(0);
  });
}
