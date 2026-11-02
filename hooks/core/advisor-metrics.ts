// Pure: per-rule BEFORE/AFTER metrics of the one-week check (design "First analysis -> apply -> one-week check").
// Numbers only, normalized by volume (per 100 calls, shares, per session) so a busier or quieter week compares fairly.
// Every metric here is "lower is better"; the first key of a rule is the one the verdict uses.

const per100 = (x, n) => (n > 0 ? x / n * 100 : 0);
const div = (x, n) => (n > 0 ? x / n : 0);
const r6 = (x) => Math.round((Number(x) || 0) * 1e6) / 1e6;

const scaleOf = (w) => 7 / Math.max(1, w.period.days);
const implSimple = (w, k) => ['implementation', 'simple'].reduce((s, c) => s + ((w.subagents.byClass[c] && w.subagents.byClass[c][k]) || 0), 0);

const RULES = {
  R1: { keys: ['upper_share', 'usd_per_impl_agent'],
    calls: (w) => w.roles.sub.calls, usd: (w) => implSimple(w, 'upper_no_model_usd'),
    metrics: (w) => ({ upper_share: div(implSimple(w, 'upper_usd'), w.roles.sub.usd), usd_per_impl_agent: div(w.subagents.byClass.implementation.usd, w.subagents.byClass.implementation.n) }) },
  R4: { keys: ['ttl5_per100_sub_calls'],
    calls: (w) => w.roles.sub.calls, usd: (w) => w.subagents.ttl_5m_usd,
    metrics: (w) => ({ ttl5_per100_sub_calls: per100(w.rewrite.ttl_5m.sub_usd, w.roles.sub.calls) }) },
  R2: { keys: ['hints_per100_main_calls', 'follow_rate'],
    calls: (w) => w.roles.main.calls, usd: (w) => (w.compaction.hint_line_usd || 0) + (w.compaction.hint_overhead_usd || 0),
    metrics: (w) => ({ hints_per100_main_calls: per100(w.compaction.hint_events, w.roles.main.calls), follow_rate: div(w.compaction.hint_followed, w.compaction.hint_events) }) },
  R5: { keys: ['old_model_call_share'],
    calls: (w) => w.totals.calls, usd: (w) => w.oldModels.usd,
    metrics: (w) => ({ old_model_call_share: div(w.oldModels.calls, w.totals.calls) }) },
  R6: { keys: ['idle_1h_usd_per_session'], minCalls: 10, // its "calls" are sessions, which a light user has far fewer of than calls
    calls: (w) => w.roles.main.sessions || 0, usd: (w) => w.rewrite.idle_1h.main_usd,
    metrics: (w) => ({ idle_1h_usd_per_session: div(w.rewrite.idle_1h.main_usd, w.roles.main.sessions) }) },
  R3: { keys: ['mean_ctx', 'compactions_per100_main_calls'],
    calls: (w) => w.roles.main.calls, usd: (w) => (w.capSim && w.capSim[300000] ? w.capSim[300000].save_usd : 0),
    metrics: (w) => ({ mean_ctx: w.roles.main.ctx_mean || 0, compactions_per100_main_calls: per100((w.compaction.auto || 0) + (w.compaction.manual || 0), w.roles.main.calls) }) },
};
RULES.R1b = Object.assign({}, RULES.R1, { usd: (w) => implSimple(w, 'upper_explicit_usd') });

const MIN_CALLS = 30;
const known = (rule) => !!RULES[rule];

// One rule's numbers for one window: {metrics, calls (relevant calls), usd_week (what the rule is about, per week), days}.
function forRule(rule, w) {
  const r = RULES[rule];
  if (!r || !w) return null;
  const m = r.metrics(w);
  const out = {};
  for (const k of r.keys) out[k] = r6(m[k]);
  return { metrics: out, calls: r6(r.calls(w)), usd_week: r6(r.usd(w) * scaleOf(w)), days: w.period.days };
}

// analysis = buildAll result or one window. Returns {R1: {...}, ...} for the given rule ids (unknown ids skipped).
function baselineFor(analysis, ruleIds) {
  const w = analysis && analysis.windows ? analysis.windows.d7 : analysis;
  const out = {};
  if (!w || !w.period) return out;
  for (const id of ruleIds || []) { const x = forRule(id, w); if (x) out[id] = x; }
  return out;
}

// Relative change of the primary metric (negative = better). before = 0 and after > 0 counts as +100%.
function change(before, after) {
  if (!(before > 0)) return after > 0 ? 1 : 0;
  return (after - before) / before;
}

// before/after: forRule results. min = advisorMinEffectUsd. Verdicts: improved (>= 20% better), worse (>= 10% worse),
// no_effect (between, or the weekly money moved by less than min), unclear (< 30 relevant calls either side; R6 counts sessions, so 10).
function verdict(rule, before, after, min) {
  const r = RULES[rule];
  const k = r.keys[0];
  const pct = change(before.metrics[k], after.metrics[k]);
  const effect = before.usd_week - after.usd_week;
  let v;
  if (Math.min(before.calls, after.calls) < (r.minCalls || MIN_CALLS)) v = 'unclear';
  else if (pct >= 0.10) v = 'worse';
  else if (pct <= -0.20 && effect >= min) v = 'improved';
  else v = 'no_effect';
  return { verdict: v, pct: r6(pct), effect_usd: r6(effect) };
}
export { RULES, known, forRule, baselineFor, change, verdict };
