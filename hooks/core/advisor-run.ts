// The advisor's commands (usage-advisor.js of the Node build, without the CLI, scheduler, export and merge):
// gather (scan + aggregate), analyze, recommend, review, reject, check, and the plan -> apply -> revert flow the
// advisor tool serves. Every function returns text (or a JSON-able object) and takes the context; register.ts only
// fills the context from `$` and returns what comes back.
import { joinPath } from './text.ts';
import * as scan from './advisor-scan.ts';
import * as aggregate from './advisor-aggregate.ts';
import * as rules from './advisor-rules.ts';
import * as text from './advisor-text.ts';
import * as apply from './advisor-apply.ts';
import * as hints from './advisor-hints.ts';
import * as snapshot from './advisor-snapshot.ts';
import * as weekly from './advisor-weekly.ts';
import * as screen from './advisor-screen.ts';
import * as followup from './advisor-followup.ts';
import { coverageLine } from './advisor-screen-text.ts';
import { ADVISOR_DEFAULTS } from './advisor-defaults.ts';
import { DAY, readJson, writeJson, randomHex, dataDir, cfgFile, defaultSettings, type AdvisorCtx } from './advisor-io.ts';

export const CACHE_MAX_AGE_MS = 3600000;
const latestFile = (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'analysis-latest.json');
const planFile = (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'plan.json');

// A keyword list from config, or the code default when the config value is missing or not an array.
const arr = (v: unknown, key: string): string[] => (Array.isArray(v) ? v : ADVISOR_DEFAULTS[key]);
const minEffect = (cfg: any) => (typeof cfg.advisorMinEffectUsd === 'number' ? cfg.advisorMinEffectUsd : ADVISOR_DEFAULTS.advisorMinEffectUsd);

export interface GatherOpts { lang?: string | null; settings?: string | null; days?: number | null; now?: number | null; dir?: string | null; noCache?: boolean; budgetSec?: number; save?: boolean; json?: boolean }

async function readSettingsObj(ctx: AdvisorCtx, p: string): Promise<any> {
  const st = await apply.readSettings(ctx, p);
  return st.ok && st.json && typeof st.json === 'object' ? st.json : {};
}

// Scan + aggregate for one command run. Returns everything the commands need.
export async function gather(ctx: AdvisorCtx, o: GatherOpts): Promise<any> {
  const cfg = ctx.cfg;
  const lang = o.lang || cfg.lang || 'en';
  const settingsPath = o.settings || defaultSettings(ctx);
  const settings = await readSettingsObj(ctx, settingsPath);
  const per = rules.periodDays(settings);
  const range = o.days && o.days > 0 ? Math.min(o.days, 365) : per.range;
  const now = o.now && isFinite(o.now) ? o.now : ctx.nowMs;
  const dir = o.dir || scan.defaultDir(ctx);
  const budgetMs = typeof o.budgetSec === 'number' && isFinite(o.budgetSec) && o.budgetSec >= 0 ? o.budgetSec * 1000 : undefined;
  const sc = await scan.scanProjects(ctx, { dir, sinceMs: now - range * DAY, untilMs: now, judgmentKeywords: arr(cfg.judgmentKeywords, 'judgmentKeywords'), simpleKeywords: arr(cfg.simpleKeywords, 'simpleKeywords'),
    implementationKeywords: arr(cfg.implementationKeywords, 'implementationKeywords'), cache: !o.noCache, budgetMs });
  const device = typeof cfg.advisorDevice === 'string' && snapshot.DEVICE_RE.test(cfg.advisorDevice) ? cfg.advisorDevice : null;
  // buildAll asks for hint numbers synchronously: fetch the two windows it uses first
  const hintBy = new Map<number, any>();
  for (const d of new Set([Math.min(7, range), range])) hintBy.set(d, await hints.hintStats(ctx, d, now, dir));
  const all = aggregate.buildAll(sc, { range, now, device, hintsFor: (days: number) => hintBy.get(days) || hints.EMPTY });
  all.cleanupPeriodDays = per.cleanup;
  all.partial = sc.partial; // null for a complete scan; {files_done, files_total} when the time budget cut it short
  all.coverage = sc.coverage; // transcript files over 4 MiB were counted, not read (decision 1)
  if (o.save !== false) { try { await writeJson(ctx.io, latestFile(ctx), all); } catch { /* read-only home: still answer */ } }
  return { cfg, lang, settings, settingsPath, per, all, scanInfo: { files: sc.files, truncated: sc.truncated, reread: sc.reread_files, cached: sc.cached_files } };
}

