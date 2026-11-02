// Pure: Analysis + config + settings env -> Recommendation[] (design section 5). No I/O, no LLM.
// Conditions use the 7-day window; the 30-day window only confirms (`confirmed`). Money is USD API-equivalent per
// week (windows shorter than 7 days are scaled to a week).
import * as pricing from './advisor-pricing.ts';
import * as agg from './advisor-aggregate.ts';
import * as text from './advisor-text.ts';
import { parseTokens } from './clear-savings.ts';
import { ADVISOR_DEFAULTS } from './advisor-defaults.ts';
import { lowerBound } from './advisor-screen-text.ts';

const DEFAULT_MIN_EFFECT = ADVISOR_DEFAULTS.advisorMinEffectUsd;
const K_LO = 2, K_HI = 8; // same two k values as clear-savings.simulate; see capNet
const COMPACT_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const r2 = (x) => Math.round(x * 100) / 100;

// cleanupPeriodDays from a parsed settings.json: default 30 when absent or invalid. Analysis range = min(30, it).
function periodDays(settings) {
  const v = settings && settings.cleanupPeriodDays;
  const m = typeof v === 'number' && isFinite(v) && v >= 1 ? Math.floor(v) : 30;
  return { cleanup: m, range: Math.min(30, m) };
}

function windowsOf(analysis) {
  if (analysis && analysis.windows) return { w7: analysis.windows.d7, w30: analysis.windows.d30 || null };
  return { w7: analysis, w30: null };
}
const scaleOf = (w) => 7 / Math.max(1, w.period.days);

// What the net effect of a lower compaction cap is. The measured over-cap read saving (every over-cap call re-reads
// less) is the k=8 end; k=2 assumes only 2/8 of those calls really re-read the dropped context. The cost of the extra
// compactions (summary output plus one re-read of the cap) is the same at both ends.
function capNet(sim, sc) {
  const hi = sim.save_usd * sc, lo = hi * K_LO / K_HI, cost = sim.cost_usd * sc;
  return { saveLo: lo, saveHi: hi, cost, netLo: lo - cost, netHi: hi - cost };
}

const confOf = (fn, w30) => (w30 ? !!fn(w30, scaleOf(w30)) : false);

// ---- per-rule evaluation: (window, scale, ctx) -> proposal fragment or null
function r1(w, sc, ctx) {
  const cfg = ctx.cfg;
  if (cfg.agentModelDefault === 'sonnet' || cfg.agentModelDefault === 'haiku') return null;
  const bc = w.subagents.byClass;
  const impl = bc.implementation, simple = bc.simple;
  const total = w.totals.usd * sc;
  const uImpl = impl.upper_no_model_usd * sc;
  if (!(uImpl >= Math.max(20, 0.05 * total))) return null;
  const upperAll = Object.keys(bc).reduce((s, k) => s + bc[k].upper_usd, 0);
  const upperLow = impl.upper_usd + simple.upper_usd;
  if (!(upperAll > 0 && upperLow / upperAll >= 0.5)) return null;
  const u = (impl.upper_no_model_usd + simple.upper_no_model_usd) * sc;
  const alt = upperLow > 0 && simple.upper_usd / upperLow >= 0.6 && !!pricing.currentRow('haiku');
  const noModel = w.agentCalls && w.agentCalls.total > 0 ? (w.agentCalls.total - w.agentCalls.withModel) / w.agentCalls.total
    : (upperAll > 0 ? Object.keys(bc).reduce((s, k) => s + bc[k].upper_no_model_usd, 0) / upperAll : 1);
  return { u, alt, noModel, lo: 0.5 * u, hi: 0.8 * u };
}

