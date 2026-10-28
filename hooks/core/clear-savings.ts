// Estimated re-read savings from /compact or /clear now. Port of scripts/clear-savings.js,
// which is itself a port of a reviewed Python prototype (`card()`); test/fixtures/clear-savings-golden.json
// holds its outputs and the ported test requires this file to match them exactly.
// An estimate only: tokens, never money or a limit percentage (see hooks/*.test.ts wording-constraint tests).
//
// Everything below is pure. The original `firstCallTokens` (OS-level partial read of a transcript
// file) and `historyThreshold` (directory scan across ~/.claude/projects with a 1-day cache file)
// were impure fs operations. Both are split here into a pure "given the already-fetched data, decide"
// half (`firstCallTokensFromText`, `cacheIsFresh`, `pickNewestAutoCompact`) plus a pure orchestrator
// (`computeProfile`) that takes every fetched value as a plain argument instead of reading fs itself.
// register.ts (desktop-only, unverified on this PC) owns the actual `$.fs` reads/writes and must
// whole-file-read + slice in JS rather than doing a partial/offset read, since the mods `$.fs` API
// caps reads at 4 MiB and does not support partial/offset reads (PLAN-0.5-mods.md §1).

export const FIXED = 90000; // tools + MCP + prompt + memory + skills; varies 84k-106k
export const THRESHOLD = 266600; // observed auto-compact point (380k * 70%)
export const SUMMARY = 20000;
export const CACHE_REWRITE = 40000;
export const READ = 0.1;
export const WRITE = 1.25;
export const OUT = 5.0;
export const MIN_MESSAGES = 40000;
export const MIN_MESSAGES_IDLE = 20000;
export const MIN_TURNS = 4;
export const DEFAULT_TURNS = 10;

export interface SimulateResult { tokens: number; cost: number; compactions: number }

// fixed/threshold default to the reference machine's values; hintLine() passes the user's own (see profile()).
export function simulate(
  messages: number,
  residual: number,
  growth: number,
  turns: number,
  k: number,
  idle: boolean,
  fixed: number = FIXED,
  threshold: number = THRESHOLD,
): SimulateResult {
  let keep = messages;
  let fresh = residual;
  let tokens = 0;
  let cost = 0;
  let compactions = 0;
  cost -= CACHE_REWRITE * WRITE;
  if (idle) cost += (fixed + keep) * WRITE;
  for (let i = 0; i < turns; i++) {
    keep += growth;
    fresh += growth;
    if (fixed + keep > threshold) {
      compactions++;
      tokens += threshold;
      cost += threshold * READ + SUMMARY * OUT;
      keep = SUMMARY + growth;
    }
    if (fixed + fresh > threshold) {
      tokens -= threshold;
      cost -= threshold * READ + SUMMARY * OUT;
      fresh = SUMMARY + growth;
    }
    tokens += (keep - fresh) * k;
    cost += (keep - fresh) * k * READ;
  }
  return { tokens, cost, compactions };
}

// Python round() / format(.0f) are half-to-even.
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

export interface CardOpts {
  residual?: number;
  growth?: number;
  mode?: 'clear' | 'compact';
  idle?: boolean;
  fixed?: number;
  threshold?: number;
}

export interface CardResult {
  text: string;
  range: [number, number, number, number] | null;
  span?: string;
  cspan?: string;
  verb?: string;
  when?: string;
  note?: string;
  turns?: number;
}

