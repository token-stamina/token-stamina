'use strict';
// Fleet observation: how many subagents run right now, and on which models. Read-only over
// ~/.claude/projects/<slug>/<session>/subagents/agent-<id>.meta.json (the platform writes them).
// The only thing we write is a tiny memo cache under the Token Stamina data folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pace = require('./pace');

const MAX_SCAN = 64;
const HEAD_BYTES = 65536;
const DEFAULTS = {
  fleet: true, fleetShowAt: 2, fleetStaleSec: 600, fleetScope: 'session', fleetCacheSec: 5,
  fleetWarnAt: 3, fleetHardAt: 5, fleetTotalWarnAt: 4, fleetTotalHardAt: 7,
  fleetSessions: true, fleetSessionActiveSec: 1800, fleetSessionsMax: 20, fleetSessionsCacheSec: 30,
  fleetSessionsCountHeadless: false, fleetSessionsCountExcluded: false,
};
// Counters of real I/O in scanSessions (tests read them; never persisted).
const io = { readdir: 0, stat: 0, head: 0 };

// Metadata of one subagent, or null when the text is not a usable meta object.
function parseMeta(text) {
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    return m;
  } catch (e) { return null; }
}

// 'finished' when the platform marked it; else 'stale' when its file has not moved for fleetStaleSec (crashed or
// cancelled without a mark); else 'running'.
function classify(meta, mtimeSec, nowSec, cfg) {
  if (meta && meta.finished === true) return 'finished';
  const lim = (cfg && typeof cfg.fleetStaleSec === 'number') ? cfg.fleetStaleSec : DEFAULTS.fleetStaleSec;
  if (typeof mtimeSec === 'number' && nowSec - mtimeSec > lim) return 'stale';
  return 'running';
}

// transcript .jsonl -> its subagents folder. Derived, never globbed. A subagent's own transcript
// (.../subagents/agent-x.jsonl, when it spawns more agents) maps to the parent session's folder.
function sessionDir(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const sub = transcriptPath.replace(/\\/g, '/').match(/^(.*\/subagents)\/agent-[^/]+\.jsonl$/);
  if (sub) return sub[1];
  return transcriptPath.replace(/\.jsonl$/, '') + '/subagents';
}

// 'claude-opus-4-7' -> 'O'; unknown/inherited -> '?'.
function modelLetter(model) {
  if (typeof model !== 'string' || !model) return '?';
  const m = model.toLowerCase();
  if (m.includes('fable')) return 'F';
  if (m.includes('opus')) return 'O';
  if (m.includes('sonnet')) return 'S';
  if (m.includes('haiku')) return 'H';
  return (m.match(/[a-z]/) || ['?'])[0].toUpperCase();
}

function emptySnap() {
  return { running: 0, finished: 0, stale: 0, total: 0, models: {}, items: [], truncated: false };
}

// Aggregate classified items ([{id, description, agentType, model, state, mtime, depth}]).
function snapshot(items, truncated) {
  const s = emptySnap();
  s.truncated = !!truncated;
  for (const it of items) {
    s.total++;
    s[it.state]++;
    if (it.state === 'running') {
      const k = modelLetter(it.model);
      s.models[k] = (s.models[k] || 0) + 1;
    }
    s.items.push(it);
  }
  return s;
}

// Newest-first meta files of one folder: [{dir, n, t}] where t = newest mtime of the meta and its sibling
// agent-<id>.jsonl (the conversation file keeps moving while the agent works; the meta may stay at creation time).
function listMetas(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /^agent-.+.meta.json$/.test(n)); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    try {
      let t = fs.statSync(path.join(dir, n)).mtimeMs / 1000;
      try { t = Math.max(t, fs.statSync(path.join(dir, n.replace(/.meta.json$/, '.jsonl'))).mtimeMs / 1000); } catch (e) { /* no transcript */ }
      out.push({ dir, n, t });
    } catch (e) { /* vanished */ }
  }
  return out;
}

// deadline = epoch ms after which a scan stops reading (W7 #12: the hook budget is a cap, not an after-the-fact check).
const late = (deadline) => typeof deadline === 'number' && Date.now() > deadline;

