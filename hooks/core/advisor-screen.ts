// First analysis screen (design "First analysis -> apply -> one-week check"): pattern, top leaks, recommendations with a
// one-line why, the little-or-no-effect block, glossary. Pure and deterministic: numbers come from the analysis and price
// ratios from pricing.js (opts.table lets a test inject another price table). Every sentence is a template (screen-text.js).
import * as pricing from './advisor-pricing.ts';
import * as text from './advisor-text.ts';
import * as st from './advisor-screen-text.ts';
import { ADVISOR_DEFAULTS } from './advisor-defaults.ts';

export const WHY_KIND: Record<string, string> = { R1: 'sub', R1b: 'sub', R2: 'hints', R3: 'clear', R4: 'cache5', R5: 'old', R6: 'cache1' };
const r2 = (x: number) => Math.round(x * 100) / 100;
const scaleOf = (w: any) => 7 / Math.max(1, w.period.days);

// ---- facts for the why lines
export function whyFacts(w: any, table?: any) {
  const P = (a: string, part: string) => pricing.priceOfPart(a, part, table);
  const R = (a: string, b: string, part: string, partB?: string) => pricing.ratio(a, b, part, table, partB);
  const fams = Object.keys(w.byFamily || {}).filter((f) => pricing.rowOfRef(f, table)).sort((a: any, b: any) => w.byFamily[b].usd - w.byFamily[a].usd);
  const dom = fams[0] || 'opus';
  const f: any = {};
  const m = w.roles.main;
  if (m && m.parts && m.usd > 0 && m.parts.read / m.usd >= 0.4 && R('opus', 'sonnet', 'read') !== null) {
    const pa = P('opus', 'read'), pb = P('sonnet', 'read');
    f.main = { read: m.parts.read * scaleOf(w), total: m.usd * scaleOf(w), a: 'opus', b: 'sonnet', pa, pb, r: R('opus', 'sonnet', 'read'), same: Math.abs(pa - pb) < 1e-9 };
  }
  const upFam = ['fable', 'opus'].sort((a: any, b: any) => ((w.byFamily[b] || {}).sub_usd || 0) - ((w.byFamily[a] || {}).sub_usd || 0) || (a < b ? -1 : 1))[0];
  const n = R(upFam, 'sonnet', 'output');
  if (n !== null) f.sub = { a: upFam, b: 'sonnet', n, ia: P(upFam, 'input'), ib: P('sonnet', 'input'), oa: P(upFam, 'output'), ob: P('sonnet', 'output') };
  const k5 = R(dom, dom, 'write5', 'read'), k1 = R(dom, dom, 'write1', 'read');
  if (k5 !== null) f.cache5 = { k: k5 };
  if (k1 !== null) f.cache1 = { k: k1 };
  f.hints = { followed: w.compaction.hint_events ? w.compaction.hint_followed / w.compaction.hint_events : 0 };
  f.clear = { fixed: (w.subagents && w.subagents.median_first_ctx) || 0 };
  // old models: the family with the most money outside the current tier, price of its dearest old row vs the current row
  const oldFam = fams.filter((x: any) => w.byFamily[x].tier !== 'current')[0] || dom;
  const cur = pricing.rowOfRef(oldFam, table);
  let best: any = null;
  for (const key of Object.keys(table || pricing.TABLE)) {
    const row = (table || pricing.TABLE)[key];
    if (row.family === oldFam && row.tier === 'old' && (!best || row.read > best.read)) best = row;
  }
  if (cur && best && cur.read > 0 && best.read > cur.read) f.old = { family: oldFam, r: best.read / cur.read, pa: best.read, pb: cur.read };
  return f;
}

export function leaksOf(w: any, min: number) {
  const sc = scaleOf(w);
  const bc = w.subagents.byClass;
  const sum = (k: string) => ((bc.implementation[k] || 0) + (bc.simple[k] || 0)) * sc;
  const subUsd = w.roles.sub.usd;
  const c = [
    { id: 'upper_impl', usd: sum('upper_usd'), ev: { explicit: sum('upper_explicit_usd'), unnamed: sum('upper_no_model_usd') } },
    { id: 'ttl5_sub', usd: w.rewrite.ttl_5m.sub_usd * sc, ev: { n: Math.round(w.rewrite.ttl_5m.n * sc) } },
    { id: 'old_models', usd: w.oldModels.usd * sc, ev: { sessions: w.oldModels.sessions } },
    { id: 'idle_1h', usd: w.rewrite.idle_1h.main_usd * sc, ev: { n: Math.round(w.rewrite.idle_1h.n * sc) } },
    { id: 'fable_sub', usd: ((w.byFamily.fable || {}).sub_usd || 0) * sc, ev: { share: subUsd > 0 ? ((w.byFamily.fable || {}).sub_usd || 0) / subUsd : 0 } },
    { id: 'compaction', usd: w.rewrite.compaction.usd * sc, ev: { n: Math.round(w.rewrite.compaction.n * sc) } },
  ];
  return c.filter((x: any) => x.usd >= min).sort((a: any, b: any) => b.usd - a.usd || (a.id < b.id ? -1 : 1)).slice(0, 3).map((x: any) => ({ id: x.id, usd: r2(x.usd), evidence: x.ev }));
}

// A copy of a recommendation whose item cell carries the lower-bound mark (every language the row has).
function markLowerBound(r: any) {
  const marked: any = {};
  for (const l of Object.keys(r.text || {})) marked[l] = Object.assign({}, r.text[l], { item: r.text[l].item + st.covTable(l).mark });
  return Object.assign({}, r, { text: marked });
}

