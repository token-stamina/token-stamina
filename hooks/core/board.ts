// TS mirror of the pure part of scripts/board.js (W9-1a layer 0). No fs here: callers pass tail text / directory entries.
import { parseTailLines, isRealPrompt } from './boundary.ts';
import { textProtected, PROTECT_KEYWORDS_DEFAULT, PROTECT_SEGMENTS } from './decisions.ts';

export interface BoardCfg { [k: string]: any }
export const DEFAULTS: BoardCfg = {
  board: true, boardTailBytes: 262144, boardKeepSec: 86400, boardIdleSec: 1800, dashboardMaskTitles: false,
  managerExcludeCwd: [], managerProtectKeywords: PROTECT_KEYWORDS_DEFAULT.slice(), managerProtectSegments: PROTECT_SEGMENTS.slice(),
  gateAtTokens: 200000, newSessionAtTokens: 400000,
};
const CACHE_TTL_SEC = 300;
const WINDOW = 10;
const SPARK = 20;
const JA_KEYWORDS = ['設計', 'アーキテクチャ', 'レビュー', '監査', '戦略', '判断', '決定'];
export const ROW_KEYS = ['sid', 'cwd_tail', 'model', 'entrypoint', 'protected', 'last_user_ts', 'last_ts', 'in_last', 'in_med10', 'in_trend',
  'spark', 'hit', 'hit_active', 'miss_after_idle', 'j', 'fit', 'estimated', 'ctx_tokens', 'clear_candidate', 'idle_sec', 'agents_running',
  'agents_upper', 'agent_tokens_done', 'agent_tokens_live', 'agent_share', 'sample_turns', 'updated_at'];
export const SID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export interface Turn {
  ts: number | null; role: 'assistant' | 'user' | 'notification'; model?: string | null;
  usage?: { input: number; cache_read: number; cache_creation: number; output: number };
  text?: string; is_task_notification: boolean; id?: string | null; total_tokens?: number;
}

const cfgOf = (cfg?: BoardCfg): BoardCfg => Object.assign({}, DEFAULTS, cfg || {});
const isNum = (x: unknown): x is number => typeof x === 'number' && isFinite(x);
const tsOf = (o: any): number | null => { const t = Date.parse(o && o.timestamp); return isFinite(t) ? Math.floor(t / 1000) : null; };
const inTokens = (u: { input: number; cache_read: number; cache_creation: number }): number => (u.input || 0) + (u.cache_read || 0) + (u.cache_creation || 0);