// R1b: implementation/simple subagents on opus/fable that DID name a model (R1 only reaches unnamed calls).
function r1b(w, sc, ctx) {
  const cfg = ctx.cfg;
  const bc = w.subagents.byClass;
  const u = ((bc.implementation.upper_explicit_usd || 0) + (bc.simple.upper_explicit_usd || 0)) * sc;
  if (!(u >= Math.max(20, 0.05 * w.totals.usd * sc))) return null;
  const pressure = cfg.explicitDowngradePressure === 'always' ? 'always' : 'pace';
  const mode = cfg.explicitDowngrade === undefined || cfg.explicitDowngrade === null ? 'off' : (cfg.explicitDowngrade === 'inject' || cfg.explicitDowngrade === 'suggest' ? cfg.explicitDowngrade : 'off');
  const changes = [];
  if (pressure !== 'always') changes.push({ file: 'config', key: 'explicitDowngradePressure', before: pressure, after: 'always' });
  if (mode !== 'inject') changes.push({ file: 'config', key: 'explicitDowngrade', before: cfg.explicitDowngrade === undefined ? null : cfg.explicitDowngrade, after: 'inject' });
  if (!changes.length) return null;
  const ac = w.agentCalls;
  const share = ac && ac.total > 0 ? ac.withModel / ac.total : 1;
  const marks = Array.isArray(cfg.keepModelMarker) ? cfg.keepModelMarker.filter((m) => typeof m === 'string' && m) : [];
  return { changes, u, share, marker: marks.length ? marks[0] : 'keep-model', pressure, mode, lo: 0.5 * u, hi: 0.8 * u };
}

function r2f(w, sc, ctx) {
  const cfg = ctx.cfg, c = w.compaction, min = ctx.min;
  const hs = c.hint_saving_usd * sc;
  if (!(c.hint_events >= 1)) return null; // no hints recorded on this device: nothing to quiet down
  const lowFollow = c.hint_events >= 15 && c.hint_followed / c.hint_events < 0.2;
  if (!(hs < min || lowFollow)) return null;
  const cur = { hintTrigger: cfg.hintTrigger || 'always', topicCheck: cfg.topicCheck !== false, hintMinEffectTokens: Number(cfg.hintMinEffectTokens) || 0 };
  const changes = [];
  if (cur.hintTrigger !== 'gap') changes.push({ file: 'config', key: 'hintTrigger', before: cur.hintTrigger, after: 'gap' });
  if (cur.topicCheck !== false) changes.push({ file: 'config', key: 'topicCheck', before: cur.topicCheck, after: false });
  if (cur.hintMinEffectTokens < 100000) changes.push({ file: 'config', key: 'hintMinEffectTokens', before: cur.hintMinEffectTokens, after: 100000 });
  if (!changes.length) return null;
  return { changes, current: cur.hintTrigger, events: Math.round(c.hint_events * sc), followedPct: c.hint_events ? c.hint_followed / c.hint_events : 0,
    saved: hs, lo: 0, hi: (c.hint_line_usd + c.hint_overhead_usd) * sc,
    fewer: Math.max(0, Math.round((c.hint_events - c.hint_followed) * sc)) }; // estimate: gap mode keeps roughly the hints that were followed
}

function r3(w, sc, ctx) {
  const curWin = parseTokens(ctx.env[COMPACT_KEY]);
  const cands = agg.CAP_CANDIDATES.filter((cap) => (!curWin || cap < curWin) && w.capSim && w.capSim[cap]);
  let best = null;
  for (const cap of cands) {
    if (!w.capSim || !w.capSim[cap]) continue;
    const n = capNet(w.capSim[cap], sc);
    if (!best || n.netLo > best.n.netLo || (n.netLo === best.n.netLo && cap > best.cap)) best = { cap, n };
  }
  const label = curWin ? text.kTok(curWin) : 'default';
  const propose = !!best && best.n.netLo >= ctx.min;
  return { propose, cap: best ? best.cap : null, curWin, label, best: best ? best.n : null,
    saveHi: best ? best.n.saveHi : 0, lo: best ? Math.max(0, best.n.netLo) : 0, hi: best ? Math.max(0, best.n.netHi) : 0 };
}

function r4(w, sc, ctx) {
  const t = w.subagents.ttl_5m_usd * sc;
  if (!(t >= 10) || (ctx.cfg.subagentWaitAdvice === true && ctx.cfg.subagentLongCmdAdvice === true)) return null;
  return { usd: t, lo: 0.5 * t, hi: t };
}

function r5(w, sc, ctx) {
  const o = w.oldModels.usd * sc;
  if (!(o >= 5) || ctx.cfg.oldModelWarn === true) return null;
  return { usd: o, sessions: w.oldModels.sessions, unpriced: Math.round((w.oldModels.unpriced_calls || 0) * sc), lo: 0, hi: (w.oldModels.save_hi_usd || 0) * sc };
}

function r6(w, sc, ctx) {
  const cfg = ctx.cfg;
  const idle = w.rewrite.idle_1h.main_usd * sc;
  if (!(idle >= 10)) return null;
  const gate = cfg.topicGate !== false;
  const gap = Number(cfg.idleGapSec) || 3600;
  const changes = [];
  if (!gate) changes.push({ file: 'config', key: 'topicGate', before: false, after: true });
  if (gap > 3600) changes.push({ file: 'config', key: 'idleGapSec', before: gap, after: 3600 });
  return { changes, usd: idle, idleGapSec: gap, gate };
}

