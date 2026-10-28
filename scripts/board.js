'use strict';
// W9-1a layer 0: per-session efficiency row (DESIGN-v2-integrated.md 10.2, E1-E5). UserPromptSubmit / Stop hook.
// Reads this session's own transcript tail (read-only), writes ONE small json row under <home>/board/<sid>.json.
// No LLM, no extrapolation: every number is measured from the tail. Never throws from the hook, always exits 0.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pace = require('./pace');
const boundary = require('./boundary');
const fleet = require('./fleet');
const D = require('./decisions');

const DEFAULTS = {
  board: true, boardTailBytes: 262144, boardKeepSec: 86400, boardIdleSec: 1800, dashboardMaskTitles: false,
  managerExcludeCwd: [], managerProtectKeywords: D.PROTECT_KEYWORDS_DEFAULT.slice(), managerProtectSegments: D.PROTECT_SEGMENTS.slice(),
  gateAtTokens: 200000, newSessionAtTokens: 400000,
};
const CACHE_TTL_SEC = 300; // prompt cache lifetime: a longer gap before a turn means a cache miss is expected
const WINDOW = 10;
const SPARK = 20;
const JA_KEYWORDS = ['設計', 'アーキテクチャ', 'レビュー', '監査', '戦略', '判断', '決定'];
const ROW_KEYS = ['sid', 'cwd_tail', 'model', 'entrypoint', 'protected', 'last_user_ts', 'last_ts', 'in_last', 'in_med10', 'in_trend',
  'spark', 'hit', 'hit_active', 'miss_after_idle', 'j', 'fit', 'estimated', 'ctx_tokens', 'clear_candidate', 'idle_sec', 'agents_running',
  'agents_upper', 'agent_tokens_done', 'agent_tokens_live', 'agent_share', 'sample_turns', 'updated_at'];
const SID_RE = /^[A-Za-z0-9_-]{1,80}$/;

const cfgOf = (cfg) => Object.assign({}, DEFAULTS, cfg || {});
const isNum = (x) => typeof x === 'number' && isFinite(x);
const tsOf = (o) => { const t = Date.parse(o && o.timestamp); return isFinite(t) ? Math.floor(t / 1000) : null; };
const inTokens = (u) => (u.input || 0) + (u.cache_read || 0) + (u.cache_creation || 0);

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Last `bytes` of a file as text (partial first line dropped when the read started mid-file). One read, never the whole file.
function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } finally { fs.closeSync(fd); }
}

function parseLines(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch (e) { /* partial or foreign line */ }
  }
  return out;
}

function promptText(o) {
  const c = o.message.content;
  if (typeof c === 'string') return c;
  return c.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n');
}

// Tail text -> turns, in file order: assistant {ts, role:'assistant', model, usage:{input,cache_read,cache_creation,output}},
// real user prompt {ts, role:'user', text}, task-notification {ts, role:'notification', is_task_notification:true, id, total_tokens?}.
// Assistant records are de-duplicated by message.id (the last record of a message carries the final usage).
// total_tokens comes from attachment.usage.totalTokens (measured on this PC), else the notification text's <subagent_tokens>; absent -> undefined.
function turnsFromTail(tailText) {
  const turns = [];
  const byMsg = new Map();
  for (const o of parseLines(tailText)) {
    if (!o || typeof o !== 'object') continue;
    const ts = tsOf(o);
    if (o.type === 'assistant' && !o.isSidechain && o.message && o.message.usage && o.message.model !== '<synthetic>') {
      const u = o.message.usage;
      const t = { ts, role: 'assistant', model: typeof o.message.model === 'string' ? o.message.model : null,
        usage: { input: u.input_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_creation: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 },
        is_task_notification: false };
      const id = o.message.id;
      if (id && byMsg.has(id)) Object.assign(byMsg.get(id), t); else { turns.push(t); if (id) byMsg.set(id, t); }
    } else if (o.type === 'user' && boundary.isRealPrompt(o)) {
      const text = promptText(o);
      if (/^\s*<task-notification>/.test(text)) { turns.push(notification(ts, text, null)); continue; }
      turns.push({ ts, role: 'user', text, is_task_notification: false });
    } else if (o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command' && typeof o.attachment.prompt === 'string'
      && (o.attachment.commandMode === 'task-notification' || /<task-notification>/.test(o.attachment.prompt))) {
      const tt = o.attachment.usage && o.attachment.usage.totalTokens;
      turns.push(notification(ts, o.attachment.prompt, isNum(tt) ? tt : null));
    }
  }
  return turns;
}

function notification(ts, text, fromField) {
  const id = (/<task-id>([^<]+)<\/task-id>/.exec(text) || [])[1] || null;
  let total = fromField;
  if (total === null) {
    const m = /<(?:subagent_tokens|total_tokens)>(\d+)</.exec(text);
    if (m) total = Number(m[1]);
  }
  const t = { ts, role: 'notification', is_task_notification: true, id };
  if (isNum(total)) t.total_tokens = total;
  return t;
}

function tierOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus') || m.includes('fable')) return 'upper';
  if (m.includes('sonnet') || m.includes('haiku')) return 'lower';
  return null;
}

function keywordCount(prompts, cfg) {
  const kws = (Array.isArray(cfg.judgmentKeywords) ? cfg.judgmentKeywords : []).concat(JA_KEYWORDS)
    .map((k) => String(k).toLowerCase()).filter(Boolean);
  let j = 0;
  for (const p of prompts) {
    const low = String(p).toLowerCase();
    for (const k of kws) if (low.includes(k)) j++;
  }
  return j;
}

