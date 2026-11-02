// Weekly re-analysis (design section 9; mod build, decision 2). No OS scheduler and no notify command: SessionStart calls
// dueToRun() and, when it says yes, runs run() in the background. Re-analysis -> snapshot history -> change detection
// (the same suggestion in two consecutive runs; hysteresis) -> pending.json, and risk-A auto-apply only for rules
// listed in advisorAutoApply (default none; settings.json is never written automatically: risk A is Token Stamina
// config only). The lock is a file with a timestamp ($.fs has no exclusive create): an hour old counts as stale.
import { joinPath } from './text.ts';
import * as rules from './advisor-rules.ts';
import * as apply from './advisor-apply.ts';
import * as snapshot from './advisor-snapshot.ts';
import * as text from './advisor-text.ts';
import * as followup from './advisor-followup.ts';
import { tr as screenTr } from './advisor-screen-text.ts';
import { ADVISOR_DEFAULTS } from './advisor-defaults.ts';
import { DAY, readJson, writeJson, randomHex, dataDir, type AdvisorCtx } from './advisor-io.ts';

export const LOCK_STALE_MS = 3600000;
export const BUDGET_MS = 60000; // a SessionStart background run stops reading after this and finishes as partial
export const RISK_A = new Set(['R2', 'R4', 'R5', 'R6']); // R1b is risk B: never auto-applied
export const F = {
  schedule: (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'schedule.json'),
  baseline: (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'baseline.json'),
  pending: (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'pending.json'),
  lock: (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'weekly.lock'),
  merged: (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'analysis-latest.merged.json'),
};

export const targetOf = (rec: any) => (rec.target === 'info' || !rec.changes || !rec.changes.length ? 'info'
  : rec.changes.map((c: any) => `${c.key}=${JSON.stringify(c.after)}`).join('|'));
const metricOf = (rec: any) => (rec.effect.lo > 0 ? rec.effect.lo : rec.effect.hi);

// Next run: just after the 7-day usage window resets (when the status data says when), else a week from now.
export function nextDue(now: number, resetsAtSec?: number | null): string {
  if (typeof resetsAtSec === 'number' && isFinite(resetsAtSec)) {
    const t = resetsAtSec * 1000 + 5 * 60000;
    if (t > now && t - now <= 8 * DAY) return new Date(t).toISOString();
  }
  return new Date(now + 7 * DAY).toISOString();
}

export const readSchedule = async (ctx: AdvisorCtx): Promise<any> => (await readJson(ctx.io, F.schedule(ctx), {})) || {};
export async function writeSchedule(ctx: AdvisorCtx, patch: any): Promise<void> {
  const cur = await readSchedule(ctx);
  await writeJson(ctx.io, F.schedule(ctx), Object.assign(cur, patch));
}

// Lock: a file holding {ts}. Free when missing, empty (released), unreadable or older than staleMs.
export async function takeLock(ctx: AdvisorCtx, now: number, staleMs = LOCK_STALE_MS): Promise<boolean> {
  const cur = await readJson<any>(ctx.io, F.lock(ctx), null);
  if (cur && typeof cur.ts === 'number' && now - cur.ts < staleMs) return false;
  await writeJson(ctx.io, F.lock(ctx), { ts: now, id: randomHex(4) });
  return true;
}
export async function dropLock(ctx: AdvisorCtx): Promise<void> {
  try { await ctx.io.write(F.lock(ctx), ''); } catch { /* gone */ }
}

// SessionStart gate: advisor on, next_due passed (or never set), and not tried yet today (schedule.json.checked).
// There is no run before next_due is set: the first SessionStart (startup/resume) seeds it one week ahead (advisor-run markNextDue),
// so a fresh install stays quiet for a week. `advisor: false` in the config turns the whole weekly run off.
export async function dueToRun(ctx: AdvisorCtx, now: number): Promise<boolean> {
  if (ctx.cfg.advisor === false) return false;
  const s = await readSchedule(ctx);
  const due = Date.parse(s.next_due);
  if (!isFinite(due) || due > now) return false;
  const checked = typeof s.checked === 'number' ? s.checked : 0;
  return now - checked >= DAY;
}

const withinCooldown = (base: any, rule: string, cfg: any, now: number) => {
  const t = base.rejected && base.rejected[rule];
  const cool = typeof cfg.advisorRejectCooldownSec === 'number' ? cfg.advisorRejectCooldownSec : ADVISOR_DEFAULTS.advisorRejectCooldownSec;
  return typeof t === 'number' && now - t < cool * 1000;
};

