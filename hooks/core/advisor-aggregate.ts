// Pure: scan records -> Analysis (design section 4.2). No I/O, no clock unless opts.now is missing.
// Deterministic: fixed key order, sorted ties, numbers rounded to 6 decimals.
import * as pricing from './advisor-pricing.ts';

const DAY = 86400000;
const BANDS = ['<50k', '50-100k', '100-200k', '200-300k', '300-500k', '>=500k'];
const CAUSES = ['first', 'ttl_5m', 'idle_1h', 'compaction', 'prefix_change', 'small'];
const CLASSES = ['judgment', 'implementation', 'simple', 'unknown'];
const CAP_CANDIDATES = [300000, 400000, 600000];
const COMPACT_SUMMARY = 20000; // summary size written after a compaction (same constant as clear-savings SUMMARY)
const UPPER = ['opus', 'fable'];

const bandOf = (ctx) => (ctx < 50000 ? BANDS[0] : ctx < 100000 ? BANDS[1] : ctx < 200000 ? BANDS[2] : ctx < 300000 ? BANDS[3] : ctx < 500000 ? BANDS[4] : BANDS[5]);
const parts0 = () => ({ read: 0, w5: 0, w1: 0, input: 0, output: 0 });
const addParts = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k] || 0; };
const tokensOf = (c) => c.input + c.read + c.w5 + c.w1 + c.output;

function roundDeep(x) {
  if (typeof x === 'number') return Math.round(x * 1e6) / 1e6;
  if (Array.isArray(x)) return x.map(roundDeep);
  if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = roundDeep(x[k]); return o; }
  return x;
}
function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const cmpKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// What a lower auto-compact point would do to the main-session calls (crude, see rules.js R3).
function capSim(mainCalls, cap) {
  const state = new Map();
  let save = 0, cost = 0, extra = 0, over = 0;
  for (const c of mainCalls) {
    const row = pricing.priceOf(c.model).row;
    let s = state.get(c.fileKey);
    if (!s) { s = { prev: 0, shift: 0 }; state.set(c.fileKey, s); }
    if (s.prev && c.ctx < 0.7 * s.prev) s.shift = 0; // the session really compacted or cleared: start over
    s.prev = c.ctx;
    if (c.ctx > cap) { save += (c.ctx - cap) * row.read / 1e6; over++; }
    if (c.ctx - s.shift > cap) {
      extra++;
      cost += (cap * row.read + COMPACT_SUMMARY * row.output) / 1e6;
      s.shift = c.ctx - COMPACT_SUMMARY;
    }
  }
  return { save_usd: save, cost_usd: cost, extra_compactions: extra, calls_over: over };
}