// Pure. turns = turnsFromTail(); prompts = optional override (array of strings); now = epoch seconds.
function metrics(turns, prompts, now, cfg) {
  const c = cfgOf(cfg);
  const A = turns.filter((t) => t.role === 'assistant');
  const users = turns.filter((t) => t.role === 'user');
  const ps = Array.isArray(prompts) ? prompts : users.map((t) => t.text);
  const ins = A.map((t) => inTokens(t.usage));
  const last10 = A.slice(-WINDOW);
  const ins10 = ins.slice(-WINDOW);
  const prev10 = ins.slice(-2 * WINDOW, -WINDOW);
  const med10 = median(ins10);
  const medPrev = median(prev10);
  // E2: a turn whose previous assistant turn is more than 5 minutes older is an expected cache miss.
  const total10 = ins10.reduce((a, b) => a + b, 0);
  let missN = 0, readAll = 0, readActive = 0, totActive = 0;
  last10.forEach((t, i) => {
    const gi = A.length - last10.length + i;
    const prev = gi > 0 ? A[gi - 1] : null;
    const idleMiss = !!(prev && isNum(prev.ts) && isNum(t.ts) && t.ts - prev.ts > CACHE_TTL_SEC);
    readAll += t.usage.cache_read;
    if (idleMiss) missN++; else { readActive += t.usage.cache_read; totActive += inTokens(t.usage); }
  });
  const lastA = A[A.length - 1] || null;
  const lastUser = users[users.length - 1] || null;
  const model = lastA ? lastA.model : null;
  const j = keywordCount(ps.slice(-WINDOW), c);
  const tier = tierOf(model);
  let fit = null;
  if (lastA) fit = (tier === 'upper' && j === 0) ? 'lower_candidate' : (tier === 'lower' && j >= 3) ? 'judgment_on_lower' : 'fit';
  const ctx = lastA ? ins[ins.length - 1] : null;
  const lastUserTs = lastUser && isNum(lastUser.ts) ? lastUser.ts : null;
  const idle = lastUserTs !== null && isNum(now) ? Math.max(0, now - lastUserTs) : null;
  const gate = isNum(c.gateAtTokens) ? c.gateAtTokens : DEFAULTS.gateAtTokens;
  const idleSec = isNum(c.boardIdleSec) ? c.boardIdleSec : DEFAULTS.boardIdleSec;
  const done = new Set();
  // E5 unit (W7): a notification's totalTokens is the agent's LAST turn, not its total, so it is never summed here.
  // Finished agents are counted from their own transcript (agent_done_ids -> caller), in the same unit as the main
  // side: per turn input + cache_read + cache_creation + output, summed over the turns read.
  for (const t of turns) if (t.is_task_notification && t.id && /^[A-Za-z0-9_-]+$/.test(String(t.id))) done.add(t.id);
  return {
    in_last: ins.length ? ins[ins.length - 1] : null,
    in_med10: med10,
    in_trend: med10 !== null && medPrev !== null ? med10 - medPrev : null,
    spark: ins.slice(-SPARK),
    hit: total10 > 0 ? readAll / total10 : null,
    hit_active: totActive > 0 ? readActive / totActive : null,
    miss_after_idle: missN,
    j, fit, estimated: true,
    ctx_tokens: ctx,
    clear_candidate: idle !== null && ctx !== null ? (idle >= idleSec && ctx >= gate) : false,
    idle_sec: idle,
    main_tokens_sum: A.reduce((a, t) => a + inTokens(t.usage) + (t.usage.output || 0), 0),
    agent_done_ids: [...done].slice(-32),
    sample_turns: A.length,
    model,
    last_user_ts: lastUserTs,
    last_ts: lastA && isNum(lastA.ts) ? lastA.ts : null,
  };
}

// One protection function shared with decisions.js (folders named in managerProtectSegments, bot folders, keywords).
function isProtected(cwd, cfg) {
  return D.textProtected(cwd, cfgOf(cfg));
}

// Pure. input = {sid, cwd, entrypoint}; fleetSnap = fleet snapshot, optionally with .liveTokens / .doneTokens (number|null,
// cumulative input+cache+output of running / finished agents' own transcripts) added by the caller.
// Whitelist: no prompt text, no full path, no transcript path.
function row(input, m, fleetSnap, now, cfg) {
  const snap = fleetSnap || {};
  const running = snap.running || 0;
  const live = isNum(snap.liveTokens) ? snap.liveTokens : null;
  const done = isNum(snap.doneTokens) ? snap.doneTokens : null;
  const agentTok = (done || 0) + (live || 0);
  const known = done !== null || live !== null;
  const cwd = String((input && input.cwd) || '');
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const upper = (snap.items || []).filter((it) => it.state === 'running' && tierOf(it.model) === 'upper').length;
  return {
    sid: input.sid,
    cwd_tail: parts.length ? parts[parts.length - 1] : '',
    model: m.model,
    entrypoint: (input && input.entrypoint) || null,
    protected: isProtected(cwd, cfg),
    last_user_ts: m.last_user_ts,
    last_ts: m.last_ts,
    in_last: m.in_last, in_med10: m.in_med10, in_trend: m.in_trend, spark: m.spark,
    hit: m.hit, hit_active: m.hit_active, miss_after_idle: m.miss_after_idle,
    j: m.j, fit: m.fit, estimated: true,
    ctx_tokens: m.ctx_tokens, clear_candidate: m.clear_candidate, idle_sec: m.idle_sec,
    agents_running: running, agents_upper: upper,
    agent_tokens_done: done, agent_tokens_live: live,
    agent_share: known && agentTok + m.main_tokens_sum > 0 ? agentTok / (agentTok + m.main_tokens_sum) : null,
    sample_turns: m.sample_turns,
    updated_at: new Date(now * 1000).toISOString(),
  };
}