// apply/plan reuses a fresh analysis-latest.json (written by the analyze/recommend run the user just saw) to avoid a second scan.
export async function gatherForApply(ctx: AdvisorCtx, o: GatherOpts): Promise<any> {
  if (!o.dir && !o.days && !o.now) {
    const all: any = await readJson(ctx.io, latestFile(ctx), null);
    const ents = (await ctx.io.list(dataDir(ctx))) || [];
    const mt = (ents.find((e) => e.name === 'analysis-latest.json') || { mtimeMs: 0 }).mtimeMs;
    if (all && all.windows && ctx.nowMs - mt < CACHE_MAX_AGE_MS) {
      const settingsPath = o.settings || defaultSettings(ctx);
      const settings = await readSettingsObj(ctx, settingsPath);
      return { cfg: ctx.cfg, lang: o.lang || ctx.cfg.lang || 'en', settings, settingsPath, per: rules.periodDays(settings), all, cached: true };
    }
  }
  return gather(ctx, o);
}

export const recommendations = (g: any): any => rules.evaluate(g.all, g.cfg, (g.settings && g.settings.env) || {});
const footerFor = (g: any) => text.footerLines(g.lang, g.all.windows.d30, g.all.partial);

// The coverage line goes right under the header on every screen that shows a header.
function withCoverage(g: any, lines: string[]): string[] {
  if (!g.all.coverage || lines.length < 1) return lines;
  return [lines[0], coverageLine(g.lang, g.all.coverage), ...lines.slice(1)];
}

// First screen for a gathered analysis. Returns {json (structure), lines}.
function firstScreen(g: any, o: { brief?: boolean }): any {
  const ev = recommendations(g);
  const header = text.headerLine(g.lang, g.all.range.days, g.per.cleanup, g.all.partial);
  const s = screen.build(g.all, ev, g.cfg, { lang: g.lang, brief: o.brief });
  const json: any = { pattern: s.pattern, leaks: s.leaks, recs: s.recs, noEffect: s.noEffect };
  if (s.coverage) json.coverage = s.coverage;
  if (!o.brief) { json.why = s.why; json.glossary = s.glossary; }
  return { json, ev, lines: screen.render(g.lang, s, { header, footer: footerFor(g), min: minEffect(g.cfg) }) };
}

export interface RunOpts extends GatherOpts { brief?: boolean; firstRun?: boolean }

export async function analyze(ctx: AdvisorCtx, o: RunOpts): Promise<string> {
  const g = await gather(ctx, o);
  const header = text.headerLine(g.lang, g.all.range.days, g.per.cleanup, g.all.partial);
  const scr = o.firstRun && g.all.sufficiency.ok ? firstScreen(g, o) : null;
  if (o.json) {
    const out: any = Object.assign({}, g.all);
    if (o.firstRun) out.firstRun = Object.assign({ header, skipLine: text.tbl(g.lang).skipLine, sufficient: g.all.sufficiency.ok }, scr ? scr.json : {});
    return JSON.stringify(out, null, 2) + '\n';
  }
  if (scr) return scr.lines.join('\n') + '\n\n' + text.tbl(g.lang).skipLine + '\n';
  const body = withCoverage(g, text.analyzeReport(g.lang, g.all, g.per.cleanup).split('\n')).join('\n');
  let s = body + '\n';
  if (!g.all.sufficiency.ok) s += '\n' + text.tbl(g.lang).insufficient(g.all.sufficiency.calls, g.all.sufficiency.days) + '\n';
  if (o.firstRun) s += '\n' + text.tbl(g.lang).skipLine + '\n';
  return s;
}

export async function recommend(ctx: AdvisorCtx, o: RunOpts): Promise<string> {
  const g = await gather(ctx, o);
  const ev = recommendations(g);
  const header = text.headerLine(g.lang, g.all.range.days, g.per.cleanup, g.all.partial);
  const scr = ev.insufficient ? null : firstScreen(g, o);
  if (o.json) {
    return JSON.stringify(Object.assign({ schema: 1, generated: g.all.generated, range: g.all.range, cleanupPeriodDays: g.per.cleanup, header, partial: g.all.partial || null,
      coverage: g.all.coverage || null, insufficient: ev.insufficient, recommendations: ev.recs }, scr ? scr.json : { pattern: null, leaks: [], recs: [], noEffect: [], why: {} }, { footer: footerFor(g) }), null, 2) + '\n';
  }
  if (scr) return scr.lines.join('\n') + '\n';
  const t = text.tbl(g.lang);
  return withCoverage(g, [header, '', t.insufficient(ev.insufficient.calls, ev.insufficient.days), '', ...footerFor(g)]).join('\n') + '\n';
}