// Returns { text, range }. range is null whenever the card is skipped: never attach numbers then.
export function card(messages: number, turns: number, opts?: CardOpts): CardResult {
  const o = opts || {};
  const residual = o.residual === undefined ? 20000 : o.residual;
  const growth = o.growth === undefined ? 5000 : o.growth;
  const mode = o.mode || 'clear';
  const idle = !!o.idle;
  const fixed = o.fixed === undefined ? FIXED : o.fixed;
  const threshold = o.threshold === undefined ? THRESHOLD : o.threshold;
  if (turns <= 0) return { text: '새 세션 권장(주제 전환)', range: null };
  if (fixed + messages > threshold) return { text: '입력 오류: 이미 자동 압축 시점을 넘은 크기', range: null };
  const floor = idle ? MIN_MESSAGES_IDLE : MIN_MESSAGES;
  if (messages < floor || (turns < MIN_TURNS && !idle)) return { text: '카드 없음(절감 작음)', range: null };
  const a = simulate(messages, residual, growth, turns, 2, idle, fixed, threshold);
  const b = simulate(messages, residual, growth, turns, 8, idle, fixed, threshold);
  const lo = Math.min(a.tokens, b.tokens);
  const hi = Math.max(a.tokens, b.tokens);
  const cLo = Math.min(a.cost, b.cost);
  const cHi = Math.max(a.cost, b.cost);
  if (cLo <= 0 || lo < 10000) return { text: '카드 없음(절감이 0 아래로 걸치거나 캐시 재작성 비용이 더 큼)', range: null };
  // Raw re-read tokens overstated the effect ~10x and the card showed too often: show it only when even the
  // low end saves, at full-price equivalent, at least what clearing itself costs (the cache rewrite).
  if (cLo < CACHE_REWRITE * WRITE) return { text: '카드 없음(정가 환산 절감이 비우는 비용보다 크게 앞서지 않음)', range: null };
  const c = a.compactions;
  const note = c ? `, 그 사이 자동 압축 ${c}회 포함` : '';
  const when = idle ? '쉬었다 재개라 지금이 유리' : '대부분 캐시 읽기(단가 약 1/10)';
  const verb = mode === 'compact' ? '압축하면' : '비우면';
  const fmt = (x: number, y: number): string => {
    const p = roundHalfEven(x / 1e4);
    const q = roundHalfEven(y / 1e4);
    return p === q ? `${p}만` : `${p}~${q}만`;
  };
  const span = fmt(lo, hi);
  const cspan = fmt(cLo, cHi);
  const text = `(예상) 지금 ${verb} 이후 ${turns}턴 동안 정가 환산 약 ${cspan} 토큰 절약 (덜 읽는 양 ${span} — ${when}${note})`;
  return { text, range: [lo, hi, cLo, cHi], span, cspan, verb, when, note, turns };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v as number) : null;
}

