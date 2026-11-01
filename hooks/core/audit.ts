// Fixed-cost audit (no LLM), ported from scripts/audit.js: always-loaded files, plugins, MCP/skill
// usage from local transcripts, turn-off candidates. Never changes any setting.
//
// What differs from the Node script (a mod has no shell and reads files only through $.fs):
//   - no `claude plugin list/details` call: plugins come from settings + installed_plugins.json,
//     and the always-on token figure of each plugin stays unknown
//   - a file over 4 MiB cannot be read: transcripts are counted as skipped, and ~/.claude.json
//     (often that big) leaves its MCP servers out
import { estimateTokens, encodeCwd, joinPath } from './text.ts';
import { parentDir, walkJsonl, type CmdIO } from './cmd-io.ts';

const BUILTIN_SERVER = /^(ccd_|Claude_Browser$|terminal$|visualize$|scheduled-tasks$|computer-use$|mcp-registry$|remote-devices$)/;
const UUID_SERVER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AuditOpts {
  cwd: string;
  days: number;
  json: boolean;
  cache: boolean;
  homeDir: string; // the user's home (~/.claude.json lives here)
  claudeDir: string; // ~/.claude
  projectsDir: string | null;
  dataDir: string; // the Token Stamina data folder (audit-cache.json)
  settings: any; // merged settings, as $.settings.read() returns them
}

export function parseArgs(argv: string[], base: Omit<AuditOpts, 'days' | 'json' | 'cache'> & { cwd: string }): AuditOpts {
  const o: AuditOpts = { ...base, days: 30, json: false, cache: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') o.cwd = String(argv[++i] || o.cwd);
    else if (a === '--days') o.days = Math.max(1, parseInt(argv[++i] || '', 10) || 30);
    else if (a === '--json') o.json = true;
    else if (a === '--no-cache') o.cache = false;
    else if (a === '--home') o.homeDir = String(argv[++i] || o.homeDir);
    else if (a === '--projects-dir') o.projectsDir = String(argv[++i] || '') || null;
    // --no-details and --no-cli are accepted and ignored: this build never runs the CLI.
  }
  return o;
}

async function readJson(io: CmdIO, p: string): Promise<any | null> {
  const t = await io.read(p);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

export interface AlwaysFile { path: string; chars: number; tokens_est: number }

export async function alwaysLoadedFiles(io: CmdIO, cwd: string, claudeDir: string): Promise<AlwaysFile[]> {
  const cands = [joinPath(claudeDir, 'CLAUDE.md')];
  let dir = cwd;
  for (let guard = 0; guard < 64; guard++) {
    cands.push(joinPath(dir, 'CLAUDE.md'), joinPath(dir, 'CLAUDE.local.md'), joinPath(dir, '.claude', 'CLAUDE.md'));
    const up = parentDir(dir);
    if (up === dir) break;
    dir = up;
  }
  cands.push(joinPath(claudeDir, 'projects', encodeCwd(cwd), 'memory', 'MEMORY.md'));
  const seen = new Set<string>();
  const out: AlwaysFile[] = [];
  for (const p of cands) {
    const t = await io.read(p);
    if (t === null) continue;
    const key = (await io.realKey(p)).toLowerCase().replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: p, chars: [...t].length, tokens_est: estimateTokens(t) });
  }
  return out;
}

export interface PluginRow { id: string; name: string; version: string | null; enabled: boolean; hooks: boolean; mcp_servers: string[]; always_on_tokens: number | null; calls?: number; last_used?: string | null }

async function pluginHasHooks(io: CmdIO, installPath: string | undefined): Promise<boolean> {
  if (!installPath) return false;
  if (await io.exists(joinPath(installPath, 'hooks', 'hooks.json'))) return true;
  const pj = await readJson(io, joinPath(installPath, '.claude-plugin', 'plugin.json'));
  return !!(pj && pj.hooks);
}

export async function listPlugins(io: CmdIO, claudeDir: string, settings: any): Promise<{ source: string; plugins: PluginRow[] }> {
  const inst = (await readJson(io, joinPath(claudeDir, 'plugins', 'installed_plugins.json'))) || {};
  const enabled = (settings && settings.enabledPlugins) || {};
  const plugins: PluginRow[] = [];
  for (const [id, arr] of Object.entries<any>(inst.plugins || {})) {
    const e = Array.isArray(arr) ? arr[0] : arr;
    plugins.push({
      id, name: String(id).split('@')[0] as string, version: (e && e.version) || null, enabled: enabled[id] !== false,
      hooks: await pluginHasHooks(io, e && e.installPath), mcp_servers: [], always_on_tokens: null,
    });
  }
  return { source: 'settings.json + installed_plugins.json', plugins };
}