// Change detection with hysteresis: a suggestion qualifies only when the same target was proposed in the previous run too
// (runs >= 2), its effect reaches advisorMinEffectUsd and it is not inside a reject cooldown.
export function detect(baseline: any, recs: any[], cfg: any, now: number): { baseline: any; qualifying: any[] } {
  const base: any = { rules: {}, appliedAt: baseline.appliedAt || null, rejected: Object.assign({}, baseline.rejected) };
  if (baseline.metrics) base.metrics = baseline.metrics; // the one-week check's new baselines (followup)
  const min = typeof cfg.advisorMinEffectUsd === 'number' ? cfg.advisorMinEffectUsd : ADVISOR_DEFAULTS.advisorMinEffectUsd;
  const qualifying: any[] = [];
  for (const rec of recs) {
    const target = targetOf(rec);
    if (target === 'info') continue; // nothing to approve; the first-run/recommend screens show these rows
    const prev = baseline.rules && baseline.rules[rec.rule];
    const lo = metricOf(rec);
    if (!prev || prev.target !== target) { base.rules[rec.rule] = { target, since: new Date(now).toISOString(), runs: 1, lastEffectLo: lo }; continue; }
    const runs = (prev.runs || 1) + 1;
    base.rules[rec.rule] = { target, since: prev.since, runs, lastEffectLo: lo };
    if (runs >= 2 && lo >= min && !withinCooldown(base, rec.rule, cfg, now)) qualifying.push(rec);
  }
  return { baseline: base, qualifying };
}

// Auto-apply keeps only the changes that are Token Stamina config: settings.json is never written automatically.
export const configOnly = (recs: any[]): any[] => recs.map((r) => Object.assign({}, r, { changes: (r.changes || []).filter((c: any) => c.file === 'config') })).filter((r) => r.changes.length);

const sig = (items: any[]) => items.map((r) => r.rule + ':' + targetOf(r)).sort().join(',');

const MSG: Record<string, (n: number, auto: number, lo: number, hi: number) => string> = {
  en: (n, auto, lo, hi) => `Token Stamina advisor: ${n} suggestion${n === 1 ? '' : 's'} waiting (est. ${text.range(lo, hi)}/wk API-equiv)` + (auto ? `, ${auto} change${auto === 1 ? '' : 's'} applied automatically` : '') + '. Run /token-stamina:advisor review',
  ko: (n, auto, lo, hi) => `Token Stamina 어드바이저: 제안 ${n}건 대기 중(주당 약 ${text.range(lo, hi)} 추정, API 환산)` + (auto ? `, 자동 적용 ${auto}건` : '') + '. /token-stamina:advisor review 로 확인하세요',
};
export function summaryLine(lang: string, items: any[], autoCount: number): string {
  let lo = 0, hi = 0;
  for (const r of items) { lo += r.effect.lo; hi += r.effect.hi; }
  return (MSG[lang] || MSG.en)(items.length, autoCount, lo, hi);
}