function median(a: number[]): number | null {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function promptText(o: any): string {
  const c = o.message.content;
  if (typeof c === 'string') return c;
  return c.filter((b: any) => b && b.type === 'text').map((b: any) => String(b.text || '')).join('\n');
}

function notification(ts: number | null, text: string, fromField: number | null): Turn {
  const id = (/<task-id>([^<]+)<\/task-id>/.exec(text) || [])[1] || null;
  let total = fromField;
  if (total === null) {
    const m = /<(?:subagent_tokens|total_tokens)>(\d+)</.exec(text);
    if (m) total = Number(m[1]);
  }
  const t: Turn = { ts, role: 'notification', is_task_notification: true, id };
  if (isNum(total)) t.total_tokens = total;
  return t;
}

// Tail text -> turns. total_tokens comes from attachment.usage.totalTokens (measured on this PC), else the notification text's <subagent_tokens>.
export function turnsFromTail(tailText: string): Turn[] {
  const turns: Turn[] = [];
  const byMsg = new Map<string, Turn>();
  const buf = Buffer.from(String(tailText || ''), 'utf8');
  for (const o of parseTailLines(buf, buf.length)) {
    if (!o || typeof o !== 'object') continue;
    const ts = tsOf(o);
    if (o.type === 'assistant' && !o.isSidechain && o.message && o.message.usage && o.message.model !== '<synthetic>') {
      const u = o.message.usage;
      const t: Turn = { ts, role: 'assistant', model: typeof o.message.model === 'string' ? o.message.model : null,
        usage: { input: u.input_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_creation: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 },
        is_task_notification: false };
      const id = o.message.id;
      if (id && byMsg.has(id)) Object.assign(byMsg.get(id)!, t); else { turns.push(t); if (id) byMsg.set(id, t); }
    } else if (o.type === 'user' && isRealPrompt(o)) {
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

export function tierOf(model: unknown): 'upper' | 'lower' | null {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus') || m.includes('fable')) return 'upper';
  if (m.includes('sonnet') || m.includes('haiku')) return 'lower';
  return null;
}

function keywordCount(prompts: string[], cfg: BoardCfg): number {
  const kws = (Array.isArray(cfg.judgmentKeywords) ? cfg.judgmentKeywords : []).concat(JA_KEYWORDS).map((k: unknown) => String(k).toLowerCase()).filter(Boolean);
  let j = 0;
  for (const p of prompts) {
    const low = String(p).toLowerCase();
    for (const k of kws) if (low.includes(k)) j++;
  }
  return j;
}

export function metrics(turns: Turn[], prompts: string[] | null, now: number, cfg?: BoardCfg): any {
  const c = cfgOf(cfg);
  const A = turns.filter((t) => t.role === 'assistant');
  const users = turns.filter((t) => t.role === 'user');
  const ps = Array.isArray(prompts) ? prompts : users.map((t) => t.text as string);
  const ins = A.map((t) => inTokens(t.usage!));
  const last10 = A.slice(-WINDOW);
  const ins10 = ins.slice(-WINDOW);
  const prev10 = ins.slice(-2 * WINDOW, -WINDOW);
  const med10 = median(ins10);
  const medPrev = median(prev10);
  const total10 = ins10.reduce((a, b) => a + b, 0);
  let missN = 0, readAll = 0, readActive = 0, totActive = 0;
  last10.forEach((t, i) => {
    const gi = A.length - last10.length + i;
    const prev = gi > 0 ? A[gi - 1] : null;
    const idleMiss = !!(prev && isNum(prev.ts) && isNum(t.ts) && t.ts - prev.ts > CACHE_TTL_SEC);
    readAll += t.usage!.cache_read;
    if (idleMiss) missN++; else { readActive += t.usage!.cache_read; totActive += inTokens(t.usage!); }
  });
  const lastA = A[A.length - 1] || null;
  const lastUser = users[users.length - 1] || null;
  const model = lastA ? (lastA.model ?? null) : null;
  const j = keywordCount(ps.slice(-WINDOW), c);
  const tier = tierOf(model);
  let fit: string | null = null;
  if (lastA) fit = (tier === 'upper' && j === 0) ? 'lower_candidate' : (tier === 'lower' && j >= 3) ? 'judgment_on_lower' : 'fit';
  const ctx = lastA ? ins[ins.length - 1] : null;
  const lastUserTs = lastUser && isNum(lastUser.ts) ? lastUser.ts : null;
  const idle = lastUserTs !== null && isNum(now) ? Math.max(0, now - lastUserTs) : null;
  const gate = isNum(c.gateAtTokens) ? c.gateAtTokens : DEFAULTS.gateAtTokens;
  const idleSec = isNum(c.boardIdleSec) ? c.boardIdleSec : DEFAULTS.boardIdleSec;
  const done = new Set<string>();
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

// One protection function shared with decisions.ts (folders named in managerProtectSegments, bot folders, keywords).
export function isProtected(cwd: unknown, cfg?: BoardCfg): boolean {
  return textProtected(cwd, cfgOf(cfg));
}

// Whitelist row: no prompt text, no full path, no transcript path.
// fleetSnap.liveTokens / .doneTokens: cumulative input+cache+output of running / finished agents' own transcripts (caller reads them).
export function row(input: { sid: string; cwd?: string; entrypoint?: string | null }, m: any, fleetSnap: any, now: number, cfg?: BoardCfg): any {
  const snap = fleetSnap || {};
  const running = snap.running || 0;
  const live = isNum(snap.liveTokens) ? snap.liveTokens : null;
  const done = isNum(snap.doneTokens) ? snap.doneTokens : null;
  const agentTok = (done || 0) + (live || 0);
  const known = done !== null || live !== null;
  const cwd = String((input && input.cwd) || '');
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const upper = (snap.items || []).filter((it: any) => it.state === 'running' && tierOf(it.model) === 'upper').length;
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

const S: Record<string, any> = {
  ko: {
    red: (r: any) => (r.fit === 'lower_candidate' ? '예산이 빨강이에요. 이 세션을 먼저 Sonnet 으로 낮춰요(앱 모델 메뉴).' : '예산이 빨강이에요. 큰 작업은 리셋 뒤로 미루거나 하위 모델로 돌려요.'),
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
    red: (r: any) => (r.fit === 'lower_candidate' ? 'Budget is red. Lower this session to Sonnet first (app model menu).' : 'Budget is red. Defer big tasks past the reset or run them on a lower model.'),
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
    red: (r: any) => (r.fit === 'lower_candidate' ? '予算が赤です。このセッションを先に Sonnet へ下げます(アプリのモデルメニュー)。' : '予算が赤です。大きな作業はリセット後に回すか下位モデルで実行します。'),
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

// At most one line, priority E6 > E4 > E3 > E2 > E1 > E5; null when everything is normal.
export function suggest(r: any, account: { grade?: string | null; stale?: boolean } | null | undefined, cfg?: BoardCfg): string | null {
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

export interface BoardEntry { name: string; text: string }

// Row file by shape (mirror of scripts/board.js isRowFile): parsed content is an object whose sid equals the file name.
export function isRowFile(name: string, r: any): boolean {
  if (typeof name !== 'string' || !name.endsWith('.json')) return false;
  const sid = name.slice(0, -5);
  return SID_RE.test(sid) && !!r && typeof r === 'object' && !Array.isArray(r) && r.sid === sid;
}

// Pure form of readBoard: directory entries -> live rows, newest first. Non-row files (manager.json, decisions.json,
// broken json) and expired rows skipped.
export function readBoardEntries(entries: BoardEntry[], now: number, cfg?: BoardCfg): any[] {
  const c = cfgOf(cfg);
  const rows: any[] = [];
  for (const e of entries) {
    let r: any;
    try { r = JSON.parse(e.text); } catch (err) { continue; }
    if (!isRowFile(e.name, r)) continue;
    const t = Date.parse(r.updated_at);
    if (!isFinite(t) || now - Math.floor(t / 1000) > c.boardKeepSec) continue;
    rows.push(r);
  }
  return rows.sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)));
}

// Names of row files that prune() would delete (board folder files only). Only provable rows (isRowFile) are candidates;
// the decisions ledger, manager.json and broken json are never deleted.
export function pruneList(entries: BoardEntry[], now: number, cfg?: BoardCfg): string[] {
  const c = cfgOf(cfg);
  const out: string[] = [];
  for (const e of entries) {
    let r: any = null;
    try { r = JSON.parse(e.text); } catch (err) { continue; }
    if (!isRowFile(e.name, r)) continue;
    const t = Date.parse(r.updated_at);
    if (!isFinite(t) || now - Math.floor(t / 1000) > c.boardKeepSec) out.push(e.name);
  }
  return out;
}

// ---- W9-1b mirror: pure part of `--rows` (scripts/board.js). pace.assess result is passed in (`a`), no fs here. ----
export const PUSH_DEFAULTS: BoardCfg = { boardDailyTokens: 150000, boardUnchangedMaxSec: 1500, boardBudgetRetrySec: 3600, boardMaxSessions: 40 };
const iso = (s: unknown): string | null => (isNum(s) ? new Date(s * 1000).toISOString() : null);
const VOLATILE = ['updated_at', 'idle_sec', 'vs_share_pp'];

// The 7d window's own recorded_at (mirror of scripts/board.js measured7d); null when missing or >120 s ahead.
export function measured7d(st: any, now: number): number | null {
  const w = st && st.seven_day;
  const t = w && w.recorded_at;
  return isNum(t) && !(isNum(now) && t > now + 120) ? t : null;
}

export function accountOf(state: any, a: any, now: number): any {
  const st = state || {};
  const asm = a || {};
  const worst = asm.worst === '5h' ? asm.h5 : asm.d7;
  const w = worst || asm.d7 || asm.h5 || null;
  const out: any = {
    updated_at: iso(now), measured_at: iso(measured7d(st, now)),
    pct_7d: asm.d7 ? asm.d7.used : null, pct_5h: asm.h5 ? asm.h5.used : null,
    grade: asm.grade || null,
    vs_share_pp: worst ? Math.round((worst.used - worst.elapsedPct) * 10) / 10 : null,
    resets_at: w ? iso(w.resetsAt) : null, stale: !!asm.stale,
  };
  if (st.fable && isNum(st.fable.pct)) out.pct_fable = st.fable.pct;
  return out;
}

export function summaryOf(rows: any[], activeSessions: number | null | undefined, now: number): any {
  let h = 0, n = 0;
  for (const r of rows) if (isNum(r.hit)) { h += r.hit; n++; }
  return {
    sessions: rows.length, agents: rows.reduce((s, r) => s + (r.agents_running || 0), 0), hit: n ? h / n : null,
    lower: rows.filter((r) => r.fit === 'lower_candidate').length, clear: rows.filter((r) => r.clear_candidate).length,
    active_sessions: isNum(activeSessions) ? activeSessions : null, updated_at: iso(now),
  };
}

export function cleanTitle(t: unknown, mask?: boolean): string | null {
  const s = String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!s) return null;
  return mask && s.length > 12 ? s.slice(0, 12) + '…' : s;
}

export function titleMap(x: any): Record<string, string> {
  const m: Record<string, string> = {};
  if (Array.isArray(x)) {
    for (const it of x) { const id = it && (it.sid || it.sessionId || it.session_id || it.id); if (id && it.title != null) m[id] = it.title; }
  } else if (x && typeof x === 'object') {
    for (const k of Object.keys(x)) if (typeof x[k] === 'string') m[k] = x[k];
  }
  return m;
}

export function sessionDocs(rows: any[], account: any, titles: any, cfg?: BoardCfg): any[] {
  const c = Object.assign({}, PUSH_DEFAULTS, cfgOf(cfg));
  const tm = titleMap(titles);
  return rows.slice(0, c.boardMaxSessions).map((r) => {
    const d: any = {};
    for (const k of ROW_KEYS) if (k in r) d[k] = r[k];
    d.last_ts = iso(r.last_ts);
    d.last_user_ts = iso(r.last_user_ts);
    const t = cleanTitle(tm[r.sid], c.dashboardMaskTitles);
    if (t) d.title = t;
    d.suggestion = suggest(r, account, c);
    return d;
  });
}

export function pushHashText(sessions: any[], account: any, summary: any): string {
  return JSON.stringify({ sessions, account, summary }, (k, v) => (VOLATILE.includes(k) ? undefined : v));
}

export function batchOf(sessions: any[], account: any, summary: any, versions?: Record<string, number> | null): any[] {
  const v = versions || {};
  const w = (collection: string, doc_id: string, data: any) => {
    const e: any = { op: 'set', collection, doc_id, data };
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

export function pushTokens24h(eventsText: string, now: number): number {
  let sum = 0;
  for (const l of String(eventsText || '').split('\n')) {
    if (!l.trim()) continue;
    let o: any;
    try { o = JSON.parse(l); } catch (e) { continue; }
    if (!o || o.event !== 'board_push' || !isNum(o.tokens)) continue;
    const t = Date.parse(o.ts);
    if (isFinite(t) && now - t / 1000 <= 86400 && now - t / 1000 >= 0) sum += o.tokens;
  }
  return sum;
}

export function decidePush(o: { now: number; cfg?: BoardCfg; tokens24h: number; last?: { ts?: number; hash?: string } | null; hash: string; pending?: number }): any {
  const c = Object.assign({}, PUSH_DEFAULTS, cfgOf(o.cfg));
  const last = o.last || null;
  const ago = last && isNum(last.ts) ? o.now - last.ts : null;
  if (o.tokens24h > c.boardDailyTokens && !(ago !== null && ago >= c.boardBudgetRetrySec)) {
    return { skip: true, reason: 'budget', tokens_24h: o.tokens24h, daily_limit: c.boardDailyTokens };
  }
  if (!((o.pending || 0) > 0) && last && last.hash === o.hash && ago !== null && ago >= 0 && ago < c.boardUnchangedMaxSec) {
    return { skip: true, reason: 'unchanged', last_push_ago_sec: ago };
  }
  return null;
}
