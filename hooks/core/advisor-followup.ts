// One-week check after an apply (design "First analysis -> apply -> one-week check -> fine-tune"). Deterministic, no model.
// advisor/applied/<apply-id>.json holds numbers and config keys only: the apply time, the changed items and the BEFORE
// baseline of each rule's metrics. check() computes AFTER over the days since the apply and judges each rule.
import { joinPath } from './text.ts';
import * as apply from './advisor-apply.ts';
import * as metrics from './advisor-metrics.ts';
import * as st from './advisor-screen-text.ts';
import { ADVISOR_DEFAULTS } from './advisor-defaults.ts';
import { DAY, readJson, writeJson, randomHex, dataDir, type AdvisorCtx } from './advisor-io.ts';

export const MIN_DAYS = 5;
export const CHECK_AFTER_DAYS = 7;
const NEAR = 0.25; // rule evidence within +-25% of the threshold counts as "near"
export const appliedDir = (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'applied');
const pendingFile = (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'pending.json');
const baselineFile = (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'baseline.json');
const ID_RE = /^[A-Za-z0-9-]{1,40}$/;

// Called by apply.apply after a successful write. items: the applied items; analysis: the analysis the user approved from.
export async function record(ctx: AdvisorCtx, entry: { id: string; at: string; items: any[]; analysis: any }): Promise<any> {
  if (!ID_RE.test(String(entry.id))) return null;
  const items = entry.items.map((i) => ({ rule: i.rule, file: i.file, key: i.key, before: i.before, after: i.after, hadKey: !!i.hadKey }));
  const rules = Array.from(new Set(items.map((i) => i.rule)));
  const rec = { schema: 1, id: entry.id, applied_at: entry.at, checked_at: null as string | null, rules, keys: Array.from(new Set(items.map((i) => i.key))), items,
    baseline: entry.analysis ? metrics.baselineFor(entry.analysis, rules) : {} };
  await writeJson(ctx.io, joinPath(appliedDir(ctx), entry.id + '.json'), rec);
  return rec;
}

export async function readApplied(ctx: AdvisorCtx, id: string): Promise<any> {
  return ID_RE.test(String(id)) ? readJson(ctx.io, joinPath(appliedDir(ctx), id + '.json'), null) : null;
}
export async function listApplied(ctx: AdvisorCtx): Promise<any[]> {
  const ents = (await ctx.io.list(appliedDir(ctx))) || [];
  const out: any[] = [];
  for (const e of ents) {
    if (e.kind !== 'file' || !/\.json$/.test(e.name)) continue;
    const x: any = await readJson(ctx.io, joinPath(appliedDir(ctx), e.name), null);
    if (x && x.id && x.applied_at) out.push(x);
  }
  return out.sort((a, b) => (a.applied_at < b.applied_at ? -1 : a.applied_at > b.applied_at ? 1 : 0));
}
export const dueList = async (ctx: AdvisorCtx, now: number) => (await listApplied(ctx)).filter((a) => !a.checked_at && Date.parse(a.applied_at) + CHECK_AFTER_DAYS * DAY <= now);

async function isReverted(ctx: AdvisorCtx, id: string): Promise<boolean> {
  return (await apply.readLog(ctx)).some((e) => e.reverts === id && e.complete === true);
}

function defaultOf(ctx: AdvisorCtx, key: string): any {
  if (Object.prototype.hasOwnProperty.call(ctx.cfgDefaults || {}, key)) return ctx.cfgDefaults[key];
  return Object.prototype.hasOwnProperty.call(ADVISOR_DEFAULTS, key) ? ADVISOR_DEFAULTS[key] : null;
}

const show = (v: any) => apply.show(v);
function rowsFor(kind: string, ev: any, rule: string): any {
  const out: any = {};
  for (const lang of ['en', 'ko']) {
    const f = st.tr(lang).follow;
    out[lang] = kind === 'revert'
      ? { item: f.revertItem(rule), current: ev.cur, recommended: ev.rec, evidence: f.revertEv(ev), effect: f.revertEff }
      : { item: f.thresholdItem, current: ev.cur, recommended: ev.rec, evidence: f.thresholdEv(ev), effect: f.thresholdEff };
  }
  return out;
}