// opts: {gather (async fn like run.gather), days, dir, settings, lang, now (ms), ifDue, budgetSec}
export async function run(ctx: AdvisorCtx, opts: { gather: (o: any) => Promise<any>; days?: number | null; dir?: string | null; settings?: string | null; lang?: string | null; now?: number; ifDue?: boolean; budgetSec?: number }): Promise<any> {
  const now = opts.now || ctx.nowMs;
  const cfg = ctx.cfg;
  const res: any = { code: 0, out: '', result: 'ok', notes: [] as string[], proposed: 0, autoApplied: [] as string[], skipped: null };
  if (cfg.advisor === false) { res.skipped = 'disabled'; return res; }
  if (opts.ifDue) {
    const due = Date.parse((await readSchedule(ctx)).next_due);
    if (isFinite(due) && due > now) { res.skipped = 'not_due'; return res; }
  }
  if (!(await takeLock(ctx, now))) { res.skipped = 'locked'; return res; }
  try {
    const gatherFn = opts.gather;
    const g = await gatherFn({ days: opts.days || null, dir: opts.dir || null, settings: opts.settings || null, lang: opts.lang || null, now, save: true, json: false, budgetSec: opts.budgetSec });
    const lang = g.lang;
    const finish = async (result: string, extra?: any) => {
      res.result = result;
      await writeSchedule(ctx, Object.assign({ last_run: new Date(now).toISOString(), next_due: nextDue(now, ctx.sevenDayResetsAt), last_result: result, consecutive_errors: 0 }, extra || {}));
      return res;
    };

    // A scan cut short by the time budget decides nothing: no history, no detection, no auto-apply, and next_due stays, so the
    // next day's SessionStart reads the rest from the cache. Only `checked` moves (one try per day).
    if (g.all.partial) {
      res.notes.push('partial scan: nothing decided, next_due unchanged');
      res.result = 'partial';
      await writeSchedule(ctx, { checked: now, last_result: 'partial' });
      return res;
    }

    // One-week check of every apply that is due; its fine-tune proposals land in pending.json (followup does that).
    const followBlock = async (): Promise<string> => {
      try {
        const min = typeof g.cfg.advisorMinEffectUsd === 'number' ? g.cfg.advisorMinEffectUsd : ADVISOR_DEFAULTS.advisorMinEffectUsd;
        let n = 0;
        for (const a of await followup.dueList(ctx, now)) {
          const r = await followup.check(ctx, { id: a.id, now, gather: gatherFn, min, dir: opts.dir, settings: opts.settings, lang: opts.lang });
          if (r.status === 'ok') n += r.proposals.length;
        }
        return n ? screenTr(lang).check.proposals(n) : '';
      } catch (e: any) { res.notes.push('check: ' + (e && e.message || e)); return ''; }
    };
    const insufficient = async () => {
      const line = await followBlock();
      if (line) res.out += line + '\n';
      return finish('insufficient');
    };
    if (!g.all.sufficiency.ok) return await insufficient();

    const device = typeof cfg.advisorDevice === 'string' && snapshot.validDevice(cfg.advisorDevice) ? cfg.advisorDevice : null;
    { try { await snapshot.writeHistory(ctx, snapshot.toSnapshot(g.all, { device }), cfg.advisorHistoryKeep); } catch (e: any) { res.notes.push('history: ' + e.message); } }
    if (cfg.advisorExportDir) {
      try {
        const m: any = await snapshot.mergeDir(ctx, cfg.advisorExportDir, { now });
        if (m.ok) await writeJson(ctx.io, F.merged(ctx), m);
      } catch (e: any) { res.notes.push('merge: ' + e.message); }
    }

    const ev: any = rules.evaluate(g.all, g.cfg, (g.settings && g.settings.env) || {});
    if (ev.insufficient) return await insufficient();
    const det = detect((await readJson<any>(ctx.io, F.baseline(ctx), {})) || {}, ev.recs, g.cfg, now);
    const baseline = det.baseline;

    // Auto-apply: only risk A rules named in advisorAutoApply. Risk B (R1b) and anything else is a manual suggestion.
    const want = Array.isArray(cfg.advisorAutoApply) ? cfg.advisorAutoApply.map((s: any) => String(s).toUpperCase()) : [];
    for (const id of want) if (!RISK_A.has(id)) res.notes.push(`advisorAutoApply: ${id} ignored (only risk A rules may auto-apply)`);
    const autoRecs = det.qualifying.filter((r) => r.risk === 'A' && want.includes(r.rule));
    const manual = det.qualifying.filter((r) => !autoRecs.includes(r));
    const autoInfo: any[] = [];
    if (autoRecs.length) {
      // settings.json is never written automatically: keep only the changes that are Token Stamina config
      const cfgOnly = configOnly(autoRecs);
      const p = await apply.plan(ctx, cfgOnly, cfgOnly.map((r) => r.id), g.settingsPath);
      const r = await apply.apply(ctx, p, { dryRun: false, now: new Date(now), by: 'auto', lang, analysis: g.all });
      if (r.logId) {
        res.autoApplied.push(r.logId);
        for (const x of cfgOnly) { autoInfo.push({ id: r.logId, rule: x.rule, title: x.title, lo: x.effect.lo, hi: x.effect.hi }); delete baseline.rules[x.rule]; }
        baseline.appliedAt = new Date(now).toISOString();
      } else res.notes.push('auto-apply changed nothing: ' + r.lines.join(' | '));
    }

    // pending.json: new manual suggestions, plus follow-up items (UNDO-*, TUNE-*) already waiting there.
    const oldPending: any = await readJson(ctx.io, F.pending(ctx), null);
    const keepFollow = ((oldPending && oldPending.items) || []).filter((x: any) => x && (x.kind === 'revert' || x.kind === 'threshold'));
    const sameManual = oldPending && sig((oldPending.items || []).filter((x: any) => !keepFollow.includes(x))) === sig(manual);
    let wrote = false;
    if (manual.length && !sameManual) {
      await writeJson(ctx.io, F.pending(ctx), { id: 'pd-' + randomHex(6), created: new Date(now).toISOString(), items: manual.concat(keepFollow),
        shownAt: null, autoApplied: res.autoApplied.slice(), auto: autoInfo, notes: res.notes.slice() });
      wrote = true;
    } else if (!manual.length && autoInfo.length) {
      await writeJson(ctx.io, F.pending(ctx), { id: 'pd-' + randomHex(6), created: new Date(now).toISOString(), items: keepFollow,
        shownAt: null, autoApplied: res.autoApplied.slice(), auto: autoInfo, notes: res.notes.slice() });
      wrote = true;
    }
    await writeJson(ctx.io, F.baseline(ctx), baseline);
    const followLine = await followBlock();
    if (wrote) {
      res.proposed = manual.length;
      res.out = summaryLine(lang, manual, autoInfo.length) + '\n';
    }
    if (followLine) res.out += followLine + '\n';
    return await finish('ok');
  } catch (e: any) {
    res.result = 'error';
    res.notes.push(String(e && e.message || e));
    try {
      const prev = await readSchedule(ctx);
      await writeSchedule(ctx, { last_run: new Date(now).toISOString(), next_due: new Date(now + DAY).toISOString(), last_result: 'error', consecutive_errors: (prev.consecutive_errors || 0) + 1 });
    } catch { /* read-only home */ }
    return res;
  } finally {
    await dropLock(ctx);
  }
}

