'use strict';
const fs = require('fs');
const path = require('path');
// Estimated re-read savings from /compact or /clear now. Port of a reviewed Python prototype (card()); test/fixtures/clear-savings-golden.json holds its
// outputs and the tests require this port to match them. Constants come from measurements on real transcripts.
// An estimate only: tokens, never money or a limit percentage. Unknown: how the plan limit counts cache reads.
const FIXED = 90000;        // tools + MCP + prompt + memory + skills; varies 84k-106k
const THRESHOLD = 266600;   // observed auto-compact point (380k * 70%)
const SUMMARY = 20000;
const CACHE_REWRITE = 40000;
const READ = 0.1, WRITE = 1.25, OUT = 5.0;
const MIN_MESSAGES = 40000, MIN_MESSAGES_IDLE = 20000, MIN_TURNS = 4;
const DEFAULT_TURNS = 10;

// fixed/threshold default to the reference machine's values; hintLine() passes the user's own (see profile()).
function simulate(messages, residual, growth, turns, k, idle, fixed = FIXED, threshold = THRESHOLD) {
  let keep = messages, fresh = residual;
  let tokens = 0, cost = 0, compactions = 0;
  cost -= CACHE_REWRITE * WRITE;
  if (idle) cost += (fixed + keep) * WRITE;
  for (let i = 0; i < turns; i++) {
    keep += growth; fresh += growth;
    if (fixed + keep > threshold) {
      compactions++; tokens += threshold; cost += threshold * READ + SUMMARY * OUT; keep = SUMMARY + growth;
    }
    if (fixed + fresh > threshold) {
      tokens -= threshold; cost -= threshold * READ + SUMMARY * OUT; fresh = SUMMARY + growth;
    }
    tokens += (keep - fresh) * k;
    cost += (keep - fresh) * k * READ;
  }
  return { tokens, cost, compactions };
}

// Python round() / format(.0f) are half-to-even.
function roundHalfEven(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

// Returns { text, range }. range is null whenever the card is skipped: never attach numbers then.
function card(messages, turns, opts) {
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
  const lo = Math.min(a.tokens, b.tokens), hi = Math.max(a.tokens, b.tokens);
  const cLo = Math.min(a.cost, b.cost), cHi = Math.max(a.cost, b.cost);
  if (cLo <= 0 || lo < 10000) return { text: '카드 없음(절감이 0 아래로 걸치거나 캐시 재작성 비용이 더 큼)', range: null };
  // Raw re-read tokens overstated the effect ~10x and the card showed too often: show it only when even the
  // low end saves, at full-price equivalent, at least what clearing itself costs (the cache rewrite).
  if (cLo < CACHE_REWRITE * WRITE) return { text: '카드 없음(정가 환산 절감이 비우는 비용보다 크게 앞서지 않음)', range: null };
  const c = a.compactions;
  const note = c ? `, 그 사이 자동 압축 ${c}회 포함` : '';
  const when = idle ? '쉬었다 재개라 지금이 유리' : '대부분 캐시 읽기(단가 약 1/10)';
  const verb = mode === 'compact' ? '압축하면' : '비우면';
  const fmt = (x, y) => { const p = roundHalfEven(x / 1e4), q = roundHalfEven(y / 1e4); return p === q ? `${p}만` : `${p}~${q}만`; };
  const span = fmt(lo, hi), cspan = fmt(cLo, cHi);
  const text = `(예상) 지금 ${verb} 이후 ${turns}턴 동안 정가 환산 약 ${cspan} 토큰 절약 (덜 읽는 양 ${span} — ${when}${note})`;
  return { text, range: [lo, hi, cLo, cHi], span, cspan, verb, when, note, turns };
}

// Hint sentence for the plugin's compact/clear hints, or '' when there is no card. ctxTokens = total context
// (messages ≈ ctxTokens − FIXED). Turns are unknown to a hook: default 10, config savingsTurns overrides.
// --- Per-user profile -------------------------------------------------------------------------------
// Both reference constants were measured on one machine (400k window at 70%, many MCP servers and skills).
// Another user's auto-compact point and fixed share can differ by a factor of 3 or more, so derive them.

const AUTO_RE = /"trigger":"auto","preTokens":(\d+)/g;

function parseTokens(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(v));
  if (!m) return null;
  const n = parseFloat(m[1]) * (/[kK]/.test(m[2]) ? 1e3 : /[mM]/.test(m[2]) ? 1e6 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// Fitted on two observed points: window 400k + 70% -> 266,646 ((400k - 20k) * 0.7);
// 1M window, no percent -> ~967k (1M - 33k), which also gives the app's displayed 92% for 400k.
function thresholdFromWindow(windowTokens, pct) {
  if (!windowTokens) return null;
  const p = Number(pct);
  if (pct !== undefined && pct !== null && pct !== '' && p > 0 && p < 100) return Math.round((windowTokens - 20000) * p / 100);
  return windowTokens - 33000;
}

function lastAutoCompact(text) {
  let m, last = null;
  AUTO_RE.lastIndex = 0;
  while ((m = AUTO_RE.exec(text)) !== null) last = Number(m[1]);
  return last;
}

// First main-thread call of the session = everything present before any conversation (+ the first prompt).
function firstCallTokens(transcriptPath, bytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    for (const l of buf.toString('utf8').split('\n')) {
      if (!l.includes('"usage"')) continue;
      let o;
      try { o = JSON.parse(l); } catch (e) { continue; }
      const u = o.type === 'assistant' && !o.isSidechain && o.message && o.message.model !== '<synthetic>' && o.message.usage;
      if (u) {
        const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (t > 0) return t;
      }
    }
  } catch (e) { /* unreadable: unknown */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

// Most recent auto-compact point in the user's recent transcripts, cached for a day.
function historyThreshold(projectsDir, cacheFile, nowMs = Date.now()) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (c && nowMs - c.ts < 864e5) return c.threshold || null;
  } catch (e) { /* no cache */ }
  let best = null;
  try {
    const files = [];
    for (const d of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, d);
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const f = path.join(dir, n);
        const st = fs.statSync(f);
        if (nowMs - st.mtimeMs < 30 * 864e5 && st.size < 64 * 1024 * 1024) files.push({ f, t: st.mtimeMs });
      }
    }
    files.sort((x, y) => y.t - x.t);
    for (const { f, t } of files.slice(0, 40)) {
      const v = lastAutoCompact(fs.readFileSync(f, 'utf8'));
      if (v && (!best || t > best.t)) best = { v, t };
      if (best) break;   // newest file that has one wins: a settings change makes older points stale
    }
  } catch (e) { /* unknown */ }
  const threshold = best ? best.v : null;
  try { fs.writeFileSync(cacheFile, JSON.stringify({ ts: nowMs, threshold })); } catch (e) { /* best effort */ }
  return threshold;
}

