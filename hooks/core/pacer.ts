// Pure pacing math, ported from scripts/pace.js.
//
// Everything here is pure (no fs/env/clock access baked in -- `now`, `cfg`, `state`, `user`
// are always passed in explicitly). The impure counterparts in the original (`home()`,
// `readState`/`writeState`, `appendEvent`, `loadConfig`, `thresholds(cfg)` re-reading
// config.json off disk) stay out of core/ and belong to register.ts, which must fetch
// that data via the mods `$.fs` / `$.session` APIs and pass it in here.
//
// Two functions changed shape on purpose during the port:
//   - `thresholds(cfg)` -> `thresholds(cfg, user)`: the original re-read config.json from
//     disk internally; the port takes the already-loaded user-config object as a second
//     argument so this stays pure and testable.
//   - `skipHook(input, cfg)` -> `shouldSkipHook(entrypoint, cwd, excludeCwd)`: the original
//     read `process.env.CLAUDE_CODE_ENTRYPOINT` internally; the port takes the entrypoint
//     string as an argument (register.ts reads the env var once and passes it in).

export const WEEK = 7 * 86400;
export const FIVE = 5 * 3600;
export const RANK: Record<string, number> = { green: 0, yellow: 1, red: 2 };

export interface Floor { yellow?: number; red?: number }
export interface PaceConfig {
  yellowMargin?: number;
  redAt?: number;
  floors?: { '5h'?: Floor; '7d'?: Floor };
  stateMaxAgeSec?: number;
  compactWindowTokens?: number;
  compactAtTokens?: number;
  newSessionAtTokens?: number;
  gateAtTokens?: number;
  excludeCwd?: string[];
  [key: string]: unknown;
}

export interface RateWindow { pct?: unknown; resets_at?: unknown; recorded_at?: unknown }
export interface PaceState {
  recorded_at?: unknown;
  seven_day?: RateWindow;
  five_hour?: RateWindow;
}

export interface WindowStatsResult {
  used: number;
  elapsedPct: number;
  remainingSec: number;
  resetsAt: number;
  grade: 'green' | 'yellow' | 'red';
}

export function num(x: unknown): number | null {
  return typeof x === 'number' && isFinite(x) ? x : null;
}

// One rate-limit window. w = {pct, resets_at}; null when unusable or already reset.
export function windowStats(
  w: RateWindow | null | undefined,
  windowSec: number,
  now: number,
  cfg?: PaceConfig,
): WindowStatsResult | null {
  if (!w) return null;
  const u = num(w.pct);
  const r = num(w.resets_at);
  if (u === null || r === null) return null;
  const remaining = r - now;
  if (remaining <= 0) return null; // window reset since the value was recorded
  const e = Math.min(1, Math.max(0, 1 - remaining / windowSec));
  const margin = cfg && cfg.yellowMargin != null ? cfg.yellowMargin : 10;
  const redAt = cfg && cfg.redAt != null ? cfg.redAt : 90;
  const expected = e * 100;
  // Floors keep the first minutes of a window from turning red on a few percent (mainly the 5h window).
  const floor: Floor = (cfg && cfg.floors && cfg.floors[windowSec === FIVE ? '5h' : '7d']) || {};
  let grade: 'green' | 'yellow' | 'red' = 'green';
  if (u >= redAt || (u > expected + margin && u >= (floor.red || 0))) grade = 'red';
  else if (u > expected && u >= (floor.yellow || 0)) grade = 'yellow';
  return { used: u, elapsedPct: expected, remainingSec: remaining, resetsAt: r, grade };
}

// Remaining budget split across remaining days (at least 1 day, so the last day gets all of it).
export function dailyQuota(used: number, remainingSec: number): number {
  return Math.max(0, 100 - used) / Math.max(remainingSec / 86400, 1);
}

// Projected time the window hits 100% at the current burn rate, or null if it will not before reset.
export function exhaustAt(w: RateWindow | null | undefined, windowSec: number, now: number): number | null {
  const s = windowStats(w, windowSec, now);
  if (!s || s.used <= 0) return null;
  const elapsedSec = windowSec - s.remainingSec;
  if (elapsedSec < 60) return null;
  const t = now + ((100 - s.used) / (s.used / elapsedSec));
  return t < s.resetsAt ? Math.round(t) : null;
}

export interface AssessResult {
  grade: string | null;
  worst?: string | null;
  stale?: boolean;
  d7?: WindowStatsResult | null;
  h5?: WindowStatsResult | null;
  quota?: number | null;
  exhaust5h?: number | null;
  staleWindows?: string[];
}