function row(id, ev) { return { en: text.row('en', id, ev), ko: text.row('ko', id, ev) }; }

// evaluate -> { recs, insufficient }. analysis = buildAll result ({windows}) or a single window.
function evaluate(analysis, cfg, settingsEnv) {
  cfg = cfg || {};
  const env = settingsEnv || {};
  const { w7, w30 } = windowsOf(analysis);
  const suf = (analysis && analysis.sufficiency) || agg.sufficiency(w30 || w7);
  if (!suf.ok) return { recs: [], insufficient: suf };
  const min = typeof cfg.advisorMinEffectUsd === 'number' ? cfg.advisorMinEffectUsd : DEFAULT_MIN_EFFECT;
  const ctx = { cfg, env, min };
  const sc = scaleOf(w7);
  const recs = [];

  const a1 = r1(w7, sc, ctx);
  if (a1) {
    const cur = cfg.agentModelDefault || null;
    recs.push({ id: 'R1', rule: 'R1', title: 'Subagent default model', risk: 'B', target: 'config',
      changes: [{ file: 'config', key: 'agentModelDefault', before: cur, after: 'sonnet' }],
      alternative: a1.alt ? 'haiku' : null,
      note: 'CLAUDE_CODE_SUBAGENT_MODEL is not set by this; on Claude Code older than v2.1.251 that env var overrides explicit models.',
      evidence: { impl_upper_no_model_usd: r2(w7.subagents.byClass.implementation.upper_no_model_usd * sc), upper_no_model_usd: r2(a1.u), no_model_share: r2(a1.noModel), total_usd: r2(w7.totals.usd * sc) },
      effect: { lo: r2(a1.lo), hi: r2(a1.hi), unit: 'usd_per_week' }, confirmed: confOf((w, s) => r1(w, s, ctx), w30),
      text: row('R1', { currentLabel: cur || 'none', current: cur || 'none', recommended: 'sonnet', alt: a1.alt, u: a1.u, noModel: a1.noModel, lo: a1.lo, hi: a1.hi }) });
  }

  const a1b = r1b(w7, sc, ctx);
  if (a1b) {
    recs.push({ id: 'R1b', rule: 'R1b', title: 'Explicit upper-tier subagents', risk: 'B', target: 'config', changes: a1b.changes,
      note: 'Judgment words, the keep-model marker and a quick restart of the same task still keep the requested model.',
      evidence: { explicit_upper_usd: r2(a1b.u), explicit_model_share: r2(a1b.share), total_usd: r2(w7.totals.usd * sc), keep_model_marker: a1b.marker },
      effect: { lo: r2(a1b.lo), hi: r2(a1b.hi), unit: 'usd_per_week' }, confirmed: confOf((w, s) => r1b(w, s, ctx), w30),
      text: row('R1b', { current: a1b.pressure + ' / ' + a1b.mode, recommended: 'always / inject', u: a1b.u, share: a1b.share, marker: a1b.marker, lo: a1b.lo, hi: a1b.hi }) });
  }

  const a2 = r2f(w7, sc, ctx);
  if (a2) {
    // 25%+ of the transcript bytes were not read: whether the hints were followed cannot be told from the part that was, so R2 is
    // information only (no change to approve, never auto-applied; the screen marks it as a lower bound).
    const partial = !!(analysis && analysis.coverage && lowerBound(analysis.coverage));
    recs.push({ id: 'R2', rule: 'R2', title: 'Compact/clear hint frequency', risk: 'A', target: partial ? 'info' : 'config', changes: partial ? [] : a2.changes,
      evidence: Object.assign({ hint_events: a2.events, followed_share: r2(a2.followedPct), hint_saving_usd: r2(a2.saved) }, partial ? { lower_bound: true } : {}),
      effect: { lo: 0, hi: r2(a2.hi), unit: 'usd_per_week' }, confirmed: confOf((w, s) => r2f(w, s, ctx), w30),
      text: row('R2', { current: a2.current, recommended: 'gap', events: a2.events, followedPct: a2.followedPct, saved: a2.saved, fewer: a2.fewer, lo: 0, hi: a2.hi }) });
  }

  const a3 = r3(w7, sc, ctx);
  if (a3) {
    const base = { id: 'R3', rule: 'R3', title: 'Auto-compact point', risk: 'B' };
    if (a3.propose) {
      const cap = String(a3.cap);
      recs.push(Object.assign(base, { target: 'settings',
        changes: [{ file: 'settings', key: COMPACT_KEY, before: env[COMPACT_KEY] === undefined ? null : String(env[COMPACT_KEY]), after: cap },
          { file: 'config', key: 'compactWindowTokens', before: cfg.compactWindowTokens === undefined ? null : cfg.compactWindowTokens, after: a3.cap }],
        evidence: { cap: a3.cap, save_usd_lo: r2(a3.best.saveLo), save_usd_hi: r2(a3.best.saveHi), extra_compaction_cost_usd: r2(a3.best.cost) },
        effect: { lo: r2(a3.lo), hi: r2(a3.hi), unit: 'usd_per_week' },
        confirmed: confOf((w, s) => { const x = r3(w, s, ctx); return x.propose && x.cap === a3.cap; }, w30),
        text: row('R3', { current: a3.label, recommended: text.kTok(a3.cap), saveHi: a3.saveHi, lo: a3.lo, hi: a3.hi }) }));
    } else {
      recs.push(Object.assign(base, { target: 'info', changes: [],
        evidence: { best_cap: a3.cap, save_usd_hi_before_cost: r2(a3.saveHi) },
        effect: { lo: 0, hi: 0, unit: 'usd_per_week' }, confirmed: confOf((w, s) => !r3(w, s, ctx).propose, w30),
        text: row('R3', { current: a3.label, recommended: 'keep', saveHi: a3.saveHi, noEffect: true }) }));
    }
  }

  const a4 = r4(w7, sc, ctx);
  if (a4) {
    recs.push({ id: 'R4', rule: 'R4', title: 'Subagents left waiting', risk: 'A', target: 'config',
      changes: ['subagentWaitAdvice', 'subagentLongCmdAdvice'].filter((k) => ctx.cfg[k] !== true).map((k) => ({ file: 'config', key: k, before: false, after: true })),
      evidence: { ttl_5m_usd: r2(a4.usd) }, effect: { lo: r2(a4.lo), hi: r2(a4.hi), unit: 'usd_per_week' }, confirmed: confOf((w, s) => r4(w, s, ctx), w30),
      text: row('R4', { current: 'dash', recommended: 'warnOnce', usd: a4.usd, lo: a4.lo, hi: a4.hi }) });
  }

  const a5 = r5(w7, sc, ctx);
  if (a5) {
    recs.push({ id: 'R5', rule: 'R5', title: 'Old-model sessions', risk: 'A', target: 'config',
      changes: [{ file: 'config', key: 'oldModelWarn', before: ctx.cfg.oldModelWarn === true, after: true }],
      evidence: { old_models_usd: r2(a5.usd), sessions: a5.sessions, unpriced_calls: a5.unpriced }, effect: { lo: 0, hi: r2(a5.hi), unit: 'usd_per_week' }, confirmed: confOf((w, s) => r5(w, s, ctx), w30),
      text: row('R5', { current: 'dash', recommended: 'warnOnce', usd: a5.usd, sessions: a5.sessions, unpriced: a5.unpriced, lo: 0, hi: a5.hi }) });
  }

  const a6 = r6(w7, sc, ctx);
  if (a6) {
    const keep = a6.changes.length === 0;
    recs.push({ id: 'R6', rule: 'R6', title: 'Return after idle', risk: 'A', target: keep ? 'info' : 'config', changes: a6.changes,
      evidence: { idle_1h_main_usd: r2(a6.usd) }, effect: { lo: 0, hi: r2(a6.usd), unit: 'usd_per_week' }, confirmed: confOf((w, s) => r6(w, s, ctx), w30),
      text: row('R6', { current: a6.gate ? 'gateOn' : 'off', recommended: keep ? 'keep' : 'gateOn', idleGapSec: a6.idleGapSec, usd: a6.usd, lo: 0, hi: a6.usd }) });
  }
  if (analysis && analysis.partial) for (const r of recs) r.confirmed = false; // a partial scan never confirms
  return { recs, insufficient: null };
}

function recommend(analysis, cfg, settingsEnv) { return evaluate(analysis, cfg, settingsEnv).recs; }
export { recommend, evaluate, periodDays, capNet, COMPACT_KEY, DEFAULT_MIN_EFFECT, K_LO, K_HI };