// Read a session's subagents folder plus workflows/<wf_*>/ one level down (readdir, never a glob). Newest 64 overall.
// Past the deadline it stops and returns {over: true} with whatever it has (callers drop that result).
function scanDir(dir, nowSec, cfg, deadline) {
  if (late(deadline)) return { items: [], truncated: false, over: true };
  let all = listMetas(dir);
  try {
    for (const e of fs.readdirSync(path.join(dir, 'workflows'), { withFileTypes: true })) {
      if (late(deadline)) return { items: [], truncated: false, over: true };
      if (e.isDirectory()) all = all.concat(listMetas(path.join(dir, 'workflows', e.name)));
    }
  } catch (e) { /* no workflows */ }
  all.sort((a, b) => b.t - a.t);
  const truncated = all.length > MAX_SCAN;
  const items = [];
  for (const { dir: d, n, t } of all.slice(0, MAX_SCAN)) {
    if (late(deadline)) return { items, truncated, over: true };
    let meta = null;
    try { meta = parseMeta(fs.readFileSync(path.join(d, n), 'utf8')); } catch (e) { /* skip */ }
    if (!meta) continue;
    items.push({
      id: n.replace(/^agent-/, '').replace(/.meta.json$/, ''),
      description: String(meta.description || '').slice(0, 80),
      agentType: meta.agentType || '',
      model: typeof meta.model === 'string' ? meta.model : null,
      depth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : null,
      requestShape: typeof meta.requestShape === 'string' ? meta.requestShape : null,
      nonInteractive: meta.requestNonInteractive === true,
      state: classify(meta, t, nowSec, cfg),
      mtime: t,
    });
  }
  return { items, truncated };
}

function scan(dir, nowSec, cfg, deadline) {
  if (!dir) return emptySnap();
  const r = scanDir(dir, nowSec, cfg, deadline);
  const s = snapshot(r.items, r.truncated);
  if (r.over) s.over_budget = true;
  return s;
}