// Overall assessment. The worse window wins; a calm 5h never upgrades a bad 7d.
// Freshness is per window (mirror of scripts/pace.js): a window's own recorded_at (else the state's) older than
// stateMaxAgeSec is stale; next to a fresh window it is left out (d7/h5 null, staleWindows), all stale -> stale:true.
export function assess(state: PaceState | null | undefined, now: number, cfg?: PaceConfig): AssessResult {
  if (!state) return { grade: null };
  const maxAge = cfg?.stateMaxAgeSec || 21600;
  const top = num(state.recorded_at);
  const isOld = (t: number | null) => t !== null && (now - t > maxAge || t - now > 120); // future stamp = clock went back = unknown
  const ageOf = (w: RateWindow | undefined) => (w && num(w.recorded_at) !== null ? (w.recorded_at as number) : top);
  let d7 = windowStats(state.seven_day, WEEK, now, cfg);
  let h5 = windowStats(state.five_hour, FIVE, now, cfg);
  if (!d7 && !h5) return { grade: null, stale: isOld(top) };
  const old7 = !!d7 && isOld(ageOf(state.seven_day));
  const old5 = !!h5 && isOld(ageOf(state.five_hour));
  const staleWindows: string[] = [];
  let stale = false;
  if ((!d7 || old7) && (!h5 || old5)) stale = true;
  else {
    if (old7) { d7 = null; staleWindows.push('7d'); }
    if (old5) { h5 = null; staleWindows.push('5h'); }
  }
  let grade = 'green';
  let worst: string | null = null;
  for (const [name, s] of [['7d', d7], ['5h', h5]] as const) {
    if (s && RANK[s.grade] > RANK[grade]) {
      grade = s.grade;
      worst = name;
    }
  }
  if (!worst) worst = d7 ? '7d' : '5h';
  return {
    grade,
    worst,
    stale,
    d7,
    h5,
    staleWindows,
    quota: d7 ? dailyQuota(d7.used, d7.remainingSec) : null,
    exhaust5h: h5 ? exhaustAt(state.five_hour, FIVE, now) : null,
  };
}

// Hooks stay out of headless runs (SDK / automation) and of cwds the user excluded.
// Pure version of scripts/pace.js `skipHook`: register.ts reads
// process.env.CLAUDE_CODE_ENTRYPOINT and the event's cwd and passes both in here.
export function shouldSkipHook(entrypoint: string | undefined, cwd: string | undefined, excludeCwd?: string[]): boolean {
  const ep = entrypoint || '';
  if (/^sdk/i.test(ep)) return true;
  const c = String(cwd || '').toLowerCase();
  const ex = Array.isArray(excludeCwd) ? excludeCwd : [];
  return ex.some((x) => x && c.includes(String(x).toLowerCase()));
}

export interface Thresholds { compactAt: number; newAt: number; gateAt: number }

// Context thresholds. Order: explicit user config key > scaled from compactWindowTokens > default.
// Pure version of scripts/pace.js `thresholds(cfg)`: the original re-read config.json from
// disk internally for the user-level overrides; the port takes that already-loaded object
// as `user` instead.
export function thresholds(cfg: PaceConfig | undefined, user: Record<string, unknown> | undefined): Thresholds {
  const u = user || {};
  const w = num(cfg?.compactWindowTokens) || num(u.compactWindowTokens as number);
  const pick = (key: 'compactAtTokens' | 'newSessionAtTokens' | 'gateAtTokens', ratio: number, dflt: number): number => {
    if (num(u[key]) !== null) return u[key] as number;
    if (w) return Math.round(w * ratio);
    return num(cfg?.[key]) !== null ? (cfg?.[key] as number) : dflt;
  };
  return {
    compactAt: pick('compactAtTokens', 0.4, 150000),
    newAt: pick('newSessionAtTokens', 0.95, 400000),
    gateAt: pick('gateAtTokens', 0.5, 200000),
  };
}

const DAYS: Record<string, string[]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ko: ['일', '월', '화', '수', '목', '금', '토'],
  ja: ['日', '月', '火', '水', '木', '金', '土'],
};

export function fmtReset(epoch: number, lang?: string): string {
  const d = new Date(epoch * 1000);
  const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return (DAYS[lang || ''] || DAYS.en)[d.getDay()] + ' ' + hh;
}

export function fmtClock(epoch: number): string {
  const d = new Date(epoch * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export const fmt1 = (x: number): string => (Math.round(x * 10) / 10).toString();

// additionalContext is invisible to the user, so when Claude relays a suggestion it must say where it came from.
const ATTRIB: Record<string, string> = {
  en: ' (When you pass this on to the user, start with "Token Stamina:" so they know it came from the plugin, not from you.)',
  ko: ' (이 내용을 사용자에게 전하거나 버튼·질문으로 만들 때는 "Token Stamina 알림:"으로 시작해 플러그인 제안임을 밝히세요.)',
};
// Languages without a message table get the English line plus a directive to answer the user in their own language.
const LANG_NAME: Record<string, string> = { ja: 'Japanese', zh: 'Chinese' };

export function attributed(text: string, lang: string | undefined, auto?: boolean): string {
  let out = text + (ATTRIB[lang || ''] || ATTRIB.en);
  if (LANG_NAME[lang || '']) out += ` Write whatever you tell the user in ${LANG_NAME[lang || '']}.`;
  else if (auto && lang === 'en') out += ' Write whatever you tell the user in the language the user is writing in.';
  return out;
}