const S = {
  ko: {
    red: (r) => (r.fit === 'lower_candidate' ? '예산이 빨강이에요. 이 세션을 먼저 Sonnet 으로 낮춰요(앱 모델 메뉴).' : '예산이 빨강이에요. 큰 작업은 리셋 뒤로 미루거나 하위 모델로 돌려요.'),
    stale: '한도 값이 오래됐어요. 아무 세션에서나 한 턴 쓰면 동기화 안내가 떠요.',
    clear: '비우기 후보예요. 인계 메모를 저장하고 /clear 해요.',
    lower: '이 세션은 Sonnet 으로 낮춰도 돼요(앱 모델 메뉴).',
    judg: '판단 작업이 많아요. 판단 단계만 Opus 하위 에이전트로 돌려요.',
    hit: '매 턴 큰 파일을 다시 읽는지 확인해요(큰 읽기는 하위 에이전트로).',
    idle: '유휴 뒤 캐시 미스가 많아요. 5분 안에 이어 쓰거나 끝내요.',
    newS: '새 세션을 권장해요(인계 메모 준비).',
    gate: '주제가 바뀌면 비워요.',
    agent: '하위 에이전트 기본 모델을 Sonnet 으로 낮춰요(agentModelDefault).',
    bigread: '큰 읽기를 하위 에이전트로 넘겨요.',
  },
  en: {
    red: (r) => (r.fit === 'lower_candidate' ? 'Budget is red. Lower this session to Sonnet first (app model menu).' : 'Budget is red. Defer big tasks past the reset or run them on a lower model.'),
    stale: 'Usage value is stale. Take one turn in any session; the sync hint will appear.',
    clear: 'Clear candidate. Save a handoff note, then /clear.',
    lower: 'This session can run on Sonnet (app model menu).',
    judg: 'Many judgment tasks on a lower model. Run only the judgment step as an Opus subagent.',
    hit: 'Check whether a big file is re-read every turn (move big reads to a subagent).',
    idle: 'Many cache misses after idle. Continue within 5 minutes or finish.',
    newS: 'A new session is recommended (handoff note ready).',
    gate: 'Clear when the topic changes.',
    agent: 'Lower the default subagent model to Sonnet (agentModelDefault).',
    bigread: 'Hand big reads to a subagent.',
  },
  ja: {
    red: (r) => (r.fit === 'lower_candidate' ? '予算が赤です。このセッションを先に Sonnet へ下げます(アプリのモデルメニュー)。' : '予算が赤です。大きな作業はリセット後に回すか下位モデルで実行します。'),
    stale: '使用量の値が古いです。どのセッションでも 1 ターン使うと同期の案内が出ます。',
    clear: 'クリア候補です。引き継ぎメモを保存して /clear します。',
    lower: 'このセッションは Sonnet で十分です(アプリのモデルメニュー)。',
    judg: '判断作業が多いです。判断の段階だけ Opus のサブエージェントで実行します。',
    hit: '毎ターン大きなファイルを読み直していないか確認します(大きな読み取りはサブエージェントへ)。',
    idle: '待機後のキャッシュミスが多いです。5 分以内に続けるか終えます。',
    newS: '新しいセッションを推奨します(引き継ぎメモ準備)。',
    gate: '話題が変わったらクリアします。',
    agent: 'サブエージェントの既定モデルを Sonnet に下げます(agentModelDefault)。',
    bigread: '大きな読み取りはサブエージェントへ回します。',
  },
};

// Pure. At most one line, priority E6 > E4 > E3 > E2 > E1 > E5; null when everything is normal.
// account = {grade:'green'|'yellow'|'red'|null, stale:boolean}; the lang comes from cfg.lang (ko/en/ja, else en).
function suggest(r, account, cfg) {
  const c = cfgOf(cfg);
  const t = S[c.lang] || S.en;
  const a = account || {};
  if (a.grade === 'red') return t.red(r);
  if (a.stale) return t.stale;
  if (r.clear_candidate) return t.clear;
  if (r.fit === 'lower_candidate') return t.lower;
  if (r.fit === 'judgment_on_lower') return t.judg;
  if (r.sample_turns >= 3 && isNum(r.hit_active) && r.hit_active < 0.6) return t.hit;
  if (r.sample_turns >= 3 && isNum(r.hit) && r.hit < 0.6 && r.miss_after_idle >= 3) return t.idle;
  const newAt = isNum(c.newSessionAtTokens) ? c.newSessionAtTokens : DEFAULTS.newSessionAtTokens;
  const gateAt = isNum(c.gateAtTokens) ? c.gateAtTokens : DEFAULTS.gateAtTokens;
  if (isNum(r.in_med10) && r.in_med10 >= newAt) return t.newS;
  if (isNum(r.in_med10) && r.in_med10 >= gateAt) return t.gate;
  if (isNum(r.agent_share) && r.agent_share > 0.7 && r.agents_upper > 0) return t.agent;
  if (r.agents_running === 0 && !isNum(r.agent_tokens_done) && isNum(r.in_med10) && r.in_med10 >= gateAt / 2) return t.bigread;
  return null;
}

const boardDir = () => path.join(pace.home(), 'board');

// A row file is recognised by its shape, not by a list of names to spare: the parsed content is an object whose sid
// equals the file name (writeRow writes <sid>.json). The ledger (decisions.json), manager.json, broken json or any other
// file in the folder is therefore never read as a row and never deleted by prune().
function isRowFile(name, r) {
  if (typeof name !== 'string' || !name.endsWith('.json')) return false;
  const sid = name.slice(0, -5);
  return SID_RE.test(sid) && !!r && typeof r === 'object' && !Array.isArray(r) && r.sid === sid;
}