// Every session folder of every project (CLI only). Same 64 cap on the merged, newest-first result.
function scanAll(nowSec, cfg, projectsDir) {
  const root = projectsDir || path.join(os.homedir(), '.claude', 'projects');
  let all = [];
  let truncated = false;
  let slugs = [];
  try { slugs = fs.readdirSync(root); } catch (e) { return emptySnap(); }
  for (const slug of slugs) {
    let sessions = [];
    try { sessions = fs.readdirSync(path.join(root, slug), { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (e) { continue; }
    for (const s of sessions) {
      const r = scanDir(path.join(root, slug, s.name, 'subagents'), nowSec, cfg);
      if (r.truncated) truncated = true;
      all = all.concat(r.items);
    }
  }
  all.sort((a, b) => b.mtime - a.mtime);
  if (all.length > MAX_SCAN) { all = all.slice(0, MAX_SCAN); truncated = true; }
  return snapshot(all, truncated);
}

// Status line ONLY: hooks must call scan() directly (no cache, so a just-finished agent is seen at once).
// Status line scan with a short memo (fleetCacheSec) so rapid renders do not re-read the folder.
function scanCached(dir, nowSec, cfg) {
  const ttl = (cfg && typeof cfg.fleetCacheSec === 'number') ? cfg.fleetCacheSec : DEFAULTS.fleetCacheSec;
  const file = path.join(pace.home(), 'fleet-cache.json');
  let book = {};
  if (ttl > 0) {
    book = pace.readJson(file, {}) || {};
    const hit = book[dir];
    if (hit && typeof hit.ts === 'number' && nowSec - hit.ts >= 0 && nowSec - hit.ts < ttl && hit.snap) return hit.snap;
  }
  const snap = scan(dir, nowSec, cfg);
  if (ttl > 0) {
    try {
      const keep = {};
      keep[dir] = { ts: nowSec, snap: Object.assign({}, snap, { items: [] }) };
      for (const k of Object.keys(book).filter((x) => x !== dir && x !== 'sessions').slice(0, 7)) keep[k] = book[k];
      if (book.sessions) keep.sessions = book.sessions; // the session-scan memo lives in the same file
      pace.writeJson(file, keep);
    } catch (e) { /* read-only home: skip memo */ }
  }
  return snap;
}

// Small, item-free view for hooks: {running, models, truncated}. Shape is fixed (decide() depends on it).
// Without sessionsSnap the shape is exactly the old one; with it a `sessions` count is added (null = scan failed).
function pressure(snap, sessionsSnap) {
  const s = snap || emptySnap();
  const p = { running: s.running || 0, models: Object.assign({}, s.models || {}), truncated: !!s.truncated };
  if (sessionsSnap !== undefined) p.sessions = (sessionsSnap && typeof sessionsSnap.sessions === 'number') ? sessionsSnap.sessions : null;
  return p;
}

// Warn (default) or 'hard' level: agents alone (fleetWarnAt/HardAt) or agents + sessions (fleetTotalWarnAt/HardAt).
// sessions missing/null -> agents only (identical to before).
function fleetPressure(fl, cfg, level) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const hard = level === 'hard';
  const one = hard ? c.fleetHardAt : c.fleetWarnAt;
  const tot = hard ? c.fleetTotalHardAt : c.fleetTotalWarnAt;
  const running = (fl && fl.running) || 0;
  if (running >= one) return true;
  return !!fl && typeof fl.sessions === 'number' && running + fl.sessions >= tot;
}

// ---- W4b-2: sessions (top-level ~/.claude/projects/<slug>/<id>.jsonl) consume the account limit too ----

// 'mybot_work' and 'C--Users-x-Temp-mybot-work' and a Windows cwd all become comparable.
function normalizeSlug(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '-');
}

// True when the slug or the cwd (both normalized) contains a normalized excludeCwd entry. Decided BEFORE any file read.
function excludedBySlug(slug, cwd, excludeCwd) {
  if (!Array.isArray(excludeCwd)) return false;
  const a = normalizeSlug(slug);
  const b = (cwd == null || cwd === '') ? null : normalizeSlug(cwd);
  for (const x of excludeCwd) {
    const n = normalizeSlug(x).replace(/^-+|-+$/g, '');
    if (!n) continue;
    if (a.includes(n) || (b && b.includes(n))) return true;
  }
  return false;
}

// Pure: head text -> {entrypoint, cwd}. Line by line (one record can be 14 KB+); when the read filled the whole
// buffer the last line may be cut, so it is dropped. Nothing found -> nulls (= unknown, never "interactive").
function parseHead(text, cut) {
  const lines = String(text || '').split('\n');
  if (cut) lines.pop();
  let entrypoint = null;
  let cwd = null;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let o;
    try { o = JSON.parse(ln); } catch (e) { continue; }
    if (!o || typeof o !== 'object') continue;
    if (cwd === null && typeof o.cwd === 'string') cwd = o.cwd;
    if (entrypoint === null && typeof o.entrypoint === 'string') entrypoint = o.entrypoint;
    if (entrypoint !== null && cwd !== null) break;
  }
  return { entrypoint, cwd };
}

function sameFile(a, b) {
  const n = (x) => String(x).replace(/\\/g, '/').toLowerCase();
  return n(a) === n(b);
}

// A subagent transcript means "we are inside session X": X's own jsonl is the self file.
function selfOf(p) {
  if (typeof p !== 'string' || !p) return null;
  const m = p.replace(/\\/g, '/').match(/^(.*)\/subagents\/agent-[^/]+\.jsonl$/);
  return m ? m[1] + '.jsonl' : p;
}

// Pure. info = {slug, path, entrypoint, cwd}; entrypoint null = head unreadable.
// Precedence: self > excluded folder > old > unknown > headless (sdk*) > interactive; each file lands in exactly one class.
function classifySession(info, mtime, now, selfPath, cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const i = info || {};
  if (selfPath && i.path && sameFile(i.path, selfOf(selfPath))) return 'self';
  if (excludedBySlug(i.slug, i.cwd, c.excludeCwd)) return 'excluded';
  if (typeof mtime === 'number' && now - mtime > c.fleetSessionActiveSec) return 'old';
  if (typeof i.entrypoint !== 'string' || !i.entrypoint) return 'unknown';
  if (/^sdk/i.test(i.entrypoint)) return 'headless';
  return 'interactive';
}