// Fine-tune proposals as ordinary Recommendations (risk A, with `changes`); the user approves each one.
export function proposalsFor(ctx: AdvisorCtx, applied: any, items: any[], min: number): any[] {
  const out: any[] = [];
  let tuned = false;
  for (const it of items) {
    if (it.verdict === 'no_effect' || it.verdict === 'worse') {
      const changes = applied.items.filter((i: any) => i.rule === it.rule).map((i: any) => ({ file: i.file, key: i.key, before: i.after, after: i.hadKey ? i.before : (i.file === 'settings' ? null : defaultOf(ctx, i.key)) }));
      if (!changes.length) continue;
      out.push({ id: 'UNDO-' + it.rule, rule: it.rule, kind: 'revert', title: 'Undo ' + it.rule + ' change', risk: 'A', target: changes.some((c: any) => c.file === 'settings') ? 'settings' : 'config', changes,
        evidence: { verdict: it.verdict, pct: it.pct, apply_id: applied.id }, effect: { lo: 0, hi: 0, unit: 'usd_per_week' }, confirmed: true,
        text: rowsFor('revert', { verdict: st.tr('en').check.verdicts[it.verdict], pct: it.pct, cur: changes.map((c: any) => show(c.before)).join(', '), rec: changes.map((c: any) => show(c.after)).join(', ') }, it.rule) });
      // the Korean row names the verdict in Korean
      out[out.length - 1].text.ko.evidence = st.tr('ko').follow.revertEv({ verdict: st.tr('ko').check.verdicts[it.verdict], pct: it.pct });
    } else if (it.verdict === 'improved' && !tuned && min > 0 && Math.abs(it.after_usd_week - min) / min <= NEAR) {
      tuned = true;
      const after = Math.ceil(min * 1.5);
      out.push({ id: 'TUNE-' + it.rule, rule: it.rule, kind: 'threshold', title: 'Effect threshold', risk: 'A', target: 'config',
        changes: [{ file: 'config', key: 'advisorMinEffectUsd', before: min, after }],
        evidence: { left_usd: it.after_usd_week, min, apply_id: applied.id }, effect: { lo: 0, hi: 0, unit: 'usd_per_week' }, confirmed: true,
        text: rowsFor('threshold', { left: it.after_usd_week, min, cur: String(min), rec: String(after) }, it.rule) });
    }
  }
  return out;
}

export async function addToPending(ctx: AdvisorCtx, recs: any[], now: number): Promise<void> {
  if (!recs.length) return;
  const cur: any = await readJson(ctx.io, pendingFile(ctx), null);
  const base = cur && Array.isArray(cur.items) ? cur : { id: 'pd-' + randomHex(6), created: new Date(now).toISOString(), items: [], shownAt: null, autoApplied: [], auto: [], notes: [] };
  const have = new Set(base.items.map((r: any) => r.id));
  for (const r of recs) if (!have.has(r.id)) base.items.push(r);
  await writeJson(ctx.io, pendingFile(ctx), base);
}

async function saveBaseline(ctx: AdvisorCtx, afters: Record<string, any>, now: number): Promise<void> {
  const b: any = (await readJson(ctx.io, baselineFile(ctx), {})) || {};
  b.metrics = Object.assign({}, b.metrics);
  for (const r of Object.keys(afters)) b.metrics[r] = Object.assign({ at: new Date(now).toISOString() }, afters[r]);
  await writeJson(ctx.io, baselineFile(ctx), b);
}

