'use strict';
// Fixed-cost audit (no LLM): always-loaded files, plugins, MCP/skill usage from local transcripts, off-candidates.
// Usage: node audit.js [--cwd <path>] [--days 30] [--json] [--no-details] [--no-cli] [--no-cache]
// Never changes any setting; it only prints how to turn things off.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const cp = require('child_process');
const pace = require('./pace');

const BUILTIN_SERVER = /^(ccd_|Claude_Browser$|terminal$|visualize$|scheduled-tasks$|computer-use$|mcp-registry$|remote-devices$)/;
const UUID_SERVER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- helpers ----------
function estimateTokens(text) {
  let ascii = 0, other = 0;
  for (const ch of String(text)) { if (ch.codePointAt(0) < 128) ascii++; else other++; }
  return Math.round(ascii / 4 + other / 1.5);
}

// Claude Code project folder name: every non-alphanumeric character becomes '-' (C:\Projects -> C--Projects).
function encodeCwd(cwd) { return String(cwd).replace(/[^A-Za-z0-9]/g, '-'); }

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

function realOr(p) { try { return fs.realpathSync(p); } catch (e) { return p; } }

function alwaysLoadedFiles(cwd, homeDir) {
  const claudeDir = path.join(homeDir, '.claude');
  const cands = [path.join(claudeDir, 'CLAUDE.md')];
  let dir = path.resolve(cwd);
  for (;;) {
    cands.push(path.join(dir, 'CLAUDE.md'), path.join(dir, 'CLAUDE.local.md'), path.join(dir, '.claude', 'CLAUDE.md'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  cands.push(path.join(claudeDir, 'projects', encodeCwd(path.resolve(cwd)), 'memory', 'MEMORY.md'));
  const seen = new Set(), out = [];
  for (const p of cands) {
    const t = readText(p);
    if (t === null) continue;
    const key = realOr(p).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: p, chars: [...t].length, tokens_est: estimateTokens(t) });
  }
  return out;
}

// shell:true is needed on Windows to resolve claude.cmd, so every argument must be plain: fixed words, or a
// plugin id read from `claude plugin list` (third-party marketplaces choose those names).
const SAFE_ARG = /^[A-Za-z0-9._@:\/-]+$/;
function runClaude(args, timeout) {
  if (!args.every((a) => SAFE_ARG.test(String(a)))) return null;
  try {
    const r = cp.spawnSync('claude ' + args.join(' '), { encoding: 'utf8', shell: true, timeout: timeout || 30000, windowsHide: true });
    if (r.status === 0 && r.stdout) return r.stdout;
  } catch (e) { /* ignore */ }
  return null;
}

function pluginHasHooks(installPath) {
  if (!installPath) return false;
  if (fs.existsSync(path.join(installPath, 'hooks', 'hooks.json'))) return true;
  const pj = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'));
  return !!(pj && pj.hooks);
}

function parseAlwaysOn(text) {
  const m = /Always-on:\s*~?([\d.]+)\s*(k?)\s*tok/i.exec(text || '');
  return m ? Math.round(parseFloat(m[1]) * (m[2] ? 1000 : 1)) : null;
}

function listPlugins(homeDir, opts) {
  const claudeDir = path.join(homeDir, '.claude');
  let list = null;
  if (opts.cli) {
    const out = runClaude(['plugin', 'list', '--json'], 40000);
    if (out) { try { list = JSON.parse(out); } catch (e) { list = null; } }
  }
  let source = 'claude plugin list --json';
  if (!Array.isArray(list)) {
    source = 'settings.json + installed_plugins.json';
    list = [];
    const settings = readJson(path.join(claudeDir, 'settings.json')) || {};
    const inst = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json')) || {};
    const enabled = settings.enabledPlugins || {};
    for (const [id, arr] of Object.entries(inst.plugins || {})) {
      const e = Array.isArray(arr) ? arr[0] : arr;
      list.push({ id, version: e && e.version, scope: e && e.scope, enabled: enabled[id] !== false, installPath: e && e.installPath });
    }
  }
  const plugins = list.map((p) => {
    const name = String(p.id).split('@')[0];
    const r = { id: p.id, name, version: p.version || null, enabled: p.enabled !== false, hooks: pluginHasHooks(p.installPath),
      mcp_servers: Object.keys(p.mcpServers || {}), always_on_tokens: null };
    if (opts.cli && opts.details && r.enabled) r.always_on_tokens = parseAlwaysOn(runClaude(['plugin', 'details', p.id], 30000));
    return r;
  });
  return { source, plugins };
}

function configuredMcp(cwd, homeDir) {
  const out = [];
  const cj = readJson(path.join(homeDir, '.claude.json')) || {};
  for (const n of Object.keys(cj.mcpServers || {})) out.push({ name: n, origin: 'user (~/.claude.json)' });
  const proj = (cj.projects || {})[path.resolve(cwd)] || (cj.projects || {})[path.resolve(cwd).replace(/\\/g, '/')];
  if (proj) for (const n of Object.keys(proj.mcpServers || {})) out.push({ name: n, origin: 'project (~/.claude.json)' });
  let dir = path.resolve(cwd);
  for (;;) {
    const mj = readJson(path.join(dir, '.mcp.json'));
    if (mj && mj.mcpServers) for (const n of Object.keys(mj.mcpServers)) out.push({ name: n, origin: 'project (' + path.join(dir, '.mcp.json') + ')' });
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

// ---------- usage scan ----------
function* walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

// Per-file extraction: { servers: {name: {day: n}}, skills: {name: {day: n}}, last: {key: iso} }.
async function scanFile(file) {
  const res = { servers: {}, skills: {}, last: {} };
  const seen = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.indexOf('"tool_use"') < 0) continue;
    if (line.indexOf('"name":"mcp__') < 0 && line.indexOf('"name":"Skill"') < 0) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
    const ts = typeof o.timestamp === 'string' ? o.timestamp : '';
    const day = ts.slice(0, 10) || 'unknown';
    for (const c of o.message.content) {
      if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
      if (c.id) { if (seen.has(c.id)) continue; seen.add(c.id); }
      let bucket, key;
      if (c.name.startsWith('mcp__')) { bucket = res.servers; key = c.name.split('__')[1]; }
      else if (c.name === 'Skill' && c.input && typeof c.input.skill === 'string') { bucket = res.skills; key = c.input.skill; }
      else continue;
      if (!key) continue;
      const b = bucket[key] || (bucket[key] = {});
      b[day] = (b[day] || 0) + 1;
      const lk = (bucket === res.servers ? 's:' : 'k:') + key;
      if (ts && (!res.last[lk] || ts > res.last[lk])) res.last[lk] = ts;
    }
  }
  return res;
}

async function scanUsage(projectsDir, days, opts) {
  const cutoffMs = Date.now() - days * 86400000;
  const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
  const cacheFile = path.join(pace.home(), 'audit-cache.json');
  const cache = opts.cache ? (pace.readJson(cacheFile, { v: 1, files: {} })) : { v: 1, files: {} };
  const files = cache.files || (cache.files = {});
  const alive = new Set();
  let scanned = 0, cached = 0, considered = 0;
  const servers = {}, skills = {}, last = {};
  for (const file of walk(projectsDir)) {
    let st;
    try { st = fs.statSync(file); } catch (e) { continue; }
    if (st.mtimeMs < cutoffMs) continue;
    considered++;
    alive.add(file);
    let ent = files[file];
    if (ent && ent.mtimeMs === st.mtimeMs && ent.size === st.size) cached++;
    else {
      ent = Object.assign({ mtimeMs: st.mtimeMs, size: st.size }, await scanFile(file));
      files[file] = ent;
      scanned++;
    }
    for (const [src, dst] of [[ent.servers, servers], [ent.skills, skills]]) {
      for (const [k, byDay] of Object.entries(src)) {
        for (const [d, n] of Object.entries(byDay)) {
          if (d < cutoffDay) continue;
          dst[k] = (dst[k] || 0) + n;
        }
      }
    }
    for (const [lk, ts] of Object.entries(ent.last)) if (ts.slice(0, 10) >= cutoffDay && (!last[lk] || ts > last[lk])) last[lk] = ts;
  }
  if (opts.cache) {
    for (const f of Object.keys(files)) if (!alive.has(f)) delete files[f];
    try { pace.writeJson(cacheFile, cache); } catch (e) { /* ignore */ }
  }
  return { servers, skills, last, stats: { files_considered: considered, files_scanned: scanned, files_cached: cached } };
}

// ---------- classification + recommendations ----------
function classifyServer(name, pluginNames) {
  if (BUILTIN_SERVER.test(name)) return 'builtin';
  if (name.startsWith('plugin_')) {
    const rest = name.slice(7);
    for (const p of pluginNames) if (rest === p || rest.startsWith(p + '_')) return 'plugin:' + p;
    return 'app_plugin';
  }
  if (UUID_SERVER.test(name)) return 'connector';
  if (name === 'claude-in-chrome') return 'extension';
  return 'other';
}

function pluginUsage(plugin, usage) {
  let calls = 0, last = null;
  for (const [k, n] of Object.entries(usage.skills)) {
    if (k === plugin.name || k.startsWith(plugin.name + ':')) {
      calls += n;
      const t = usage.last['k:' + k]; if (t && (!last || t > last)) last = t;
    }
  }
  for (const [k, n] of Object.entries(usage.servers)) {
    if (k.startsWith('plugin_' + plugin.name + '_') || k === 'plugin_' + plugin.name) {
      calls += n;
      const t = usage.last['s:' + k]; if (t && (!last || t > last)) last = t;
    }
  }
  return { calls, last };
}

function buildReport(opts) {
  return (async () => {
    const homeDir = opts.homeDir;
    const claudeDir = path.join(homeDir, '.claude');
    const files = alwaysLoadedFiles(opts.cwd, homeDir);
    const pl = listPlugins(homeDir, opts);
    const usage = await scanUsage(opts.projectsDir || path.join(claudeDir, 'projects'), opts.days, opts);
    const pluginNames = pl.plugins.map((p) => p.name);

    const plugins = pl.plugins.map((p) => {
      const u = pluginUsage(p, usage);
      return Object.assign(p, { calls: u.calls, last_used: u.last });
    });
    const servers = Object.keys(usage.servers).map((n) => ({ name: n, kind: classifyServer(n, pluginNames), calls: usage.servers[n], last_used: usage.last['s:' + n] || null }))
      .sort((a, b) => b.calls - a.calls);
    const skills = Object.keys(usage.skills).map((n) => ({ name: n, calls: usage.skills[n], last_used: usage.last['k:' + n] || null }))
      .sort((a, b) => b.calls - a.calls);

    // Plugins seen in usage but absent from the config files: app-managed, cost unknown.
    const appPlugins = new Set();
    for (const s of servers) if (s.kind === 'app_plugin') appPlugins.add(s.name.slice(7).split('_')[0]);
    for (const s of skills) {
      const i = s.name.indexOf(':');
      if (i > 0 && !pluginNames.includes(s.name.slice(0, i)) && !s.name.startsWith('anthropic-skills')) appPlugins.add(s.name.slice(0, i));
    }

    const candidates = [];
    for (const p of plugins) {
      if (!p.enabled) continue;
      if (p.calls > 0) continue;
      if (p.hooks) continue; // hook-only behaviour cannot be counted from transcripts
      candidates.push({ kind: 'plugin', name: p.id, why: 'no skill/MCP calls in window', how: 'claude plugin disable ' + p.id,
        tokens: p.always_on_tokens });
    }
    const seenMcp = new Set();
    for (const m of configuredMcp(opts.cwd, homeDir)) {
      if (seenMcp.has(m.name)) continue;
      seenMcp.add(m.name);
      if (usage.servers[m.name]) continue;
      candidates.push({ kind: 'mcp', name: m.name, origin: m.origin, why: 'no calls in window', how: 'claude mcp remove ' + m.name + '  (or app: Settings -> Connectors/Extensions)', tokens: null });
    }

    return {
      generated: new Date().toISOString(), cwd: opts.cwd, days: opts.days,
      always_loaded: { files, total_tokens_est: files.reduce((a, f) => a + f.tokens_est, 0), note: 'estimate: ASCII chars/4 + non-ASCII chars/1.5' },
      plugins_source: pl.source, plugins, app_managed_plugins_seen: [...appPlugins],
      mcp_usage: servers, skill_usage: skills, candidates, scan: usage.stats,
    };
  })();
}

// ---------- text output ----------
function width(s) { let w = 0; for (const ch of String(s)) w += ch.codePointAt(0) > 0x2e80 ? 2 : 1; return w; }
function pad(s, w) { s = String(s); return s + ' '.repeat(Math.max(0, w - width(s))); }
function table(headers, rows) {
  const ws = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (r) => r.map((c, i) => pad(c, ws[i])).join('  ').replace(/\s+$/, '');
  return [line(headers), ws.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}
const dayOf = (iso) => (iso ? iso.slice(0, 10) : '-');
const kindLabel = (k, ko) => {
  if (k === 'builtin') return ko ? '내장(끌 수 없음)' : 'built-in (cannot disable)';
  if (k === 'connector') return ko ? '커넥터(앱 관리)' : 'connector (app-managed)';
  if (k === 'extension') return ko ? '브라우저 확장(앱 관리)' : 'browser extension (app-managed)';
  if (k === 'app_plugin') return ko ? '앱 관리 플러그인' : 'app-managed plugin';
  if (k.startsWith('plugin:')) return ko ? '플러그인 ' + k.slice(7) : 'plugin ' + k.slice(7);
  return ko ? '기타/사용자 설정' : 'other/user config';
};

function render(r, lang) {
  const ko = lang === 'ko';
  const L = (a, b) => (ko ? a : b);
  const out = [];
  out.push(L(`Token Stamina 고정 비용 감사 (최근 ${r.days}일, cwd ${r.cwd})`, `Token Stamina fixed-cost audit (last ${r.days} days, cwd ${r.cwd})`));
  out.push('');
  out.push(L('1. 매 세션 항상 실리는 파일 (토큰은 추정값)', '1. Always-loaded files (tokens are estimates)'));
  out.push(table([L('파일', 'File'), L('글자', 'Chars'), L('추정 토큰', 'Est. tokens')],
    r.always_loaded.files.map((f) => [f.path, f.chars, '~' + f.tokens_est]).concat([[L('합계', 'Total'), '', '~' + r.always_loaded.total_tokens_est]])));
  out.push(L('  추정식: ASCII 글자/4 + 비ASCII 글자/1.5 (실제 토큰과 다를 수 있어요)', '  Formula: ASCII chars/4 + non-ASCII chars/1.5 (may differ from real tokens)'));
  out.push('');
  out.push(L(`2. 플러그인 (출처: ${r.plugins_source})`, `2. Plugins (source: ${r.plugins_source})`));
  if (r.plugins.length) {
    out.push(table([L('플러그인', 'Plugin'), L('켜짐', 'On'), L('항상 실리는 토큰', 'Always-on tok'), L('훅', 'Hooks'), L('호출', 'Calls'), L('마지막 사용', 'Last used')],
      r.plugins.map((p) => [p.id + (p.version ? ' ' + p.version : ''), p.enabled ? 'yes' : 'no',
        p.always_on_tokens == null ? L('알 수 없음', 'unknown') : '~' + p.always_on_tokens, p.hooks ? 'yes' : '-', p.calls, dayOf(p.last_used)])));
  } else out.push(L('  (설정 파일에 설치된 플러그인 없음)', '  (no plugins installed in config files)'));
  if (r.app_managed_plugins_seen.length) {
    out.push(L('  앱이 관리하는 플러그인(설정 파일에 없음, 비용 알 수 없음): ', '  App-managed plugins (not in config files, cost unknown): ') + r.app_managed_plugins_seen.join(', '));
  }
  out.push('');
  out.push(L('3. MCP 서버 사용 (호출 수는 이 PC의 Code 기록 기준)', '3. MCP server usage (calls from local Code transcripts)'));
  out.push(r.mcp_usage.length ? table([L('서버', 'Server'), L('구분', 'Kind'), L('호출', 'Calls'), L('마지막 사용', 'Last used')],
    r.mcp_usage.map((s) => [s.name, kindLabel(s.kind, ko), s.calls, dayOf(s.last_used)])) : L('  (호출 기록 없음)', '  (no calls recorded)'));
  out.push('');
  out.push(L('   스킬 사용', '   Skill usage'));
  out.push(r.skill_usage.length ? table([L('스킬', 'Skill'), L('호출', 'Calls'), L('마지막 사용', 'Last used')],
    r.skill_usage.map((s) => [s.name, s.calls, dayOf(s.last_used)])) : L('  (호출 기록 없음)', '  (no calls recorded)'));
  out.push('');
  out.push(L('4. 끄기 후보 (켜져 있는데 최근 사용 0 — 이 도구는 아무것도 끄지 않아요)', '4. Candidates to turn off (enabled, zero use in window; this tool changes nothing)'));
  out.push(r.candidates.length ? table([L('종류', 'Kind'), L('이름', 'Name'), L('이유', 'Why'), L('끄는 법', 'How')],
    r.candidates.map((c) => [c.kind, c.name, (ko ? '최근 ' + r.days + '일 호출 0' : 'no calls in ' + r.days + 'd') + (c.tokens ? ` (~${c.tokens} tok)` : ''), c.how])) : L('  (후보 없음)', '  (none)'));
  out.push(L('  앱 관리 플러그인·커넥터·데스크탑 확장은: 앱 설정 -> 플러그인/커넥터/확장 에서 끄세요.', '  App-managed plugins, connectors and desktop extensions: turn off in app Settings -> Plugins/Connectors/Extensions.'));
  out.push(L('  훅만 있는 플러그인은 사용 횟수를 셀 수 없어 후보에서 뺐어요.', '  Hook-only plugins are excluded because their use cannot be counted.'));
  out.push('');
  out.push(L('주의: claude.ai 채팅·데스크탑 확장 사용은 이 기록에 안 남아요', 'Note: claude.ai chat and desktop-extension use is not recorded in these transcripts.'));
  return out.join('\n');
}

function parseArgs(argv) {
  const o = { cwd: process.cwd(), days: 30, json: false, details: true, cli: true, cache: true, homeDir: os.homedir(), projectsDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') o.cwd = argv[++i];
    else if (a === '--days') o.days = Math.max(1, parseInt(argv[++i], 10) || 30);
    else if (a === '--json') o.json = true;
    else if (a === '--no-details') o.details = false;
    else if (a === '--no-cli') o.cli = false;
    else if (a === '--no-cache') o.cache = false;
    else if (a === '--home') o.homeDir = argv[++i];
    else if (a === '--projects-dir') o.projectsDir = argv[++i];
  }
  return o;
}

module.exports = { runClaude, estimateTokens, encodeCwd, alwaysLoadedFiles, scanFile, scanUsage, classifyServer, buildReport, render, parseArgs, parseAlwaysOn, table };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const lang = require('./lang').withLang(pace.loadConfig(), {}).lang;
  buildReport(opts).then((r) => {
    process.stdout.write((opts.json ? JSON.stringify(r, null, 2) : render(r, lang)) + '\n');
  }).catch((e) => { process.stderr.write(String((e && e.stack) || e) + '\n'); process.exit(1); });
}