export async function configuredMcp(io: CmdIO, cwd: string, homeDir: string): Promise<{ name: string; origin: string }[]> {
  const out: { name: string; origin: string }[] = [];
  const cj = (await readJson(io, joinPath(homeDir, '.claude.json'))) || {};
  for (const n of Object.keys(cj.mcpServers || {})) out.push({ name: n, origin: 'user (~/.claude.json)' });
  const proj = (cj.projects || {})[cwd] || (cj.projects || {})[cwd.replace(/\\/g, '/')];
  if (proj) for (const n of Object.keys(proj.mcpServers || {})) out.push({ name: n, origin: 'project (~/.claude.json)' });
  let dir = cwd;
  for (let guard = 0; guard < 64; guard++) {
    const f = joinPath(dir, '.mcp.json');
    const mj = await readJson(io, f);
    if (mj && mj.mcpServers) for (const n of Object.keys(mj.mcpServers)) out.push({ name: n, origin: 'project (' + f + ')' });
    const up = parentDir(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

// ---------- usage scan ----------
interface FileScan { servers: Record<string, Record<string, number>>; skills: Record<string, Record<string, number>>; last: Record<string, string> }

// Per-file extraction: { servers: {name: {day: n}}, skills: {name: {day: n}}, last: {key: iso} }.
export function scanText(text: string): FileScan {
  const res: FileScan = { servers: {}, skills: {}, last: {} };
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.indexOf('"tool_use"') < 0) continue;
    if (line.indexOf('"name":"mcp__') < 0 && line.indexOf('"name":"Skill"') < 0) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
    const ts = typeof o.timestamp === 'string' ? o.timestamp : '';
    const day = ts.slice(0, 10) || 'unknown';
    for (const c of o.message.content) {
      if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
      if (c.id) { if (seen.has(c.id)) continue; seen.add(c.id); }
      let bucket: Record<string, Record<string, number>>;
      let key: string | undefined;
      if (c.name.startsWith('mcp__')) { bucket = res.servers; key = c.name.split('__')[1]; }
      else if (c.name === 'Skill' && c.input && typeof c.input.skill === 'string') { bucket = res.skills; key = c.input.skill; }
      else continue;
      if (!key) continue;
      const b = bucket[key] || (bucket[key] = {});
      b[day] = (b[day] || 0) + 1;
      const lk = (bucket === res.servers ? 's:' : 'k:') + key;
      if (ts && (!res.last[lk] || ts > res.last[lk]!)) res.last[lk] = ts;
    }
  }
  return res;
}

interface CacheEnt extends FileScan { mtimeMs: number; size: number }

export interface Usage { servers: Record<string, number>; skills: Record<string, number>; last: Record<string, string>; stats: { files_considered: number; files_scanned: number; files_cached: number; files_skipped: number } }

export async function scanUsage(io: CmdIO, projectsDir: string, days: number, dataDir: string, useCache: boolean): Promise<Usage> {
  const cutoffMs = Date.now() - days * 86400000;
  const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
  const cacheFile = joinPath(dataDir, 'audit-cache.json');
  let cache: { v: number; files: Record<string, CacheEnt> } = { v: 1, files: {} };
  if (useCache) {
    const c = await readJson(io, cacheFile);
    if (c && typeof c === 'object' && c.files && typeof c.files === 'object') cache = c;
  }
  const files = cache.files;
  const alive = new Set<string>();
  let scanned = 0, cached = 0, considered = 0, skipped = 0;
  const servers: Record<string, number> = {}, skills: Record<string, number> = {}, last: Record<string, string> = {};
  for (const f of await walkJsonl(io, projectsDir)) {
    if (f.mtimeMs < cutoffMs) continue;
    considered++;
    alive.add(f.path);
    let ent = files[f.path];
    if (ent && ent.mtimeMs === f.mtimeMs && ent.size === f.size) cached++;
    else {
      const t = await io.read(f.path);
      if (t == null) { skipped++; continue; }
      ent = Object.assign({ mtimeMs: f.mtimeMs, size: f.size }, scanText(t));
      files[f.path] = ent;
      scanned++;
    }
    for (const [src, dst] of [[ent.servers, servers], [ent.skills, skills]] as [Record<string, Record<string, number>>, Record<string, number>][]) {
      for (const [k, byDay] of Object.entries(src)) {
        for (const [d, n] of Object.entries(byDay)) {
          if (d < cutoffDay) continue;
          dst[k] = (dst[k] || 0) + n;
        }
      }
    }
    for (const [lk, ts] of Object.entries(ent.last)) if (ts.slice(0, 10) >= cutoffDay && (!last[lk] || ts > last[lk]!)) last[lk] = ts;
  }
  if (useCache) {
    for (const p of Object.keys(files)) if (!alive.has(p)) delete files[p];
    try { await io.write(cacheFile, JSON.stringify(cache)); } catch { /* ignore */ }
  }
  return { servers, skills, last, stats: { files_considered: considered, files_scanned: scanned, files_cached: cached, files_skipped: skipped } };
}

// ---------- classification + recommendations ----------
export function classifyServer(name: string, pluginNames: string[]): string {
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

function pluginUsage(plugin: PluginRow, usage: Usage): { calls: number; last: string | null } {
  let calls = 0;
  let last: string | null = null;
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

export interface AuditReport {
  generated: string; cwd: string; days: number;
  always_loaded: { files: AlwaysFile[]; total_tokens_est: number; note: string };
  plugins_source: string; plugins: PluginRow[]; app_managed_plugins_seen: string[];
  mcp_usage: { name: string; kind: string; calls: number; last_used: string | null }[];
  skill_usage: { name: string; calls: number; last_used: string | null }[];
  candidates: { kind: string; name: string; origin?: string; why: string; how: string; tokens: number | null }[];
  scan: Usage['stats'];
  claude_json_unreadable: boolean;
  // true when a transcript was skipped (over 4 MiB): a candidate's "0 calls" may be wrong
  candidates_uncertain: boolean;
}

export async function buildReport(io: CmdIO, opts: AuditOpts): Promise<AuditReport> {
  const files = await alwaysLoadedFiles(io, opts.cwd, opts.claudeDir);
  const pl = await listPlugins(io, opts.claudeDir, opts.settings);
  const usage = await scanUsage(io, opts.projectsDir || joinPath(opts.claudeDir, 'projects'), opts.days, opts.dataDir, opts.cache);
  const pluginNames = pl.plugins.map((p) => p.name);

  const plugins = pl.plugins.map((p) => {
    const u = pluginUsage(p, usage);
    return Object.assign(p, { calls: u.calls, last_used: u.last });
  });
  const servers = Object.keys(usage.servers).map((n) => ({ name: n, kind: classifyServer(n, pluginNames), calls: usage.servers[n] as number, last_used: usage.last['s:' + n] || null }))
    .sort((a, b) => b.calls - a.calls);
  const skills = Object.keys(usage.skills).map((n) => ({ name: n, calls: usage.skills[n] as number, last_used: usage.last['k:' + n] || null }))
    .sort((a, b) => b.calls - a.calls);

  // Plugins seen in usage but absent from the config files: app-managed, cost unknown.
  const appPlugins = new Set<string>();
  for (const s of servers) if (s.kind === 'app_plugin') appPlugins.add(s.name.slice(7).split('_')[0] as string);
  for (const s of skills) {
    const i = s.name.indexOf(':');
    if (i > 0 && !pluginNames.includes(s.name.slice(0, i)) && !s.name.startsWith('anthropic-skills')) appPlugins.add(s.name.slice(0, i));
  }

  const candidates: AuditReport['candidates'] = [];
  for (const p of plugins) {
    if (!p.enabled) continue;
    if ((p.calls || 0) > 0) continue;
    if (p.hooks) continue; // hook-only behaviour cannot be counted from transcripts
    candidates.push({ kind: 'plugin', name: p.id, why: 'no skill/MCP calls in window', how: 'claude plugin disable ' + p.id, tokens: p.always_on_tokens });
  }
  const cfgMcp = await configuredMcp(io, opts.cwd, opts.homeDir);
  const claudeJsonUnreadable = await claudeJsonTooBig(io, opts.homeDir);
  const seenMcp = new Set<string>();
  for (const m of cfgMcp) {
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
    claude_json_unreadable: claudeJsonUnreadable,
    candidates_uncertain: usage.stats.files_skipped > 0,
  };
}

// ~/.claude.json exists but could not be read (the adapter counted it as skipped).
async function claudeJsonTooBig(io: CmdIO, homeDir: string): Promise<boolean> {
  const f = joinPath(homeDir, '.claude.json');
  if (!(await io.exists(f))) return false;
  const t = await io.read(f);
  return t == null;
}

// ---------- text output ----------
function width(s: unknown): number { let w = 0; for (const ch of String(s)) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1; return w; }
function pad(s: unknown, w: number): string { const t = String(s); return t + ' '.repeat(Math.max(0, w - width(t))); }
export function table(headers: string[], rows: unknown[][]): string {
  const ws = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (r: unknown[]) => r.map((c, i) => pad(c, ws[i] as number)).join('  ').replace(/\s+$/, '');
  return [line(headers), ws.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}
const dayOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '-');
const kindLabel = (k: string, ko: boolean) => {
  if (k === 'builtin') return ko ? '내장(끌 수 없음)' : 'built-in (cannot disable)';
  if (k === 'connector') return ko ? '커넥터(앱 관리)' : 'connector (app-managed)';
  if (k === 'extension') return ko ? '브라우저 확장(앱 관리)' : 'browser extension (app-managed)';
  if (k === 'app_plugin') return ko ? '앱 관리 플러그인' : 'app-managed plugin';
  if (k.startsWith('plugin:')) return ko ? '플러그인 ' + k.slice(7) : 'plugin ' + k.slice(7);
  return ko ? '기타/사용자 설정' : 'other/user config';
};

export function render(r: AuditReport, lang: string): string {
  const ko = lang === 'ko';
  const L = (a: string, b: string) => (ko ? a : b);
  const out: string[] = [];
  out.push(L(`Token Stamina 고정 비용 감사 (최근 ${r.days}일, cwd ${r.cwd})`, `Token Stamina fixed-cost audit (last ${r.days} days, cwd ${r.cwd})`));
  out.push('');
  out.push(L('1. 매 세션 항상 실리는 파일 (토큰은 추정값)', '1. Always-loaded files (tokens are estimates)'));
  out.push(table([L('파일', 'File'), L('글자', 'Chars'), L('추정 토큰', 'Est. tokens')],
    r.always_loaded.files.map((f) => [f.path, f.chars, '~' + f.tokens_est]).concat([[L('합계', 'Total'), '' as any, '~' + r.always_loaded.total_tokens_est]])));
  out.push(L('  추정식: ASCII 글자/4 + 비ASCII 글자/1.5 (실제 토큰과 다를 수 있어요)', '  Formula: ASCII chars/4 + non-ASCII chars/1.5 (may differ from real tokens)'));
  out.push('');
  out.push(L(`2. 플러그인 (출처: ${r.plugins_source})`, `2. Plugins (source: ${r.plugins_source})`));
  if (r.plugins.length) {
    out.push(table([L('플러그인', 'Plugin'), L('켜짐', 'On'), L('항상 실리는 토큰', 'Always-on tok'), L('훅', 'Hooks'), L('호출', 'Calls'), L('마지막 사용', 'Last used')],
      r.plugins.map((p) => [p.id + (p.version ? ' ' + p.version : ''), p.enabled ? 'yes' : 'no',
        p.always_on_tokens == null ? L('알 수 없음', 'unknown') : '~' + p.always_on_tokens, p.hooks ? 'yes' : '-', p.calls ?? 0, dayOf(p.last_used)])));
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
  if (r.candidates_uncertain) {
    out.push(L(`  주의: 4 MiB 를 넘어 읽지 못한 기록 ${r.scan.files_skipped}개가 있어 "호출 0" 이 틀릴 수 있어요. 아래 후보는 확정이 아니니 끄기 전에 직접 확인하세요.`,
      `  Warning: ${r.scan.files_skipped} large transcript(s) were not read, so "0 calls" may be wrong. These candidates are not confirmed: check before turning anything off.`));
  }
  out.push(L('  앱 관리 플러그인·커넥터·데스크탑 확장은: 앱 설정 -> 플러그인/커넥터/확장 에서 끄세요.', '  App-managed plugins, connectors and desktop extensions: turn off in app Settings -> Plugins/Connectors/Extensions.'));
  out.push(L('  훅만 있는 플러그인은 사용 횟수를 셀 수 없어 후보에서 뺐어요.', '  Hook-only plugins are excluded because their use cannot be counted.'));
  out.push('');
  out.push(L('주의: claude.ai 채팅·데스크탑 확장 사용은 이 기록에 안 남아요', 'Note: claude.ai chat and desktop-extension use is not recorded in these transcripts.'));
  const m: string[] = [L('mod 판 차이: 플러그인별 항상 실리는 토큰은 재지 않아요(CLI 호출 없음).', 'Mod build: always-on tokens per plugin are not measured (no CLI call).')];
  if (r.scan.files_skipped) m.push(L(`4 MiB 를 넘어 읽지 못한 기록 ${r.scan.files_skipped}개는 건너뛰었어요.`, `${r.scan.files_skipped} transcript(s) over 4 MiB were skipped.`));
  if (r.claude_json_unreadable) m.push(L('~/.claude.json 이 4 MiB 를 넘어 읽지 못했어요: 거기 등록한 MCP 서버는 후보에서 빠졌어요.', '~/.claude.json is over 4 MiB and was not read: MCP servers configured there are not listed as candidates.'));
  out.push(m.join(' '));
  return out.join('\n');
}