// all = buildAll result, ev = rules.evaluate result (not insufficient), cfg = merged config.
// opts: {lang, brief, table}. Returns the structure that `--json` prints (plus rendered strings in `lang`).
export function build(all: any, ev: any, cfg: any, opts?: any) {
  opts = opts || {};
  const lang = opts.lang || 'en';
  const t = st.tr(lang);
  const w = all.windows.d7;
  const sc = scaleOf(w);
  const min = typeof (cfg || {}).advisorMinEffectUsd === 'number' ? cfg.advisorMinEffectUsd : ADVISOR_DEFAULTS.advisorMinEffectUsd;
  const total = w.totals.usd * sc;
  const pattern = {
    usd: r2(total), main_usd: r2(w.roles.main.usd * sc), sub_usd: r2(w.roles.sub.usd * sc),
    mainShare: total > 0 ? r2(w.roles.main.usd / w.totals.usd) : 0, subShare: total > 0 ? r2(w.roles.sub.usd / w.totals.usd) : 0,
    read: r2(w.totals.parts.read * sc), write: r2((w.totals.parts.w5 + w.totals.parts.w1) * sc), output: r2(w.totals.parts.output * sc), input: r2(w.totals.parts.input * sc),
  };
  pattern.lines = [t.pattern1(pattern), t.pattern2(pattern)];

  const facts = whyFacts(w, opts.table);
  const whyOf = (kind: string) => (facts[kind] ? t.why[kind](facts[kind]) : null);

  const leaks = leaksOf(w, min).map((l: any) => ({ id: l.id, usd: l.usd, evidence: l.evidence, line: null }));
  leaks.forEach((l: any, i: number) => { l.line = t.leakLine(i + 1, t.leak[l.id].label, l.usd, t.leak[l.id].ev(l.evidence)); });

  const noEffect: any[] = [];
  const shown: any[] = [];
  const cov = all.coverage;
  const lb = !!cov && st.lowerBound(cov); // 25%+ of the bytes unread: R3 and R6 are lower bounds
  const cv = st.covTable(lang === 'ko' ? 'ko' : 'en');
  for (const r of ev.recs) {
    const real = r.target !== 'info' && r.changes && r.changes.length && (r.effect.hi >= min || r.rule === 'R2'); // R2 pays in fewer interruptions, not money
    if (real) { shown.push(lb && (r.rule === 'R3' || r.rule === 'R6') ? markLowerBound(r) : r); continue; }
    const c = (r.text && (r.text[lang] || r.text.en)) || {};
    let line: string;
    if (r.rule === 'R3') line = t.noEffect.R3({ cur: c.current, save: Math.max((r.evidence && r.evidence.save_usd_hi_before_cost) || 0, ...Object.keys(w.capSim || {}).map((k: string) => w.capSim[k].save_usd * sc)) });
    else if (r.rule === 'R2') line = t.noEffect.R2({ followed: w.compaction.hint_events ? w.compaction.hint_followed / w.compaction.hint_events : 0, saved: w.compaction.hint_saving_usd * sc });
    else if (r.rule === 'R6' && (!r.changes || !r.changes.length)) line = t.noEffect.R6({ usd: (r.evidence && r.evidence.idle_1h_main_usd) || 0 });
    else line = t.noEffect.generic({ item: c.item || r.title, min });
    if (lb && r.rule === 'R3') line += cv.keepReason;
    else if (lb && (r.rule === 'R6' || r.rule === 'R2')) line += cv.mark;
    noEffect.push({ rule: r.rule, line });
  }
  if (!ev.recs.some((r: any) => r.rule === 'R2') && w.compaction.hint_events >= 1) {
    noEffect.push({ rule: 'R2', line: t.noEffect.R2({ followed: w.compaction.hint_followed / w.compaction.hint_events, saved: w.compaction.hint_saving_usd * sc }) + (lb ? cv.mark : '') });
  }
  noEffect.sort((a: any, b: any) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  shown.sort((a: any, b: any) => b.effect.hi - a.effect.hi || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));

  const out: any = { pattern, leaks, recs: shown, noEffect };
  if (cov) out.coverage = cov; // only when the analysis carries it: without it the output is the Node build's
  if (!opts.brief) {
    const why: any = {};
    for (const r of shown) { const l = whyOf(WHY_KIND[r.rule]); if (l) why[r.rule] = l; }
    const mainWhy = facts.main ? t.why.main(facts.main) : null;
    if (mainWhy) why.main = mainWhy;
    out.why = why;
    out.glossary = t.glossary.slice();
  }
  return out;
}

// header/footer: arrays or strings from the caller. Returns lines.
export function render(lang: string, s: any, parts?: any) {
  parts = parts || {};
  const t = st.tr(lang);
  const tt = text.tbl(lang);
  const lines: any[] = [parts.header];
  if (s.coverage) lines.push(st.coverageLine(lang, s.coverage));
  lines.push('');
  lines.push(t.patternTitle, ...s.pattern.lines.map((l: any) => '  ' + l));
  if (s.why && s.why.main) lines.push('  ' + s.why.main);
  lines.push('', t.leaksTitle);
  if (s.leaks.length) for (const l of s.leaks) lines.push('  ' + l.line);
  else lines.push('  ' + t.leaksNone(parts.min));
  lines.push('', t.recsTitle);
  if (s.recs.length) lines.push(text.table(lang, s.recs, s.why));
  else lines.push(tt.noRecs);
  if (s.noEffect.length) { lines.push('', t.noEffectTitle); for (const n of s.noEffect) lines.push('  - ' + n.line); }
  if (s.glossary) { lines.push(''); for (const g of s.glossary) lines.push(g); }
  lines.push('', ...(parts.footer || []));
  return lines;
}