// Rows younger than boardKeepSec; broken json and non-row files (manager.json, decisions.json) skipped. Newest first.
function readBoard(now, cfg) {
  const c = cfgOf(cfg);
  const dir = boardDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const rows = [];
  for (const n of names) {
    if (!n.endsWith('.json') || !SID_RE.test(n.slice(0, -5))) continue;
    const r = pace.readJson(path.join(dir, n), null);
    if (!isRowFile(n, r)) continue;
    const t = Date.parse(r.updated_at);
    if (!isFinite(t) || now - Math.floor(t / 1000) > c.boardKeepSec) continue;
    rows.push(r);
  }
  return rows.sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)));
}

// Deletes expired row files (isRowFile) inside the board folder only. Returns the removed file names. A file that is not
// provably a row (the decisions ledger, manager.json, broken json) is left alone: writeJson is atomic, so a row is never
// half-written, and deleting an unknown file is not ours to do.
function prune(now, cfg) {
  const c = cfgOf(cfg);
  const dir = boardDir();
  const gone = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return gone; }
  for (const n of names) {
    if (!n.endsWith('.json') || !SID_RE.test(n.slice(0, -5))) continue;
    const f = path.join(dir, n);
    const r = pace.readJson(f, null);
    if (!isRowFile(n, r)) continue;
    const t = Date.parse(r.updated_at);
    let old = !isFinite(t);
    if (!old) old = now - Math.floor(t / 1000) > c.boardKeepSec;
    if (old) { try { fs.unlinkSync(f); gone.push(n); } catch (e) { /* ignore */ } }
  }
  return gone;
}

function writeRow(r) {
  if (!r || !SID_RE.test(String(r.sid))) return false;
  const f = path.join(boardDir(), r.sid + '.json');
  // never overwrite a file that is not a row (a session id equal to "decisions" would clobber the ledger)
  if (fs.existsSync(f) && !isRowFile(r.sid + '.json', pace.readJson(f, null))) return false;
  pace.writeJson(f, r);
  return true;
}

// Agents' own transcripts (tail only): sum of usage input+cache_creation+cache_read+output over the turns read. Partial
// by nature. Returns null when none of the files could be read (never 0 for "unknown").
function agentFileTokens(subDir, ids, bytes) {
  if (!subDir) return null;
  let sum = 0, any = false;
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) continue;
    try {
      const turns = turnsFromTail(readTail(path.join(subDir, `agent-${id}.jsonl`), bytes).replace(/"isSidechain":true/g, '"isSidechain":false'));
      any = true;
      for (const t of turns) if (t.role === 'assistant') sum += inTokens(t.usage) + t.usage.output;
    } catch (e) { /* vanished or unreadable */ }
  }
  return any ? sum : null;
}
function liveAgentTokens(subDir, snap, bytes, skip) {
  if (!snap || !Array.isArray(snap.items)) return null;
  const ids = snap.items.filter((it) => it.state === 'running' && !(skip && skip.includes(it.id))).map((it) => it.id);
  return agentFileTokens(subDir, ids, bytes);
}

// Build the row for one session from its transcript. Read-only.
// Hooks scan the subagents folder directly: fleet.scanCached is for the status line and keeps no items (W7: agents_upper 0).
function buildRow(input, entrypointHint, now, cfg) {
  const c = cfgOf(cfg);
  const tp = input.transcript_path;
  const text = readTail(tp, c.boardTailBytes);
  const turns = turnsFromTail(text);
  const m = metrics(turns, null, now, c);
  const dir = fleet.sessionDir(tp);
  const snap = fleet.scan(dir, now, c);
  snap.doneTokens = agentFileTokens(dir, m.agent_done_ids, c.boardTailBytes);
  snap.liveTokens = liveAgentTokens(dir, snap, c.boardTailBytes, m.agent_done_ids);
  return row({ sid: input.session_id, cwd: input.cwd, entrypoint: entrypointHint }, m, snap, now, c);
}

function run(raw) {
  const input = JSON.parse(raw);
  const ev = input.hook_event_name;
  if (ev !== 'UserPromptSubmit' && ev !== 'Stop') return;
  const cfg = pace.loadConfig();
  if (cfg.board === false || pace.skipHook(input, cfg)) return;
  if (typeof input.transcript_path !== 'string' || !SID_RE.test(String(input.session_id))) return;
  const now = Math.floor(Date.now() / 1000);
  const r = buildRow(input, process.env.CLAUDE_CODE_ENTRYPOINT || null, now, cfg);
  writeRow(r);
  prune(now, cfg);
}

// --live: rows from the newest transcripts of the last 24h, NOT written (verification aid; bot folders skipped like the hook does).
function liveRows(now, cfg, limit) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = [];
  let slugs = [];
  try { slugs = fs.readdirSync(root); } catch (e) { return []; }
  for (const s of slugs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, s)).filter((n) => n.endsWith('.jsonl')); } catch (e) { continue; }
    for (const n of names) {
      try { const st = fs.statSync(path.join(root, s, n)); if (now - st.mtimeMs / 1000 < 86400) files.push({ p: path.join(root, s, n), t: st.mtimeMs }); } catch (e) { /* gone */ }
    }
  }
  files.sort((a, b) => b.t - a.t);
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    try {
      const head = parseLines(readTail(f.p, 65536)).reverse().find((o) => o && (o.cwd || o.entrypoint)) || {};
      const input = { session_id: path.basename(f.p, '.jsonl'), transcript_path: f.p, cwd: head.cwd };
      if (/^sdk/i.test(String(head.entrypoint || '')) || pace.skipHook(input, cfg)) continue;
      out.push(buildRow(input, head.entrypoint || null, now, cfg));
    } catch (e) { /* skip unreadable */ }
  }
  return out;
}

