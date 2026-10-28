// Fleet observation (how many subagents run now, on which models), ported from scripts/fleet.js.
// Pure functions only: the directory reading (readdir/stat/readFile of agent-<id>.meta.json), the
// 64-newest cap and the fleet-cache.json memo are I/O, left to the caller -- same split as the
// other core/*.ts files. The caller passes {name, mtime, text} entries to `scanEntries`.

export const MAX_SCAN = 64;

export interface FleetConfig {
  fleet?: boolean;
  fleetShowAt?: number;
  fleetStaleSec?: number;
  fleetScope?: string;
  fleetCacheSec?: number;
}
export interface Meta { agentType?: string; description?: string; model?: string | null; finished?: boolean; spawnDepth?: number; [k: string]: unknown }
export type FleetState = 'running' | 'finished' | 'stale';
export interface FleetItem { id: string; description: string; agentType: string; model: string | null; depth: number | null; requestShape: string | null; nonInteractive: boolean; state: FleetState; mtime: number }
export interface FleetSnap { running: number; finished: number; stale: number; total: number; models: Record<string, number>; items: FleetItem[]; truncated: boolean }
// mtime = newest of the meta and its agent-<id>.jsonl; callers also list subagents/workflows/<wf_*>/ (one level, no glob).
export interface FleetEntry { name: string; mtime: number; text: string }

export function parseMeta(text: string): Meta | null {
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    return m as Meta;
  } catch {
    return null;
  }
}

export function classify(meta: Meta | null | undefined, mtimeSec: number, nowSec: number, cfg?: FleetConfig): FleetState {
  if (meta && meta.finished === true) return 'finished';
  const lim = cfg && typeof cfg.fleetStaleSec === 'number' ? cfg.fleetStaleSec : 600;
  if (typeof mtimeSec === 'number' && nowSec - mtimeSec > lim) return 'stale';
  return 'running';
}

export function sessionDir(transcriptPath: unknown): string | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const sub = transcriptPath.replace(/\\/g, '/').match(/^(.*\/subagents)\/agent-[^/]+\.jsonl$/);
  if (sub) return sub[1];
  return transcriptPath.replace(/\.jsonl$/, '') + '/subagents';
}

export function modelLetter(model: unknown): string {
  if (typeof model !== 'string' || !model) return '?';
  const m = model.toLowerCase();
  if (m.includes('fable')) return 'F';
  if (m.includes('opus')) return 'O';
  if (m.includes('sonnet')) return 'S';
  if (m.includes('haiku')) return 'H';
  return (m.match(/[a-z]/) || ['?'])[0].toUpperCase();
}

export function emptySnap(): FleetSnap {
  return { running: 0, finished: 0, stale: 0, total: 0, models: {}, items: [], truncated: false };
}