// The notice line of the first-run card: shown before anything is read, so skipping costs nothing.
export async function header(ctx: AdvisorCtx, o: GatherOpts): Promise<string> {
  const lang = o.lang || ctx.cfg.lang || 'en';
  const per = rules.periodDays(await readSettingsObj(ctx, o.settings || defaultSettings(ctx)));
  const range = o.days && o.days > 0 ? Math.min(o.days, 365) : per.range;
  const t = text.tbl(lang);
  if (o.json) return JSON.stringify({ header: text.headerLine(lang, range, per.cleanup), skipLine: t.skipLine, range: { days: range }, cleanupPeriodDays: per.cleanup }) + '\n';
  return text.headerLine(lang, range, per.cleanup) + '\n';
}

// First-run with too little data: the first real analysis is due in a week (weekly.ts owns the rest of schedule.json).
export async function markNextDue(ctx: AdvisorCtx, now: number): Promise<string | null> {
  try {
    const cur = await weekly.readSchedule(ctx);
    const due = new Date(now + 7 * DAY).toISOString();
    if (!cur.next_due || Date.parse(cur.next_due) < now) await weekly.writeSchedule(ctx, { next_due: due });
    return due;
  } catch { return null; }
}

export async function review(ctx: AdvisorCtx, o: { json?: boolean; lang?: string | null }): Promise<string> {
  const lang = o.lang || ctx.cfg.lang || 'en';
  const pend: any = await readJson(ctx.io, weekly.F.pending(ctx), null);
  if (o.json) return JSON.stringify(pend || { items: [], auto: [] }, null, 2) + '\n';
  if (!pend) return 'No pending suggestions.\n';
  const out = ['Pending suggestions from the weekly check (' + String(pend.created).slice(0, 10) + '), API-equivalent estimates:'];
  if (pend.items && pend.items.length) {
    out.push('', text.table(lang, pend.items));
    out.push('', 'Plan one with: advisor plan ids=<R#>   Decline one with: advisor reject rule=<R#>');
  }
  for (const a of pend.auto || []) out.push(`Changed automatically: ${a.rule} ${a.title} (apply log id ${a.id}). Undo with: advisor revert id=${a.id}`);
  for (const n of pend.notes || []) out.push('note: ' + n);
  return out.join('\n') + '\n';
}

export async function reject(ctx: AdvisorCtx, rule: string | undefined): Promise<string> {
  const r = await weekly.reject(ctx, rule, ctx.nowMs);
  if (!r.ok) return (r.message as string) + '\n';
  const cool = typeof ctx.cfg.advisorRejectCooldownSec === 'number' ? ctx.cfg.advisorRejectCooldownSec : 2419200;
  const days = Math.round(cool / 86400 * 10) / 10;
  return `${r.rule}: declined. It will not be proposed again for ${days} day(s).\n`;
}

export async function check(ctx: AdvisorCtx, o: RunOpts & { id?: string; force?: boolean }): Promise<string> {
  const lang = o.lang || ctx.cfg.lang || 'en';
  const res = await followup.check(ctx, { id: o.id, force: !!o.force, now: ctx.nowMs, gather: (x) => gather(ctx, Object.assign({}, o, x, { json: false })), min: minEffect(ctx.cfg), dir: o.dir, settings: o.settings, lang: o.lang });
  if (o.json) return JSON.stringify(res, null, 2) + '\n';
  return followup.render(lang, res).join('\n') + '\n';
}

// ---- plan -> apply -> revert (the advisor tool's write path)

export interface StoredPlan { id: string; created: number; expires: number; settingsPath: string; items: apply.PlanItem[]; notes: any[]; titles: Record<string, string>; risks: Record<string, string>; follow: Record<string, any> }