// `reject <R#>`: remember a refusal (advisorRejectCooldownSec) and drop it from pending.
export async function reject(ctx: AdvisorCtx, ruleId: string | undefined, now: number): Promise<{ ok: boolean; rule?: string; message?: string }> {
  const rule = String(ruleId || '').toUpperCase().replace(/B$/, 'b'); // R1b is the one lower-case rule id
  if (!/^R\d+b?$/.test(rule)) return { ok: false, message: 'Usage: reject <R#>' };
  const base: any = (await readJson(ctx.io, F.baseline(ctx), {})) || {};
  base.rejected = Object.assign({}, base.rejected, { [rule]: now });
  if (base.rules) delete base.rules[rule];
  await writeJson(ctx.io, F.baseline(ctx), base);
  const pend: any = await readJson(ctx.io, F.pending(ctx), null);
  if (pend && Array.isArray(pend.items)) {
    pend.items = pend.items.filter((r: any) => r.rule !== rule);
    // $.fs has no delete: an empty pending file reads as none
    if (!pend.items.length && !(pend.auto && pend.auto.length)) await ctx.io.write(F.pending(ctx), '');
    else await writeJson(ctx.io, F.pending(ctx), pend);
  }
  return { ok: true, rule };
}

// Applied (or reverted) rules leave pending.json.
export async function clearPending(ctx: AdvisorCtx, ruleIds: string[]): Promise<void> {
  const pend: any = await readJson(ctx.io, F.pending(ctx), null);
  if (!pend || !Array.isArray(pend.items)) return;
  const ids = new Set(ruleIds.map((x) => String(x).toUpperCase()));
  pend.items = pend.items.filter((r: any) => !ids.has(String(r.rule).toUpperCase()) && !ids.has(String(r.id).toUpperCase()));
  if (!pend.items.length && !(pend.auto && pend.auto.length)) await ctx.io.write(F.pending(ctx), '');
  else await writeJson(ctx.io, F.pending(ctx), pend);
}

// What the next SessionStart shows for a waiting pending.json: one line + the card request, once per 7 days
// (the file's shownAt). Returns null when nothing is waiting.
export async function pendingNotice(ctx: AdvisorCtx, now: number): Promise<{ count: number; auto: number } | null> {
  const pend: any = await readJson(ctx.io, F.pending(ctx), null);
  if (!pend) return null;
  const n = (pend.items || []).length;
  const auto = (pend.auto || []).length;
  if (!n && !auto) return null;
  const shown = Date.parse(pend.shownAt);
  if (isFinite(shown) && now - shown < 7 * DAY) return null;
  pend.shownAt = new Date(now).toISOString();
  await writeJson(ctx.io, F.pending(ctx), pend);
  return { count: n, auto };
}