// ---- W9-1b layer 1: `--rows` (dashboard push input), `--titles`, `--record-push`. Pure parts first; no LLM, no extrapolation. ----
const PUSH_DEFAULTS = { boardDailyTokens: 150000, boardUnchangedMaxSec: 1500, boardBudgetRetrySec: 3600, boardMaxSessions: 40 };
const iso = (s) => (isNum(s) ? new Date(s * 1000).toISOString() : null);
const VOLATILE = ['updated_at', 'idle_sec', 'vs_share_pp'];

// When the 7d value was really measured: the window's own recorded_at, never the top-level time (a 5h-only write bumps
// that). null when the window, its stamp, or a sane stamp (not more than 120 s ahead) is missing.
function measured7d(st, now) {
  const w = st && st.seven_day;
  const t = w && w.recorded_at;
  return isNum(t) && !(isNum(now) && t > now + 120) ? t : null;
}

// Pure. a = pace.assess(state, now, cfg). Only measured values; no exhaustion forecast key of any kind.
function accountOf(state, a, now) {
  const st = state || {};
  const asm = a || {};
  const worst = asm.worst === '5h' ? asm.h5 : asm.d7;
  const w = worst || asm.d7 || asm.h5 || null;
  const out = {
    updated_at: iso(now),
    measured_at: iso(measured7d(st, now)),
    pct_7d: asm.d7 ? asm.d7.used : null,
    pct_5h: asm.h5 ? asm.h5.used : null,
    grade: asm.grade || null,
    vs_share_pp: worst ? Math.round((worst.used - worst.elapsedPct) * 10) / 10 : null,
    resets_at: w ? iso(w.resetsAt) : null,
    stale: !!asm.stale,
  };
  if (st.fable && isNum(st.fable.pct)) out.pct_fable = st.fable.pct;
  return out;
}

// Pure. rows = pushed session docs.
function summaryOf(rows, activeSessions, now) {
  let h = 0, n = 0;
  for (const r of rows) if (isNum(r.hit)) { h += r.hit; n++; }
  return {
    sessions: rows.length,
    agents: rows.reduce((s, r) => s + (r.agents_running || 0), 0),
    hit: n ? h / n : null,
    lower: rows.filter((r) => r.fit === 'lower_candidate').length,
    clear: rows.filter((r) => r.clear_candidate).length,
    active_sessions: isNum(activeSessions) ? activeSessions : null,
    updated_at: iso(now),
  };
}

// Pure. Titles come from list_sessions (not stored in rows). Control chars dropped, 80 chars max; mask -> 12 chars + ellipsis.
function cleanTitle(t, mask) {
  const s = String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!s) return null;
  return mask && s.length > 12 ? s.slice(0, 12) + '…' : s;
}

// Pure. Accepts {sid: title} or [{sid|sessionId|id, title}].
function titleMap(x) {
  const m = {};
  if (Array.isArray(x)) {
    for (const it of x) { const id = it && (it.sid || it.sessionId || it.session_id || it.id); if (id && it.title != null) m[id] = it.title; }
  } else if (x && typeof x === 'object') {
    for (const k of Object.keys(x)) if (typeof x[k] === 'string') m[k] = x[k];
  }
  return m;
}

// Pure. Board rows -> page session docs: whitelist keys only, ISO times, one suggestion (<=1 line), optional title.
function sessionDocs(rows, account, titles, cfg) {
  const c = Object.assign({}, PUSH_DEFAULTS, cfgOf(cfg));
  const tm = titleMap(titles);
  return rows.slice(0, c.boardMaxSessions).map((r) => {
    const d = {};
    for (const k of ROW_KEYS) if (k in r) d[k] = r[k];
    d.last_ts = iso(r.last_ts);
    d.last_user_ts = iso(r.last_user_ts);
    const t = cleanTitle(tm[r.sid], c.dashboardMaskTitles);
    if (t) d.title = t;
    d.suggestion = suggest(r, account, c);
    return d;
  });
}

const stable = (o) => JSON.stringify(o, (k, v) => (VOLATILE.includes(k) ? undefined : v));
function pushHash(sessions, account, summary, pids) {
  const o = pids && pids.length ? { sessions, account, summary, pids } : { sessions, account, summary };
  return crypto.createHash('sha1').update(stable(o)).digest('hex').slice(0, 16);
}

// Pure. versions = {"sessions/<sid>": n, "account/now": n, "summary/now": n} (existing docs need if_version). Total writes <= 50.
function batchOf(sessions, account, summary, versions) {
  const v = versions || {};
  const w = (collection, doc_id, data) => {
    const e = { op: 'set', collection, doc_id, data };
    const ver = v[collection + '/' + doc_id];
    if (isNum(ver)) e.if_version = ver;
    return e;
  };
  const writes = [w('account', 'now', account), w('summary', 'now', summary)];
  for (const s of sessions) writes.push(w('sessions', s.sid, s));
  const have = new Set(sessions.map((s) => s.sid));
  for (const k of Object.keys(v)) {
    if (writes.length >= 50) break;
    if (k.startsWith('sessions/') && !have.has(k.slice(9)) && isNum(v[k])) writes.push({ op: 'delete', collection: 'sessions', doc_id: k.slice(9), if_version: v[k] });
  }
  return writes.slice(0, 50);
}

// Pure. Sum of board_push tokens in the 24h before now (events.jsonl text).
function pushTokens24h(eventsText, now) {
  let sum = 0;
  for (const o of parseLines(eventsText)) {
    if (!o || o.event !== 'board_push' || !isNum(o.tokens)) continue;
    const t = Date.parse(o.ts);
    if (isFinite(t) && now - t / 1000 <= 86400 && now - t / 1000 >= 0) sum += o.tokens;
  }
  return sum;
}