// plan: the preview of the chosen ids and a planId valid for 10 minutes. Nothing is written except the plan record.
export async function planChanges(ctx: AdvisorCtx, o: RunOpts & { ids: string[] }): Promise<any> {
  const lang = o.lang || ctx.cfg.lang || 'en';
  const ids = (o.ids || []).map((s) => String(s).trim().toUpperCase().replace(/^R1B$/, 'R1b')).filter(Boolean);
  if (!ids.length) return { error: 'Pass ids (the numbers come from recommend). Nothing changed.' };
  const g = await gatherForApply(ctx, o);
  const ev = recommendations(g);
  // fine-tune proposals of the one-week check live in pending.json (UNDO-R#, TUNE-R#); they are not re-derived from the analysis
  const pend: any = await readJson(ctx.io, weekly.F.pending(ctx), null);
  const follow = ((pend && pend.items) || []).filter((x: any) => x && (x.kind === 'revert' || x.kind === 'threshold') && !ev.recs.some((r: any) => r.id === x.id));
  const all = ev.recs.concat(follow);
  const idsUp = ids.map((i) => (all.find((r: any) => String(r.id).toUpperCase() === i.toUpperCase()) || { id: i }).id);
  const p = await apply.plan(ctx, all, idsUp, g.settingsPath);
  const now = ctx.nowMs;
  const stored: StoredPlan = { id: 'pl-' + randomHex(6), created: now, expires: now + apply.PLAN_TTL_MS, settingsPath: p.settingsPath, items: p.items, notes: p.notes,
    titles: {}, risks: {}, follow: {} };
  for (const id of idsUp) {
    const r = all.find((x: any) => x.id === id);
    if (r) { stored.titles[id] = r.title || ''; stored.risks[id] = r.risk || ''; }
    const f = follow.find((x: any) => x.id === id);
    if (f) stored.follow[id] = { kind: f.kind, rule: f.rule, apply_id: f.evidence && f.evidence.apply_id };
  }
  // a plan with nothing to do clears the stored one, so an older planId cannot be applied after this preview
  if (p.items.length) await writeJson(ctx.io, planFile(ctx), stored);
  else { try { await ctx.io.write(planFile(ctx), ''); } catch { /* nothing stored to clear */ } }
  const lines = apply.previewLines(p, lang);
  return {
    planId: p.items.length ? stored.id : null, validMinutes: apply.PLAN_TTL_MS / 60000, settingsPath: p.settingsPath,
    items: p.items.map((i) => ({ id: i.id, rule: i.rule, title: stored.titles[i.id] || '', risk: stored.risks[i.id] || '', target: i.file === 'settings' ? 'settings env.' + i.key : 'config ' + i.key, before: apply.show(i.before), after: apply.show(i.after) })),
    preview: lines.join('\n'),
  };
}

// apply: only a planId made less than 10 minutes ago and ids that were in that plan. Items whose current value is no
// longer the plan's `before` are skipped (the files changed since the preview).
// confirm: asks the person (register.ts: $.ui.ask) about the items that would be written and returns the ones they said yes to
// (null = declined, dismissed or no one to ask). Without it nothing is written: consent is part of the call shape.
export type ConfirmFn = (items: apply.PlanItem[], settingsNew: boolean) => Promise<apply.PlanItem[] | null>;
export const NEEDS_HUMAN = 'interactive session needed; nothing changed';