// scan: ScanResult; opts: {days, now (ms), device, hints, end (ms)}. Returns one window.
function analyze(scan, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const days = opts.days || 7;
  const start = now - days * DAY;
  const all = (scan.calls || []).filter((c) => c.t >= start && c.t <= now);
  const priced = all.filter((c) => c.priced);

  const totals = { usd: 0, calls: 0, tokens: 0, parts: parts0() };
  const byFamily = {};
  const roles = { main: { usd: 0, calls: 0, parts: parts0(), sessions: 0, ctx_mean: 0 }, sub: { usd: 0, calls: 0, agents: 0, share: 0 } };
  const ctxBands = {};
  for (const b of BANDS) ctxBands[b] = { usd: 0, calls: 0 };
  const rewrite = {};
  for (const k of CAUSES) rewrite[k] = { usd: 0, n: 0, main_usd: 0, sub_usd: 0 };
  const byClass = {};
  for (const k of CLASSES) byClass[k] = { usd: 0, n: 0, upper_usd: 0, upper_no_model_usd: 0, upper_explicit_usd: 0 };
  const classAgents = {};
  for (const k of CLASSES) classAgents[k] = new Set();
  const subAgents = new Set();
  const mainSess = new Set();
  let mainCtx = 0;
  const subFirst = new Map(); // fileKey -> first call in the window
  let ttl5 = 0;
  const oldModels = { usd: 0, calls: 0, sessions: 0, save_hi_usd: 0, unpriced_calls: 0, unpriced_tokens: 0 };
  const oldSessions = new Set();
  const sess = new Map();
  const agents = new Map();
  const famTier = {};

  for (const c of priced) {
    const writeUsd = c.usdParts.w5 + c.usdParts.w1;
    totals.usd += c.usd; totals.calls++; totals.tokens += tokensOf(c); addParts(totals.parts, c.usdParts);
    const f = byFamily[c.family] || (byFamily[c.family] = { usd: 0, calls: 0, tokens: 0, parts: parts0(), main_usd: 0, sub_usd: 0, tier: null });
    f.usd += c.usd; f.calls++; f.tokens += tokensOf(c); addParts(f.parts, c.usdParts);
    if (c.isSub) f.sub_usd += c.usd; else f.main_usd += c.usd;
    (famTier[c.family] || (famTier[c.family] = new Set())).add(c.tier);
    const role = c.isSub ? roles.sub : roles.main;
    role.usd += c.usd; role.calls++;
    if (!c.isSub) { addParts(roles.main.parts, c.usdParts); mainSess.add(c.sessionKey); mainCtx += c.ctx; }
    const band = ctxBands[bandOf(c.ctx)]; band.usd += c.usd; band.calls++;
    const rw = rewrite[c.cause]; rw.usd += writeUsd; rw.n++;
    if (c.isSub) rw.sub_usd += writeUsd; else rw.main_usd += writeUsd;

    if (c.tier === 'old') {
      oldModels.usd += c.usd; oldModels.calls++; oldSessions.add(c.sessionKey);
      const cur = pricing.currentRow(c.family);
      if (cur) oldModels.save_hi_usd += Math.max(0, c.usd - pricing.usdOf(cur, c));
    }

    let s = sess.get(c.sessionKey);
    if (!s) { s = { key: c.sessionKey, usd: 0, sub_usd: 0, calls: 0, max_ctx: 0, minT: c.t, maxT: c.t, fams: new Set() }; sess.set(c.sessionKey, s); }
    s.usd += c.usd; s.calls++; s.fams.add(c.family); s.minT = Math.min(s.minT, c.t); s.maxT = Math.max(s.maxT, c.t);
    if (c.isSub) s.sub_usd += c.usd; else s.max_ctx = Math.max(s.max_ctx, c.ctx);

    if (c.isSub) {
      subAgents.add(c.fileKey);
      const cls = CLASSES.includes(c.descriptionClass) ? c.descriptionClass : 'unknown';
      const bc = byClass[cls];
      bc.usd += c.usd; classAgents[cls].add(c.fileKey);
      if (UPPER.includes(c.family)) {
        bc.upper_usd += c.usd;
        if (c.explicitModel === false) bc.upper_no_model_usd += c.usd;
        else if (c.explicitModel === true) bc.upper_explicit_usd += c.usd;
      }
      if (c.cause === 'ttl_5m') ttl5 += writeUsd;
      if (!subFirst.has(c.fileKey)) subFirst.set(c.fileKey, c);
      let a = agents.get(c.fileKey);
      if (!a) { a = { key: c.fileKey, usd: 0, calls: 0, cls, fam: {} }; agents.set(c.fileKey, a); }
      a.usd += c.usd; a.calls++; a.fam[c.family] = (a.fam[c.family] || 0) + c.usd;
    }
  }
  for (const k of CLASSES) byClass[k].n = classAgents[k].size;
  for (const fam of Object.keys(byFamily)) {
    const t = famTier[fam];
    byFamily[fam].tier = t.size === 1 ? Array.from(t)[0] : 'mixed';
  }
  roles.main.sessions = mainSess.size;
  roles.main.ctx_mean = roles.main.calls > 0 ? mainCtx / roles.main.calls : 0;
  roles.sub.agents = subAgents.size;
  roles.sub.share = totals.usd > 0 ? roles.sub.usd / totals.usd : 0;
  // old models without a price row (e.g. sonnet-4-5): counted by family and version, never priced
  for (const c of all) {
    if (c.priced || c.tier !== 'old') continue;
    oldModels.calls++; oldModels.unpriced_calls++; oldModels.unpriced_tokens += c.ctx + c.output; oldSessions.add(c.sessionKey);
  }
  oldModels.sessions = oldSessions.size;

  const sortedFam = {};
  for (const k of Object.keys(byFamily).sort()) sortedFam[k] = byFamily[k];

  const topSessions = Array.from(sess.values()).sort((a, b) => b.usd - a.usd || cmpKey(a.key, b.key)).slice(0, 10).map((s) => ({
    key: s.key, usd: s.usd, sub_usd: s.sub_usd, calls: s.calls, max_ctx: s.max_ctx, span_h: (s.maxT - s.minT) / 3600000, families: Array.from(s.fams).sort(),
  }));
  const topSubagents = Array.from(agents.values()).sort((a, b) => b.usd - a.usd || cmpKey(a.key, b.key)).slice(0, 10).map((a) => ({
    key: a.key, usd: a.usd, family: Object.keys(a.fam).sort((x, y) => a.fam[y] - a.fam[x] || cmpKey(x, y))[0], class: a.cls, calls: a.calls,
  }));

  const mainPriced = priced.filter((c) => !c.isSub);
  const caps = {};
  for (const cap of CAP_CANDIDATES) caps[cap] = capSim(mainPriced, cap);

  const unpriced = {};
  for (const c of all) {
    if (c.priced) continue;
    const k = pricing.strip(c.model) || 'unknown';
    const u = unpriced[k] || (unpriced[k] = { calls: 0, tokens: 0 });
    u.calls++; u.tokens += c.ctx + c.output;
  }
  const sortedUnpriced = {};
  for (const k of Object.keys(unpriced).sort()) sortedUnpriced[k] = unpriced[k];

  let minT = Infinity, maxT = -Infinity;
  for (const c of priced) { if (c.t < minT) minT = c.t; if (c.t > maxT) maxT = c.t; }
  const inWin = (e) => e.t >= start && e.t <= now;
  let auto = 0, manual = 0;
  for (const e of scan.compactEvents || []) if (inWin(e)) { if (e.trigger === 'manual') manual++; else auto++; }
  const agentEv = (scan.agentEvents || []).filter(inWin);
  const h = opts.hints || {};

  return roundDeep({
    schema: 1, generated: new Date(now).toISOString(), period: { days, start: new Date(start).toISOString(), end: new Date(now).toISOString() },
    source: 'local', device: opts.device || null,
    span_days: priced.length ? (maxT - minT) / DAY : 0,
    totals, byFamily: sortedFam, roles, ctxBands, rewrite,
    subagents: { byClass, ttl_5m_usd: ttl5, median_first_ctx: median(Array.from(subFirst.values()).map((c) => c.ctx)) },
    agentCalls: { total: agentEv.length, withModel: agentEv.filter((e) => e.hasModel).length },
    oldModels,
    compaction: { auto, manual, hint_events: h.hint_events || 0, hint_followed: h.hint_followed || 0, hint_saving_usd: h.hint_saving_usd || 0,
      hint_line_usd: h.line_usd || 0, hint_overhead_usd: h.overhead_usd || 0 },
    capSim: caps,
    topSessions, topSubagents,
    unpriced: sortedUnpriced, skipped: { files: (scan.skipped_files || 0), lines: (scan.skipped_lines || 0) },
    pricing: { date: pricing.PRICING_DATE, source: pricing.PRICING_SOURCE },
  });
}