// Pure: [{slug,id,age,kind}] -> SessionsSnap. cfg flags decide whether headless/excluded also add to `sessions`.
function sessionsSnapshot(items, truncated, cfg, extraExcluded) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const s = { sessions: 0, headless: 0, excluded: extraExcluded || 0, unknown: 0, truncated: !!truncated, items: [] };
  for (const it of items) {
    if (it.kind === 'interactive') s.sessions++;
    else if (it.kind === 'headless') s.headless++;
    else if (it.kind === 'excluded') s.excluded++;
    else if (it.kind === 'unknown') s.unknown++;
    s.items.push(it);
  }
  if (c.fleetSessionsCountHeadless) s.sessions += s.headless;
  if (c.fleetSessionsCountExcluded) s.sessions += s.excluded;
  return s;
}

// First `bytes` of a file -> {text, cut}; null on any error.
function readHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    io.head++;
    return { text: buf.toString('utf8', 0, n), cut: n >= bytes };
  } catch (e) { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } } }
}

// Walk: slug readdir -> top-level *.jsonl only (subagents/ never entered) -> stat -> active (mtime within
// fleetSessionActiveSec) -> drop self and excluded folders WITHOUT reading -> newest fleetSessionsMax get a 64 KB head read.
// Any unexpected error -> null (callers treat that as "no session figure").
function scanSessions(projectsDir, selfTranscript, now, cfg, deadline) {
  try {
    if (late(deadline)) return null;
    const c = Object.assign({}, DEFAULTS, cfg || {});
    const root = projectsDir || path.join(os.homedir(), '.claude', 'projects');
    const self = selfOf(selfTranscript);
    let slugs;
    io.readdir++;
    try { slugs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { return null; }
    const cand = [];
    let excluded = 0;
    for (const slug of slugs) {
      if (late(deadline)) return null;
      let names;
      io.readdir++;
      try { names = fs.readdirSync(path.join(root, slug)).filter((n) => n.endsWith('.jsonl')); } catch (e) { continue; }
      for (const n of names) {
        const p = path.join(root, slug, n);
        let m;
        io.stat++;
        try { const st = fs.statSync(p); if (!st.isFile()) continue; m = st.mtimeMs / 1000; } catch (e) { continue; }
        if (now - m > c.fleetSessionActiveSec) continue;
        if (self && sameFile(p, self)) continue;
        if (excludedBySlug(slug, null, c.excludeCwd)) { excluded++; continue; }
        cand.push({ slug, id: n.replace(/\.jsonl$/, ''), path: p, mtime: m });
      }
    }
    cand.sort((a, b) => b.mtime - a.mtime);
    const truncated = cand.length > c.fleetSessionsMax;
    const items = [];
    for (const k of cand.slice(0, c.fleetSessionsMax)) {
      if (late(deadline)) return null;
      const h = readHead(k.path, HEAD_BYTES);
      const head = h ? parseHead(h.text, h.cut) : { entrypoint: null, cwd: null };
      const info = { slug: k.slug, path: k.path, entrypoint: head.entrypoint, cwd: head.cwd };
      items.push({ slug: k.slug, id: k.id, age: Math.max(0, Math.round(now - k.mtime)), kind: classifySession(info, k.mtime, now, null, c) });
    }
    return sessionsSnapshot(items, truncated, c, excluded);
  } catch (e) { return null; }
}

// 30 s memo under 'sessions' of fleet-cache.json (the status line memo keeps its own keys). Items are not cached.
// 'sessions' is a map key -> {ts, snap}, key = projectsDir|self, newest SESSIONS_MEMO_MAX kept: the count excludes the
// asking session, so one session's memo must never answer another (W7 #11). An old single-slot memo is ignored.
const SESSIONS_MEMO_MAX = 8;
function scanSessionsCached(projectsDir, selfTranscript, now, cfg, deadline) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const ttl = c.fleetSessionsCacheSec;
  const file = path.join(pace.home(), 'fleet-cache.json');
  const key = (projectsDir || '') + '|' + (selfOf(selfTranscript) || '');
  let book = {};
  let memo = {};
  if (ttl > 0) {
    book = pace.readJson(file, {}) || {};
    const m = book.sessions;
    memo = m && typeof m === 'object' && !Array.isArray(m) && !('key' in m) ? m : {};
    const hit = Object.prototype.hasOwnProperty.call(memo, key) ? memo[key] : null;
    if (hit && typeof hit.ts === 'number' && now - hit.ts >= 0 && now - hit.ts < ttl && hit.snap) return hit.snap;
  }
  const snap = scanSessions(projectsDir, selfTranscript, now, c, deadline);
  if (snap && ttl > 0) {
    try {
      const next = {};
      next[key] = { ts: now, snap: Object.assign({}, snap, { items: [] }) };
      for (const k of Object.keys(memo).filter((x) => x !== key && memo[x] && typeof memo[x].ts === 'number')
        .sort((a, b) => memo[b].ts - memo[a].ts).slice(0, SESSIONS_MEMO_MAX - 1)) next[k] = memo[k];
      book.sessions = next;
      pace.writeJson(file, book);
    } catch (e) { /* read-only home */ }
  }
  return snap;
}