export function snapshot(items: FleetItem[], truncated: boolean): FleetSnap {
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

// Newest 64 *.meta.json entries by mtime, broken JSON skipped.
export function scanEntries(entries: FleetEntry[], nowSec: number, cfg?: FleetConfig): FleetSnap {
  const named = entries.filter((e) => /^agent-.+\.meta\.json$/.test(e.name)).sort((a, b) => b.mtime - a.mtime);
  const truncated = named.length > MAX_SCAN;
  const items: FleetItem[] = [];
  for (const e of named.slice(0, MAX_SCAN)) {
    const meta = parseMeta(e.text);
    if (!meta) continue;
    items.push({
      id: e.name.replace(/^agent-/, '').replace(/\.meta\.json$/, ''),
      description: String(meta.description || '').slice(0, 80),
      agentType: meta.agentType || '',
      model: typeof meta.model === 'string' ? meta.model : null,
      depth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : null,
      requestShape: typeof meta.requestShape === 'string' ? meta.requestShape : null,
      nonInteractive: meta.requestNonInteractive === true,
      state: classify(meta, e.mtime, nowSec, cfg),
      mtime: e.mtime,
    });
  }
  return snapshot(items, truncated);
}

// Small, item-free view for hooks; shape fixed (decide() depends on it).
export interface FleetPressure { running: number; models: Record<string, number>; truncated: boolean }
export function pressure(snap: FleetSnap | null | undefined): FleetPressure {
  const s = snap || emptySnap();
  return { running: s.running || 0, models: { ...(s.models || {}) }, truncated: !!s.truncated };
}

export function segment(snap: FleetSnap | null | undefined, cfg?: FleetConfig): string {
  if (!cfg || cfg.fleet === false || cfg.fleetShowAt === 0 || !snap) return '';
  const at = typeof cfg.fleetShowAt === 'number' ? cfg.fleetShowAt : 2;
  if (!(snap.running >= at)) return '';
  const parts = Object.keys(snap.models)
    .sort((a, b) => snap.models[b] - snap.models[a] || a.localeCompare(b))
    .map((k) => `${snap.models[k]}${k}`);
  return `🤖${snap.running} (${parts.join('·')})`;
}

interface Tr { empty: string; head: string[]; run: string; fin: string; stale: string; sum: (s: FleetSnap) => string; trunc: string }
const T: Record<string, Tr> = {
  en: { empty: 'No subagent records found.', head: ['State', 'Model', 'Type', 'Description'], run: 'running', fin: 'finished', stale: 'stale',
        sum: (s) => `${s.running} running · ${s.finished} finished · ${s.stale} stale`, trunc: 'Showing the newest 64 only.' },
  ko: { empty: '하위 에이전트 기록이 없어요.', head: ['상태', '모델', '종류', '설명'], run: '실행 중', fin: '끝남', stale: '멈춘 듯',
        sum: (s) => `실행 중 ${s.running} · 끝남 ${s.finished} · 멈춘 듯 ${s.stale}`, trunc: '최신 64개만 보여요.' },
  ja: { empty: 'サブエージェントの記録がありません。', head: ['状態', 'モデル', '種類', '説明'], run: '実行中', fin: '完了', stale: '停止の疑い',
        sum: (s) => `実行中 ${s.running} · 完了 ${s.finished} · 停止の疑い ${s.stale}`, trunc: '最新64件のみ表示します。' },
};

export function table(snap: FleetSnap | null | undefined, lang?: string, budgetLine?: string | null): string {
  const t = T[lang || 'en'] || T.en;
  const head = budgetLine ? [budgetLine, ''] : [];
  if (!snap || !snap.items || !snap.items.length) return head.concat(t.empty).join('\n');
  const esc = (x: unknown) => String(x || '').replace(/\|/g, '/').replace(/\s+/g, ' ');
  const lines = [...head, t.sum(snap), '', `| ${t.head.join(' | ')} |`, `|${t.head.map(() => '---').join('|')}|`];
  const rows = snap.items.slice().sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || b.mtime - a.mtime);
  for (const it of rows) {
    const label = it.state === 'finished' ? t.fin : it.state === 'stale' ? t.stale : t.run;
    lines.push(`| ${label} | ${modelLetter(it.model)} | ${esc(it.agentType)} | ${esc(it.description)} |`);
  }
  if (snap.truncated) lines.push('', t.trunc);
  return lines.join('\n');
}

// ---- W4b-2: sessions (pure part; readdir/stat/head-read stay in scripts/fleet.js) ----
export interface SessionsConfig {
  excludeCwd?: string[];
  fleetSessionActiveSec?: number;
  fleetSessionsCountHeadless?: boolean;
  fleetSessionsCountExcluded?: boolean;
  fleetWarnAt?: number; fleetHardAt?: number; fleetTotalWarnAt?: number; fleetTotalHardAt?: number;
}
export type SessionKind = 'self' | 'excluded' | 'headless' | 'interactive' | 'old' | 'unknown';
export interface SessionInfo { slug?: string; path?: string; entrypoint?: string | null; cwd?: string | null }
export interface SessionItem { slug: string; id: string; age: number; kind: SessionKind }
export interface SessionsSnap { sessions: number; headless: number; excluded: number; unknown: number; truncated: boolean; items: SessionItem[] }

export function normalizeSlug(s: unknown): string {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '-');
}

export function excludedBySlug(slug: unknown, cwd: unknown, excludeCwd: unknown): boolean {
  if (!Array.isArray(excludeCwd)) return false;
  const a = normalizeSlug(slug);
  const b = cwd == null || cwd === '' ? null : normalizeSlug(cwd);
  for (const x of excludeCwd) {
    const n = normalizeSlug(x).replace(/^-+|-+$/g, '');
    if (!n) continue;
    if (a.includes(n) || (b && b.includes(n))) return true;
  }
  return false;
}

// Head text (first 64 KB) -> {entrypoint, cwd}, line by line; `cut` = the read filled the buffer so the last line may be partial.
export function parseHead(text: string, cut?: boolean): { entrypoint: string | null; cwd: string | null } {
  const lines = String(text || '').split('\n');
  if (cut) lines.pop();
  let entrypoint: string | null = null;
  let cwd: string | null = null;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(ln); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (cwd === null && typeof o.cwd === 'string') cwd = o.cwd;
    if (entrypoint === null && typeof o.entrypoint === 'string') entrypoint = o.entrypoint;
    if (entrypoint !== null && cwd !== null) break;
  }
  return { entrypoint, cwd };
}

const norm = (x: string) => x.replace(/\\/g, '/').toLowerCase();
function selfOf(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return null;
  const m = p.replace(/\\/g, '/').match(/^(.*)\/subagents\/agent-[^/]+\.jsonl$/);
  return m ? m[1] + '.jsonl' : p;
}