export function parseTokens(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(v));
  if (!m) return null;
  const n = parseFloat(m[1]) * (/[kK]/.test(m[2]) ? 1e3 : /[mM]/.test(m[2]) ? 1e6 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// Fitted on two observed points: window 400k + 70% -> 266,646 ((400k - 20k) * 0.7);
// 1M window, no percent -> ~967k (1M - 33k), which also gives the app's displayed 92% for 400k.
export function thresholdFromWindow(windowTokens: number | null | undefined, pct: unknown): number | null {
  if (!windowTokens) return null;
  const p = Number(pct);
  if (pct !== undefined && pct !== null && pct !== '' && p > 0 && p < 100) return Math.round(((windowTokens - 20000) * p) / 100);
  return windowTokens - 33000;
}

const AUTO_RE = /"trigger":"auto","preTokens":(\d+)/g;

export function lastAutoCompact(text: string): number | null {
  let m: RegExpExecArray | null;
  let last: number | null = null;
  AUTO_RE.lastIndex = 0;
  while ((m = AUTO_RE.exec(text)) !== null) last = Number(m[1]);
  return last;
}

// Pure core of scripts/clear-savings.js `firstCallTokens`: first main-thread call of the session =
// everything present before any conversation (+ the first prompt). `text` is the already-read prefix
// of the transcript file (register.ts reads the whole file via `$.fs` -- capped at 4 MiB -- and should
// slice to the leading `bytes` before calling this, mirroring the original's 512 KiB default window).
export function firstCallTokensFromText(text: string): number | null {
  for (const l of text.split('\n')) {
    if (!l.includes('"usage"')) continue;
    let o: any;
    try {
      o = JSON.parse(l);
    } catch (e) {
      continue;
    }
    const u = o.type === 'assistant' && !o.isSidechain && o.message && o.message.model !== '<synthetic>' && o.message.usage;
    if (u) {
      const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (t > 0) return t;
    }
  }
  return null;
}

export interface ThresholdCache { ts: number; threshold: number | null }

// Pure core of scripts/clear-savings.js `historyThreshold`'s cache-freshness check.
// Returns the cached threshold when the cache is < 1 day old, or undefined when the caller must
// recompute (and, per the original, rewrite the cache afterwards).
export function cacheIsFresh(cache: ThresholdCache | null | undefined, nowMs: number): number | null | undefined {
  if (cache && nowMs - cache.ts < 864e5) return cache.threshold ?? null;
  return undefined;
}

// Pure core of scripts/clear-savings.js `historyThreshold`'s file-scan loop: given transcript file
// contents already sorted newest-mtime-first (and already limited to the newest 40, and already
// filtered to <30 days old and <64 MiB, exactly as the original's directory scan did), returns the
// first non-null auto-compact point found -- "newest file that has one wins" (the original breaks out
// of its loop as soon as one is found, so only the texts actually needed should be passed in).
export function pickNewestAutoCompact(sortedTextsNewestFirst: string[]): number | null {
  for (const t of sortedTextsNewestFirst) {
    const v = lastAutoCompact(t);
    if (v) return v;
  }
  return null;
}

export interface ProfileResult { fixed: number | null; threshold: number | null; source: string | null }

export interface ComputeProfileInput {
  cfgFixedTokens?: unknown;
  firstCallTokensValue?: number | null; // register.ts: firstCallTokensFromText() on the transcript, or null if none/unreadable
  cfgCompactAtTokens?: unknown;
  entries?: Array<{ subtype?: string; compactMetadata?: { trigger?: string; preTokens?: unknown } }>;
  envWindow?: unknown; // CLAUDE_CODE_AUTO_COMPACT_WINDOW
  cfgCompactWindowTokens?: unknown;
  envPct?: unknown; // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  historyThresholdValue?: number | null; // register.ts: cacheIsFresh() ?? pickNewestAutoCompact(), or null if unknown
}

// Pure core of scripts/clear-savings.js `profile(o)`. Every fetched value (fixed-token first-call
// estimate, session compact_boundary entries, env/config window+pct, the history-scan result) is
// passed in explicitly instead of being read from fs/env inside this function.
// Order for the threshold: config compactAtTokens > this session's own auto-compact > settings env
// (window, percent) > config compactWindowTokens > recent transcripts.
export function computeProfile(o: ComputeProfileInput): ProfileResult {
  const fixed = num(o.cfgFixedTokens) || num(o.firstCallTokensValue);
  let threshold = num(o.cfgCompactAtTokens);
  let source: string | null = threshold ? 'config' : null;
  if (!threshold && o.entries) {
    for (const e of o.entries) {
      const m = e && e.subtype === 'compact_boundary' && e.compactMetadata;
      if (m && m.trigger === 'auto' && num(m.preTokens)) {
        threshold = m.preTokens as number;
        source = 'session';
      }
    }
  }
  if (!threshold) {
    const w = parseTokens(o.envWindow) || num(o.cfgCompactWindowTokens);
    threshold = thresholdFromWindow(w, o.envPct) || null;
    if (threshold) source = 'window';
  }
  if (!threshold && o.historyThresholdValue) {
    threshold = o.historyThresholdValue;
    if (threshold) source = 'history';
  }
  if (fixed && threshold && fixed >= threshold) return { fixed: null, threshold: null, source: 'inconsistent' };
  return { fixed: fixed || null, threshold: threshold || null, source };
}

// prof = computeProfile(): this user's fixed share and auto-compact point. Unknown either one -> no
// numbers at all (an unknown value is not the reference machine's value).
export function hintLine(
  ctxTokens: number,
  lang: string | undefined,
  mode: 'clear' | 'compact',
  cfg: { savingsTurns?: number } | undefined,
  prof: ProfileResult | null | undefined,
): string {
  if (!prof || !prof.fixed || !prof.threshold) return '';
  const turns = cfg?.savingsTurns || DEFAULT_TURNS;
  const messages = Math.max(0, Math.round(ctxTokens) - prof.fixed);
  const r = card(messages, turns, { mode, fixed: prof.fixed, threshold: prof.threshold });
  if (!r.range) return '';
  if (lang === 'ko') return r.text;
  const kv = mode === 'compact' ? 'compacting' : 'clearing';
  const m = (x: number): string => (roundHalfEven(x / 1e5) / 10).toFixed(1) + 'M';
  const k = (x: number): string => roundHalfEven(x / 1e3) + 'k';
  const span = r.span!.includes('~') ? `${m(r.range[0])}–${m(r.range[1])}` : m(r.range[0]);
  const cspan = r.cspan!.includes('~') ? `${k(r.range[2])}–${k(r.range[3])}` : k(r.range[2]);
  const when = r.when!.startsWith('쉬') ? 'resuming after idle' : 'mostly cache reads, ~1/10 price';
  return `(estimate) ${kv} now saves about ${cspan} full-price-equivalent tokens over the next ${turns} turns (${span} tokens less re-read — ${when}${r.note ? ', incl. ' + r.note.replace(/\D/g, '') + ' auto-compact(s) in between' : ''})`;
}