// Pure. null = go ahead. budget: over boardDailyTokens -> skip, except one push per boardBudgetRetrySec.
// unchanged: same hash as the last recorded push, no pending approvals, and the last push is younger than boardUnchangedMaxSec
// (so the page's "N minutes ago" never passes its 30 minute warning because of skipping).
function decidePush(o) {
  const c = Object.assign({}, PUSH_DEFAULTS, cfgOf(o.cfg));
  const last = o.last || null;
  const ago = last && isNum(last.ts) ? o.now - last.ts : null;
  if (o.tokens24h > c.boardDailyTokens && !(ago !== null && ago >= c.boardBudgetRetrySec)) {
    return { skip: true, reason: 'budget', tokens_24h: o.tokens24h, daily_limit: c.boardDailyTokens };
  }
  if (!(o.pending > 0) && last && last.hash === o.hash && ago !== null && ago >= 0 && ago < c.boardUnchangedMaxSec) {
    return { skip: true, reason: 'unchanged', last_push_ago_sec: ago };
  }
  return null;
}

const pushDir = () => path.join(pace.home(), 'board-push');

// Approved-but-not-applied decisions in board/decisions.json (W9-1e ledger; absent file = 0).
function pendingApprovals() {
  const d = pace.readJson(path.join(boardDir(), 'decisions.json'), null);
  const list = Array.isArray(d) ? d : (d && Array.isArray(d.rows) ? d.rows : []);
  return list.filter((x) => x && x.status === 'approved' && !x.applied_at).length;
}

function readTitles(arg) {
  if (!arg) return null;
  try {
    if (fs.existsSync(arg)) return JSON.parse(fs.readFileSync(arg, 'utf8'));
    return JSON.parse(arg);
  } catch (e) { return null; }
}

// Existing-doc versions from a map file or from a directory written by ArtifactData list/get `out_dir`.
function readVersions(arg) {
  if (!arg) return null;
  try {
    const st = fs.statSync(arg);
    if (st.isFile()) return JSON.parse(fs.readFileSync(arg, 'utf8'));
    const out = {};
    const ver = (f) => { const o = pace.readJson(f, null); const v = o && (o.version != null ? o.version : o._version); return isNum(Number(v)) && v !== null ? Number(v) : null; };
    const grab = (col) => {
      let names = [];
      try { names = fs.readdirSync(path.join(arg, col)); } catch (e) { return; }
      for (const n of names) if (n.endsWith('.json')) { const v = ver(path.join(arg, col, n)); if (v !== null) out[col + '/' + n.slice(0, -5)] = v; }
    };
    grab('sessions'); grab('account'); grab('summary');
    return out;
  } catch (e) { return null; }
}

// Everything `--rows` prints. io = {now, cfg, state, rows, activeSessions, titles, versions, eventsText, last, pending, manager}.
function rowsPayload(io) {
  const cfg = Object.assign({}, PUSH_DEFAULTS, cfgOf(io.cfg));
  const a = pace.assess(io.state, io.now, cfg);
  const account = accountOf(io.state, a, io.now);
  const sessions = sessionDocs(io.rows, account, io.titles, cfg);
  const summary = summaryOf(sessions, io.activeSessions, io.now);
  // W9-1e proposal cards (the page renders them; content is also kept in the local ledger so --apply never trusts page copies).
  // A session card is applicable only when the --titles file (the app's list_sessions result, unchanged) has an entry whose
  // id field equals the board sid exactly; otherwise advice only.
  const known = (io.ledger && io.ledger.proposals && typeof io.ledger.proposals === 'object') ? io.ledger.proposals : {};
  const mapped = D.mappedIds(io.titles, io.rows);
  const props = D.proposals(io.rows, account, io.ledger, io.now, cfg, Object.assign({}, io.extra || {}, { mapped }))
    .map((p) => (known[p.pid] && known[p.pid].created_at ? Object.assign(p, { created_at: known[p.pid].created_at }) : p));
  const hash = pushHash(sessions, account, summary, props.map((p) => p.pid));
  const skip = decidePush({ now: io.now, cfg, tokens24h: pushTokens24h(io.eventsText, io.now), last: io.last, hash, pending: io.pending });
  const log = io.manager && Array.isArray(io.manager.log) ? io.manager.log.slice(-20) : [];
  if (skip) return Object.assign({}, skip, { hash });
  const proposal_writes = props.map((p) => ({ op: 'set', collection: 'proposals', doc_id: p.pid, data: p }));
  return { skip: false, hash, account, summary, sessions, log, writes: batchOf(sessions, account, summary, io.versions), proposals: props, proposal_writes };
}

function rowsMain(argv) {
  const now = Math.floor(Date.now() / 1000);
  const cfg = pace.loadConfig();
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  let active = null;
  try { const s = fleet.scanSessionsCached(null, null, now, cfg); active = s ? s.sessions : null; } catch (e) { /* optional */ }
  let eventsText = '';
  try { eventsText = readTail(path.join(pace.home(), 'events.jsonl'), 2097152); } catch (e) { /* none */ }
  const pend = flag('--pending');
  const out = rowsPayload({
    now, cfg, state: pace.readState(), rows: readBoard(now, cfg), activeSessions: active,
    titles: readTitles(flag('--titles')), versions: readVersions(flag('--versions')), eventsText,
    last: pace.readJson(path.join(pushDir(), 'last.json'), null),
    pending: pend !== undefined ? Number(pend) || 0 : pendingApprovals(),
    manager: pace.readJson(path.join(boardDir(), 'manager.json'), null),
    ledger: readLedger(),
  });
  if (out.skip) return out;
  if (out.proposals.length) rememberProposals(out.proposals, now);
  // Batch input as files: one data file per doc + the batch json itself (entries point at the files, so the caller passes them as-is).
  const dir = pushDir();
  fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true });
  const all = out.writes.concat(out.proposal_writes).slice(0, 50);
  const writes = all.map((w) => {
    if (w.op === 'delete') return w;
    const f = path.join(dir, 'docs', w.collection, w.doc_id + '.json');
    pace.writeJson(f, w.data);
    const e = { op: w.op, collection: w.collection, doc_id: w.doc_id, file_path: f };
    if (w.if_version !== undefined) e.if_version = w.if_version;
    return e;
  });
  const batchFile = path.join(dir, 'batch.json');
  pace.writeJson(batchFile, { writes });
  pace.writeJson(path.join(dir, 'pending.json'), { hash: out.hash, ts: now, rows: out.sessions.length });
  return { skip: false, hash: out.hash, rows: out.sessions.length, writes_count: writes.length, batch_file: batchFile, writes,
    account: out.account, summary: out.summary, log: out.log, proposals: out.proposals.length };
}