// Returns { fixed, threshold, source } with null for anything unknown. Order for the threshold:
// config compactAtTokens > this session's own auto-compact > settings env (window, percent) > config
// compactWindowTokens > recent transcripts.
function profile(o) {
  const env = o.env || process.env, cfg = o.cfg || {};
  const fixed = num(cfg.fixedTokens) || (o.transcriptPath ? firstCallTokens(o.transcriptPath) : null);
  let threshold = num(cfg.compactAtTokens), source = threshold ? 'config' : null;
  if (!threshold && o.entries) {
    for (const e of o.entries) {
      const m = e && e.subtype === 'compact_boundary' && e.compactMetadata;
      if (m && m.trigger === 'auto' && num(m.preTokens)) { threshold = m.preTokens; source = 'session'; }
    }
  }
  if (!threshold) {
    const w = parseTokens(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) || num(cfg.compactWindowTokens);
    threshold = thresholdFromWindow(w, env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
    if (threshold) source = 'window';
  }
  if (!threshold && o.projectsDir && o.cacheFile) {
    threshold = historyThreshold(o.projectsDir, o.cacheFile, o.nowMs);
    if (threshold) source = 'history';
  }
  if (fixed && threshold && fixed >= threshold) return { fixed: null, threshold: null, source: 'inconsistent' };
  return { fixed: fixed || null, threshold: threshold || null, source };
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null; }

// prof = profile(): this user's fixed share and auto-compact point. Unknown either one -> no numbers at all
// (an unknown value is not the reference machine's value).
function hintLine(ctxTokens, lang, mode, cfg, prof) {
  if (!prof || !prof.fixed || !prof.threshold) return '';
  const turns = (cfg && cfg.savingsTurns) || DEFAULT_TURNS;
  const messages = Math.max(0, Math.round(ctxTokens) - prof.fixed);
  const r = card(messages, turns, { mode, fixed: prof.fixed, threshold: prof.threshold });
  if (!r.range) return '';
  if (lang === 'ko') return r.text;
  const kv = mode === 'compact' ? 'compacting' : 'clearing';
  const m = (x) => (roundHalfEven(x / 1e5) / 10).toFixed(1) + 'M';
  const k = (x) => roundHalfEven(x / 1e3) + 'k';
  const span = r.span.includes('~') ? `${m(r.range[0])}–${m(r.range[1])}` : m(r.range[0]);
  const cspan = r.cspan.includes('~') ? `${k(r.range[2])}–${k(r.range[3])}` : k(r.range[2]);
  const when = r.when.startsWith('쉬') ? 'resuming after idle' : 'mostly cache reads, ~1/10 price';
  return `(estimate) ${kv} now saves about ${cspan} full-price-equivalent tokens over the next ${turns} turns (${span} tokens less re-read — ${when}${r.note ? ', incl. ' + r.note.replace(/\D/g, '') + ' auto-compact(s) in between' : ''})`;
}

module.exports = { FIXED, THRESHOLD, SUMMARY, CACHE_REWRITE, MIN_MESSAGES, MIN_MESSAGES_IDLE, MIN_TURNS, DEFAULT_TURNS, simulate, card, hintLine, roundHalfEven,
  parseTokens, thresholdFromWindow, lastAutoCompact, firstCallTokens, historyThreshold, profile };