export async function applyPlan(ctx: AdvisorCtx, o: { planId?: string; approved?: string[]; lang?: string | null; dryRun?: boolean; confirm?: ConfirmFn }): Promise<any> {
  const lang = o.lang || ctx.cfg.lang || 'en';
  const stored: StoredPlan | null = await readJson<any>(ctx.io, planFile(ctx), null);
  if (!o.planId || !stored || stored.id !== o.planId) return { ok: false, error: 'Unknown or already used planId. Run plan first. Nothing changed.' };
  if (ctx.nowMs > stored.expires) return { ok: false, error: 'The plan is older than 10 minutes. Run plan again. Nothing changed.' };
  const approved = (o.approved || []).map((s) => String(s).trim());
  if (!approved.length) return { ok: false, error: 'approved is empty. Nothing changed.' };
  const inPlan = new Set(stored.items.map((i) => String(i.id).toUpperCase()));
  const extra = approved.filter((a) => !inPlan.has(a.toUpperCase()));
  if (extra.length) return { ok: false, error: 'Not in the plan: ' + extra.join(', ') + '. Nothing changed.' };
  const want = new Set(approved.map((a) => a.toUpperCase()));
  const chosen = stored.items.filter((i) => want.has(String(i.id).toUpperCase()));
  // freshness: the plan's before-values must still be what the files hold
  const cfgIn = await apply.readConfigStrict(ctx);
  if (!cfgIn.ok) return { ok: false, error: apply.configRefusal(cfgIn) };
  const user: any = cfgIn.obj;
  const st = await apply.readSettings(ctx, stored.settingsPath);
  const env = st.ok && st.json && st.json.env && typeof st.json.env === 'object' ? st.json.env : {};
  const stale: string[] = [];
  const fresh = chosen.filter((i) => {
    const src = i.file === 'settings' ? env : user;
    const had = Object.prototype.hasOwnProperty.call(src, i.key);
    const cur = had ? src[i.key] : null;
    const ok = had === i.hadKey && JSON.stringify(cur === undefined ? null : cur) === JSON.stringify(i.before === undefined ? null : i.before);
    if (!ok) stale.push(i.id + ' ' + i.key);
    return ok;
  });
  if (stale.length) return { ok: false, error: 'Changed since the preview: ' + stale.join(', ') + '. Run plan again. Nothing changed.' };
  const only = approved.every((a) => stored.follow[a] || stored.follow[a.toUpperCase()]);
  const followIds = Object.keys(stored.follow);
  let items = fresh;
  if (!o.dryRun) {
    let yes: apply.PlanItem[] | null = null;
    try { yes = o.confirm ? await o.confirm(fresh, !!st.isNew) : null; } catch { yes = null; }
    if (!yes || !yes.length) return { ok: false, error: NEEDS_HUMAN };
    items = fresh.filter((i) => yes!.some((y) => y.id === i.id && y.file === i.file && y.key === i.key));
    if (!items.length) return { ok: false, error: NEEDS_HUMAN };
    // a rule's values belong together: a host that approves only some of them gets nothing written
    for (const rule of Array.from(new Set(fresh.map((i) => i.rule)))) {
      const all = fresh.filter((i) => i.rule === rule).length;
      const got = items.filter((i) => i.rule === rule).length;
      if (got > 0 && got < all) return { ok: false, error: `Rule ${rule} was only partly approved; its values are applied together or not at all. Nothing changed.` };
    }
  }
  const p: apply.Plan = { settingsPath: stored.settingsPath, items, notes: [], approved, settingsNew: !!st.isNew };
  const analysis = await readJson<any>(ctx.io, latestFile(ctx), null);
  const r = await apply.apply(ctx, p, { dryRun: !!o.dryRun, now: new Date(ctx.nowMs), by: 'user', lang, analysis, confirmed: !o.dryRun, noTrack: only, trackSkipIds: followIds });
  if (!o.dryRun && r.applied && r.applied.length) {
    const undone = Array.from(new Set(r.applied.filter((i: any) => stored.follow[i.id] && stored.follow[i.id].kind === 'revert').map((i: any) => i.rule))) as string[];
    for (const i of r.applied) {
      const f = stored.follow[i.id];
      if (f && f.apply_id) { try { await followup.markFollowUp(ctx, f.apply_id, f.kind, ctx.nowMs); } catch { /* only a note on the old record */ } }
    }
    try { await apply.rememberRejected(ctx, undone, new Date(ctx.nowMs)); } catch { /* only a reminder */ }
    try { await weekly.clearPending(ctx, Array.from(new Set(r.applied.flatMap((i: any) => [i.id, i.rule])))); } catch { /* the pending card is only a reminder */ }
    await ctx.io.write(planFile(ctx), ''); // the plan is used up
  }
  return { ok: r.ok, applied: (r.applied || []).map((i: any) => ({ id: i.id, key: i.key })), logId: r.logId, text: r.lines.join('\n') };
}

export async function revertApply(ctx: AdvisorCtx, o: { id?: string; last?: boolean; lang?: string | null; settings?: string | null; confirmSettings?: (lines: string[]) => Promise<boolean> }): Promise<any> {
  const lang = o.lang || ctx.cfg.lang || 'en';
  const which = o.last ? '--last' : o.id;
  if (!which) return { ok: false, text: 'Usage: revert id=<apply id> or last=true' };
  const r = await apply.revert(ctx, which, { settings: o.settings || undefined, lang, now: new Date(ctx.nowMs), confirmSettings: o.confirmSettings });
  return { ok: r.ok, text: r.lines.join('\n') };
}