// ---- W9-1e: `--apply` / `--record-apply` (DESIGN 10.8). Pure rules live in scripts/decisions.js. ----
// Writes ONLY <home>/config.json, <home>/config.prev.json, <home>/board/decisions.json (+ one events.jsonl line).
const ledgerFile = () => path.join(boardDir(), 'decisions.json');
function readLedger() {
  const d = pace.readJson(ledgerFile(), null);
  if (Array.isArray(d)) return { rows: d, proposals: {} };
  const props = d && d.proposals && typeof d.proposals === 'object' && !Array.isArray(d.proposals) ? d.proposals : {};
  return { rows: d && Array.isArray(d.rows) ? d.rows : [], proposals: props };
}
// Local copy of each proposal the page shows (content fields only), kept 7 days.
function rememberProposals(props, now) {
  const led = readLedger();
  const keep = {};
  for (const k of Object.keys(led.proposals)) {
    const p = led.proposals[k];
    const t = p && Date.parse(p.created_at);
    if (D.PID_RE.test(k) && isFinite(t) && now - t / 1000 <= 7 * 86400) keep[k] = p;
  }
  let changed = false;
  for (const p of props) {
    const doc = { pid: p.pid, kind: p.kind, target: p.target, params: p.params, basis: { measured_at: p.basis.measured_at },
      protected: p.protected, advice_only: p.advice_only, created_at: keep[p.pid] && keep[p.pid].created_at ? keep[p.pid].created_at : p.created_at };
    if (p.unmapped) doc.unmapped = true;
    if (sameJson(keep[p.pid], doc)) continue;
    keep[p.pid] = doc;
    changed = true;
  }
  if (changed) pace.writeJson(ledgerFile(), { rows: led.rows, proposals: keep });
}