export function classifySession(info: SessionInfo | null, mtime: number, now: number, selfPath: string | null | undefined, cfg?: SessionsConfig): SessionKind {
  const i = info || {};
  const active = cfg && typeof cfg.fleetSessionActiveSec === 'number' ? cfg.fleetSessionActiveSec : 1800;
  const self = selfOf(selfPath);
  if (self && i.path && norm(i.path) === norm(self)) return 'self';
  if (excludedBySlug(i.slug, i.cwd, cfg && cfg.excludeCwd)) return 'excluded';
  if (typeof mtime === 'number' && now - mtime > active) return 'old';
  if (typeof i.entrypoint !== 'string' || !i.entrypoint) return 'unknown';
  if (/^sdk/i.test(i.entrypoint)) return 'headless';
  return 'interactive';
}

export function sessionsSnapshot(items: SessionItem[], truncated: boolean, cfg?: SessionsConfig, extraExcluded?: number): SessionsSnap {
  const s: SessionsSnap = { sessions: 0, headless: 0, excluded: extraExcluded || 0, unknown: 0, truncated: !!truncated, items: [] };
  for (const it of items) {
    if (it.kind === 'interactive') s.sessions++;
    else if (it.kind === 'headless') s.headless++;
    else if (it.kind === 'excluded') s.excluded++;
    else if (it.kind === 'unknown') s.unknown++;
    s.items.push(it);
  }
  if (cfg && cfg.fleetSessionsCountHeadless) s.sessions += s.headless;
  if (cfg && cfg.fleetSessionsCountExcluded) s.sessions += s.excluded;
  return s;
}

export interface FleetPressureS extends FleetPressure { sessions?: number | null }
// Same as pressure() when sessionsSnap is undefined; with it, adds `sessions` (null when the scan failed).
export function pressureWithSessions(snap: FleetSnap | null | undefined, sessionsSnap?: SessionsSnap | null): FleetPressureS {
  const p: FleetPressureS = pressure(snap);
  if (sessionsSnap !== undefined) p.sessions = sessionsSnap && typeof sessionsSnap.sessions === 'number' ? sessionsSnap.sessions : null;
  return p;
}

export function fleetPressure(fl: { running?: number; sessions?: number | null } | null | undefined, cfg?: SessionsConfig, level?: 'warn' | 'hard'): boolean {
  const hard = level === 'hard';
  const one = (hard ? cfg?.fleetHardAt : cfg?.fleetWarnAt) ?? (hard ? 5 : 3);
  const tot = (hard ? cfg?.fleetTotalHardAt : cfg?.fleetTotalWarnAt) ?? (hard ? 7 : 4);
  const running = (fl && fl.running) || 0;
  if (running >= one) return true;
  return !!fl && typeof fl.sessions === 'number' && running + fl.sessions >= tot;
}

export function sessionsLine(ss: SessionsSnap | null | undefined, lang: string | undefined, snap: FleetSnap | null | undefined, all?: boolean): string {
  if (!ss) return '';
  const sn = snap || emptySnap();
  const dist = sn.running ? Object.keys(sn.models).sort((a, b) => sn.models[b] - sn.models[a] || a.localeCompare(b)).map((k) => sn.models[k] + k).join('·') : '';
  const m = sn.running || 0;
  const unk = (w: string) => (ss.unknown ? ` · ${w} ${ss.unknown}` : '');
  if (lang === 'ko') return `세션 ${ss.sessions}개(대화형) · 제외 ${ss.excluded} · 헤드리스 ${ss.headless}${unk('미확인')}${ss.truncated ? ' (일부만)' : ''} · ${all ? '전체' : '이 세션'} 에이전트 ${m}개${dist ? ` (${dist})` : ''}`;
  if (lang === 'ja') return `セッション ${ss.sessions}件(対話型) · 除外 ${ss.excluded} · ヘッドレス ${ss.headless}${unk('不明')}${ss.truncated ? ' (一部のみ)' : ''} · ${all ? '全体' : 'このセッション'}のエージェント ${m}件${dist ? ` (${dist})` : ''}`;
  return `sessions ${ss.sessions} (interactive) · excluded ${ss.excluded} · headless ${ss.headless}${unk('unknown')}${ss.truncated ? ' (partial)' : ''} · agents ${all ? 'total' : 'here'} ${m}${dist ? ` (${dist})` : ''}`;
}

// table() with the sessions line after the budget line (null ss = identical to table()).
export function tableWithSessions(snap: FleetSnap | null | undefined, lang?: string, budgetLine?: string | null, ss?: SessionsSnap | null, all?: boolean): string {
  const base = table(snap, lang, budgetLine);
  const sl = sessionsLine(ss, lang, snap, all);
  if (!sl) return base;
  if (!budgetLine) return sl + '\n\n' + base;
  return budgetLine + '\n\n' + sl + '\n\n' + base.slice(budgetLine.length + 2);
}