// opts: {id (default: oldest unchecked), now (ms), gather (async fn like run.gather), min (advisorMinEffectUsd), dir, settings, lang}
export async function check(ctx: AdvisorCtx, opts: { id?: string; force?: boolean; now?: number; gather: (o: any) => Promise<any>; min?: number; dir?: string | null; settings?: string | null; lang?: string | null }): Promise<any> {
  const now = opts.now || ctx.nowMs;
  const list = await listApplied(ctx);
  const applied = opts.id ? await readApplied(ctx, opts.id) : list.filter((a) => !a.checked_at)[0];
  if (!applied) return { status: 'none' };
  const file = joinPath(appliedDir(ctx), applied.id + '.json');
  if (applied.checked_at && !opts.force) return applied.result === 'reverted' ? { status: 'reverted', id: applied.id } : { status: 'checked', id: applied.id, result: applied.result || {} };
  if (await isReverted(ctx, applied.id)) {
    // a fully reverted apply has nothing to judge: close it so it leaves the default target and the due list
    applied.checked_at = new Date(now).toISOString();
    applied.result = 'reverted';
    try { await writeJson(ctx.io, file, applied); } catch { /* read-only home: the status is still right */ }
    return { status: 'reverted', id: applied.id };
  }
  const days = Math.floor((now - Date.parse(applied.applied_at)) / DAY);
  if (days < MIN_DAYS) return { status: 'too_early', id: applied.id, days: Math.max(0, days) };
  const min = typeof opts.min === 'number' ? opts.min : ADVISOR_DEFAULTS.advisorMinEffectUsd;
  const g = await opts.gather({ days: Math.min(30, days), dir: opts.dir || null, settings: opts.settings || null, lang: opts.lang || null, now, save: false, json: false });
  const w = g.all.windows.d30;
  const items: any[] = [];
  const afters: Record<string, any> = {};
  for (const rule of applied.rules) {
    const before = applied.baseline && applied.baseline[rule];
    const after = metrics.forRule(rule, w);
    if (!before || !after) continue;
    const v: any = metrics.verdict(rule, before, after, min);
    afters[rule] = after;
    items.push({ rule, verdict: v.verdict, pct: v.pct, effect_usd: v.effect_usd, calls: after.calls, before: before.metrics, after: after.metrics, after_usd_week: after.usd_week });
  }
  // an UNDO / TUNE the user already applied is not proposed again (only possible with --force)
  const proposals = proposalsFor(ctx, applied, items, min).filter((p) => !(p.kind === 'revert' && applied.undone_at) && !(p.kind === 'threshold' && applied.tuned_at));
  await addToPending(ctx, proposals, now);
  await saveBaseline(ctx, afters, now);
  applied.checked_at = new Date(now).toISOString();
  applied.result = {};
  for (const i of items) applied.result[i.rule] = i.verdict;
  await writeJson(ctx.io, file, applied);
  return { status: 'ok', id: applied.id, days, items, proposals };
}

// An UNDO-* / TUNE-* proposal was applied: stamp the original apply record (kind: 'revert' | 'threshold').
export async function markFollowUp(ctx: AdvisorCtx, applyId: string, kind: string, now: number): Promise<boolean> {
  const a = await readApplied(ctx, applyId);
  if (!a) return false;
  a[kind === 'revert' ? 'undone_at' : 'tuned_at'] = new Date(now).toISOString();
  await writeJson(ctx.io, joinPath(appliedDir(ctx), a.id + '.json'), a);
  return true;
}

export function render(lang: string, res: any): string[] {
  const t = st.tr(lang).check;
  if (res.status === 'none') return [t.none];
  if (res.status === 'reverted') return [t.reverted(res.id)];
  if (res.status === 'checked') return [t.checked(res.id)];
  if (res.status === 'too_early') return [t.early(res.days)];
  const out = [t.title(res.id, res.days)];
  for (const it of res.items) {
    out.push(t.item(it.rule, t.verdicts[it.verdict], it.calls));
    for (const k of Object.keys(it.before)) out.push(t.metric(t.names[k] || k, it.before[k], it.after[k], (metrics as any).change(it.before[k], it.after[k])));
  }
  if (res.proposals.length) out.push(t.proposals(res.proposals.length));
  return out;
}