const flagOf = (argv, n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Core of --apply with io injected (tests). io = {now, cfg, userCfg, state, rows, ledger, decisions, proposals, settings, live, selfSid, host}.
function applyPayload(io) {
  const now = io.now;
  const a = pace.assess(io.state, now, io.cfg);
  const stateStale = !io.state || !!a.stale || a.grade === null;
  // The mode this run started with decides this run. A mode changed by the settings document in this same run applies
  // from the next run only (W7: a page could flip manual -> approve and get its own decision applied at once).
  const runMode = io.cfg && io.cfg.applyMode === 'approve' ? 'approve' : 'manual';
  const userCfg = io.userCfg && typeof io.userCfg === 'object' && !Array.isArray(io.userCfg) ? io.userCfg : {};
  let newUser = userCfg, settingsApplied = null, sv = null;
  if (io.settings) {
    sv = D.validateSettings(io.settings, io.cfg);
    newUser = D.applyConfig(userCfg, sv.accepted);
  }
  const eff = Object.assign({}, io.cfg, newUser, { applyMode: runMode });
  const led = io.ledger || { rows: [], proposals: {} };
  // Proposal content (kind, target, params, basis, protection) comes ONLY from the local copies --rows wrote to
  // board/decisions.json; the page's proposal docs (io.proposals) are not read at all. A decision whose pid has no local
  // copy is refused (unknown_proposal). From a decision doc only status, decided_by and decided_at are used.
  const local = Object.keys(led.proposals || {}).map((k) => led.proposals[k]);
  const merged = D.mergeDocs(io.decisions, local);
  const selfSid = typeof io.selfSid === 'string' && SID_RE.test(io.selfSid) ? io.selfSid : null;
  const plan = D.planApply(merged, { rows: io.rows, now, stateStale, grade: a.grade || null, selfSid }, eff, io.live, led);
  if (Object.keys(plan.config).length) newUser = D.applyConfig(newUser, plan.config);
  const configChanged = !sameJson(newUser, userCfg);
  const finalMode = Object.assign({}, io.cfg, newUser).applyMode === 'approve' ? 'approve' : 'manual';
  if (sv) {
    // The page reads the mode from settings/applied.accepted.applyMode, so the effective mode is always there.
    const accepted = Object.assign({}, sv.accepted, { applyMode: finalMode });
    settingsApplied = { accepted, rejected: sv.rejected, applied_at: new Date(now * 1000).toISOString(), config_hash: D.configHash(newUser) };
    const rb = io.settings && typeof io.settings.requested_by === 'string' ? cleanTitle(io.settings.requested_by, false) : null;
    if (rb) settingsApplied.requested_by = rb;
  }
  const batch = D.batchFor(plan.ledgerRows, settingsApplied, D.safeHost(io.host));
  return { plan, newUser, configChanged, settingsApplied, stateStale, batch,
    out: { ops: plan.ops, buttons: plan.buttons, results: plan.results, settings_applied: settingsApplied, config_written: configChanged,
      apply_mode: runMode, apply_mode_next: finalMode, state_stale: stateStale, batch } };
}

function applyMain(argv) {
  const now = Math.floor(Date.now() / 1000);
  const cfg = pace.loadConfig();
  const cfgFile = path.join(pace.home(), 'config.json');
  const userCfg = pace.readJson(cfgFile, {});
  const led = readLedger();
  const r = applyPayload({
    now, cfg, userCfg, state: pace.readState(), rows: readBoard(now, cfg), ledger: led,
    decisions: readTitles(flagOf(argv, '--decisions')), // --proposals is accepted for old command files and ignored
    settings: readTitles(flagOf(argv, '--settings')), live: readTitles(flagOf(argv, '--live')), selfSid: flagOf(argv, '--self'), host: os.hostname(),
  });
  if (r.configChanged) {
    pace.writeJson(path.join(pace.home(), 'config.prev.json'), userCfg);
    pace.writeJson(cfgFile, r.newUser);
  }
  if (r.plan.ledgerRows.length) pace.writeJson(ledgerFile(), Object.assign({ proposals: led.proposals }, D.mergeLedger(led, r.plan.ledgerRows, now)));
  const count = (st) => r.plan.results.filter((x) => x.status === st).length;
  pace.appendEvent({ event: 'decision_apply', ops: r.plan.ops.length, buttons: r.plan.buttons.length, applied: count('applied'), refused: count('refused'),
    expired: count('expired'), deferred: count('deferred'), settings_accepted: r.settingsApplied ? Object.keys(r.settingsApplied.accepted).length : 0,
    settings_rejected: r.settingsApplied ? Object.keys(r.settingsApplied.rejected).length : 0, config_written: r.configChanged });
  return r.out;
}

// `--record-apply --results <json|file>`: [{pid, ok, reason?}] after the runner executed ops / showed the clear button.
function recordApplyMain(argv) {
  const now = Math.floor(Date.now() / 1000);
  const led = readLedger();
  const rr = D.recordResults(led, readTitles(flagOf(argv, '--results')), now);
  if (rr.ledgerRows.length) pace.writeJson(ledgerFile(), Object.assign({ proposals: led.proposals }, D.mergeLedger(led, rr.ledgerRows, now)));
  pace.appendEvent({ event: 'decision_record', applied: rr.results.filter((x) => x.status === 'applied').length,
    failed: rr.results.filter((x) => x.status === 'failed').length });
  return { results: rr.results, batch: D.batchFor(rr.ledgerRows, null, D.safeHost(os.hostname())) };
}

// `--record-push tokens=N rows=M`: marks the pending push as done (so the next --rows can see "unchanged") and logs the event.
function recordPush(argv) {
  const kv = {};
  for (const a of argv) { const m = /^(tokens|rows)=(\d+)$/.exec(a); if (m) kv[m[1]] = Number(m[2]); }
  const now = Math.floor(Date.now() / 1000);
  const pend = pace.readJson(path.join(pushDir(), 'pending.json'), null);
  const rec = { ts: now, hash: pend ? pend.hash : null, rows: isNum(kv.rows) ? kv.rows : (pend ? pend.rows : null), tokens: isNum(kv.tokens) ? kv.tokens : null };
  pace.writeJson(path.join(pushDir(), 'last.json'), rec);
  pace.appendEvent({ event: 'board_push', rows: rec.rows, tokens: rec.tokens, hash: rec.hash });
  return { recorded: true, rows: rec.rows, tokens: rec.tokens };
}

module.exports = { DEFAULTS, PUSH_DEFAULTS, ROW_KEYS, turnsFromTail, metrics, row, suggest, readBoard, prune, isRowFile, writeRow, readTail, liveAgentTokens, agentFileTokens, buildRow, run, liveRows, isProtected,
  accountOf, summaryOf, cleanTitle, applyPayload, applyMain, recordApplyMain, readLedger, rememberProposals, titleMap, sessionDocs, pushHash, batchOf, pushTokens24h, decidePush, rowsPayload, rowsMain, recordPush, readVersions, pendingApprovals };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--apply')) {
    try { process.stdout.write(JSON.stringify(applyMain(argv)) + '\n'); } catch (e) { process.stdout.write(JSON.stringify({ ops: [], error: e.message }) + '\n'); }
  } else if (argv.includes('--record-apply')) {
    try { process.stdout.write(JSON.stringify(recordApplyMain(argv)) + '\n'); } catch (e) { process.stdout.write(JSON.stringify({ results: [], error: e.message }) + '\n'); }
  } else if (argv.includes('--rows')) {
    try { process.stdout.write(JSON.stringify(rowsMain(argv)) + '\n'); } catch (e) { process.stdout.write(JSON.stringify({ skip: true, reason: 'error', error: e.message }) + '\n'); }
  } else if (argv.includes('--record-push')) {
    try { process.stdout.write(JSON.stringify(recordPush(argv)) + '\n'); } catch (e) { process.stdout.write(JSON.stringify({ recorded: false, error: e.message }) + '\n'); }
  } else if (argv.includes('--json')) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const cfg = pace.loadConfig();
      const rows = argv.includes('--live') ? liveRows(now, cfg, 10) : readBoard(now, cfg);
      process.stdout.write(JSON.stringify({ count: rows.length, source: argv.includes('--live') ? 'live-scan' : 'board-dir', rows }, null, 1) + '\n');
    } catch (e) { process.stdout.write(JSON.stringify({ count: 0, error: e.message }) + '\n'); }
  } else {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { raw += d; });
    process.stdin.on('end', () => {
      try { run(raw); } catch (e) { /* silent */ }
      process.exit(0);
    });
  }
}