function off(cfg) {
  return !cfg || cfg.fleet === false || cfg.fleetShowAt === 0;
}

// Status line token, e.g. '🤖3 (2S·1O)'. '' below fleetShowAt (default 2) or when switched off.
function segment(snap, cfg) {
  if (off(cfg) || !snap) return '';
  const at = (typeof cfg.fleetShowAt === 'number') ? cfg.fleetShowAt : DEFAULTS.fleetShowAt;
  if (!(snap.running >= at)) return '';
  const parts = Object.keys(snap.models).sort((a, b) => snap.models[b] - snap.models[a] || a.localeCompare(b))
    .map((k) => `${snap.models[k]}${k}`);
  return `🤖${snap.running} (${parts.join('·')})`;
}

const T = {
  en: { empty: 'No subagent records found.', head: ['State', 'Model', 'Type', 'Description'], run: 'running', fin: 'finished', stale: 'stale',
        sum: (s) => `${s.running} running · ${s.finished} finished · ${s.stale} stale`, trunc: 'Showing the newest 64 only.',
        sess: (s, m, d, all) => `sessions ${s.sessions} (interactive) · excluded ${s.excluded} · headless ${s.headless}${s.unknown ? ` · unknown ${s.unknown}` : ''}${s.truncated ? ' (partial)' : ''} · agents ${all ? 'total' : 'here'} ${m}${d ? ` (${d})` : ''}` },
  ko: { empty: '하위 에이전트 기록이 없어요.', head: ['상태', '모델', '종류', '설명'], run: '실행 중', fin: '끝남', stale: '멈춘 듯',
        sum: (s) => `실행 중 ${s.running} · 끝남 ${s.finished} · 멈춘 듯 ${s.stale}`, trunc: '최신 64개만 보여요.',
        sess: (s, m, d, all) => `세션 ${s.sessions}개(대화형) · 제외 ${s.excluded} · 헤드리스 ${s.headless}${s.unknown ? ` · 미확인 ${s.unknown}` : ''}${s.truncated ? ' (일부만)' : ''} · ${all ? '전체' : '이 세션'} 에이전트 ${m}개${d ? ` (${d})` : ''}` },
  ja: { empty: 'サブエージェントの記録がありません。', head: ['状態', 'モデル', '種類', '説明'], run: '実行中', fin: '完了', stale: '停止の疑い',
        sum: (s) => `実行中 ${s.running} · 完了 ${s.finished} · 停止の疑い ${s.stale}`, trunc: '最新64件のみ表示します。',
        sess: (s, m, d, all) => `セッション ${s.sessions}件(対話型) · 除外 ${s.excluded} · ヘッドレス ${s.headless}${s.unknown ? ` · 不明 ${s.unknown}` : ''}${s.truncated ? ' (一部のみ)' : ''} · ${all ? '全体' : 'このセッション'}のエージェント ${m}件${d ? ` (${d})` : ''}` },
};