// Both windows of one run. range = analysis days (min(30, cleanupPeriodDays) or --days). hintsFor(days) -> hints | null.
function buildAll(scan, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const range = Math.max(1, Math.floor(opts.range || 30));
  const mk = (days) => analyze(scan, { days, now, device: opts.device, hints: opts.hintsFor ? opts.hintsFor(days) : opts.hints });
  const d7 = mk(Math.min(7, range));
  const d30 = range === d7.period.days ? d7 : mk(range);
  return { schema: 1, generated: new Date(now).toISOString(), device: opts.device || null, range: { days: range }, sufficiency: sufficiency(d30), windows: { d7, d30 } };
}

// Section 6.4: any one of span < 3 days, priced calls < 200, priced total < $5 means too little data.
function sufficiency(win) {
  const calls = win.totals.calls, days = win.span_days, usd = win.totals.usd;
  const reasons = [];
  if (days < 3) reasons.push('span');
  if (calls < 200) reasons.push('calls');
  if (usd < 5) reasons.push('usd');
  return { ok: reasons.length === 0, calls, days: Math.round(days * 10) / 10, usd: Math.round(usd * 100) / 100, reasons };
}
export { analyze, buildAll, sufficiency, capSim, bandOf, roundDeep, BANDS, CAUSES, CLASSES, CAP_CANDIDATES, COMPACT_SUMMARY };