// One header line about sessions (W4b-2). '' when ss is null/undefined.
function sessionsLine(ss, lang, snap, all) {
  if (!ss) return '';
  const t = T[lang] || T.en;
  const sn = snap || emptySnap();
  const dist = sn.running ? Object.keys(sn.models).sort((a, b) => sn.models[b] - sn.models[a] || a.localeCompare(b)).map((k) => sn.models[k] + k).join('·') : '';
  return t.sess(ss, sn.running || 0, dist, !!all);
}

function table(snap, lang, budgetLine, ss, all) {
  const t = T[lang] || T.en;
  const sl = sessionsLine(ss, lang, snap, all);
  const head = (budgetLine ? [budgetLine, ''] : []).concat(sl ? [sl, ''] : []);
  if (!snap || !snap.items || !snap.items.length) return head.concat(t.empty).join('\n');
  const esc = (x) => String(x || '').replace(/\|/g, '/').replace(/\s+/g, ' ');
  const lines = head.concat([t.sum(snap), '', `| ${t.head.join(' | ')} |`, `|${t.head.map(() => '---').join('|')}|`]);
  const rows = snap.items.slice().sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || b.mtime - a.mtime);
  for (const it of rows) {
    const label = t[it.state === 'finished' ? 'fin' : it.state === 'stale' ? 'stale' : 'run'];
    lines.push(`| ${label} | ${modelLetter(it.model)} | ${esc(it.agentType)} | ${esc(it.description)} |`);
  }
  if (snap.truncated) lines.push('', t.trunc);
  return lines.join('\n');
}

// cwd -> projects slug ("C:\Claude" -> "C--Claude"); newest .jsonl in it.
function latestTranscript(cwd, projectsDir) {
  const root = projectsDir || path.join(os.homedir(), '.claude', 'projects');
  const dir = path.join(root, String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
  let best = null;
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.jsonl')) continue;
      const t = fs.statSync(path.join(dir, n)).mtimeMs;
      if (!best || t > best.t) best = { t, p: path.join(dir, n) };
    }
  } catch (e) { /* none */ }
  return best && best.p;
}

function main(argv) {
  const o = { all: false, transcript: null, lang: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') o.all = true;
    else if (argv[i] === '--transcript') o.transcript = argv[++i];
    else if (argv[i] === '--lang') o.lang = argv[++i];
  }
  const cfg = Object.assign({}, DEFAULTS, pace.loadConfig());
  const lang = o.lang || require('./lang').withLang(cfg, {}).lang;
  const now = Math.floor(Date.now() / 1000);
  let snap;
  if (o.all || cfg.fleetScope === 'all') snap = scanAll(now, cfg);
  else {
    const tp = o.transcript || latestTranscript(process.cwd());
    snap = tp ? scan(sessionDir(tp), now, cfg) : emptySnap();
  }
  let budgetLine = null;
  try {
    // Same pace figures as the status line; input {} so no ctx/fleet token is repeated here.
    const sl = require('./statusline');
    budgetLine = sl.segment({}, pace.readState(), now, require('./lang').withLang(cfg, {})) || null;
  } catch (e) { /* the budget line is optional */ }
  let ss = null;
  if (cfg.fleetSessions !== false) ss = scanSessionsCached(null, o.transcript || latestTranscript(process.cwd()), now, cfg);
  return table(snap, lang, budgetLine, ss, o.all || cfg.fleetScope === 'all');
}

module.exports = {
  MAX_SCAN, DEFAULTS, parseMeta, classify, sessionDir, modelLetter, snapshot, scan, scanAll, scanCached, pressure, fleetPressure, segment, table, sessionsLine,
  HEAD_BYTES, io, normalizeSlug, excludedBySlug, parseHead, classifySession, sessionsSnapshot, readHead, scanSessions, scanSessionsCached,
  latestTranscript, main, SESSIONS_MEMO_MAX,
};

if (require.main === module) {
  try { process.stdout.write(main(process.argv.slice(2)) + '\n'); } catch (e) { process.stdout.write('fleet: ' + e.message + '\n'); }
}
