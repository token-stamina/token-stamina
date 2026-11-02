// Aggregate snapshot, history, export and merge (design sections 8 and 12). toSnapshot is an ALLOWLIST projection:
// it reads only the fields named here and rebuilds a fresh object, so nothing else (ids, paths, model ids) can ride along.
import { joinPath } from './text.ts';
import * as pricing from './advisor-pricing.ts';
import { DAY, writeJson, dataDir, type AdvisorCtx } from './advisor-io.ts';
import { getSalt } from './advisor-scan.ts';

export const DEVICE_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const KIND = 'ts-usage-snapshot';
const FAMS = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
const PARTS = ['read', 'w5', 'w1', 'input', 'output'];
const BANDS = ['<50k', '50-100k', '100-200k', '200-300k', '300-500k', '>=500k'];
const CAUSES = ['first', 'ttl_5m', 'idle_1h', 'compaction', 'prefix_change', 'small'];
const CLASSES = ['judgment', 'implementation', 'simple', 'unknown'];
const MERGE_MAX_AGE_DAYS = 35;

const num = (x: any) => (typeof x === 'number' && isFinite(x) ? x : 0);
const r6 = (x) => Math.round(num(x) * 1e6) / 1e6;
export const validDevice = (a) => typeof a === 'string' && DEVICE_RE.test(a);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const dateOf = (iso) => String(iso || '').slice(0, 10);

function pick(src, keys) {
  const o = {};
  for (const k of keys) o[k] = r6(src && src[k]);
  return o;
}
function partsOf(p) { return pick(p, PARTS); }

// Rebuilds a snapshot from snapshot-shaped input, copying only allowed fields (used for fresh data and for files read back in merge).
function normalize(s, device) {
  const byFamily = {};
  for (const f of FAMS) {
    const x = s.byFamily && s.byFamily[f];
    if (!x) continue;
    byFamily[f] = { usd: r6(x.usd), calls: r6(x.calls), tokens: r6(x.tokens), parts: partsOf(x.parts), main_usd: r6(x.main_usd), sub_usd: r6(x.sub_usd) };
  }
  const ctxBands = {};
  for (const b of BANDS) ctxBands[b] = pick(s.ctxBands && s.ctxBands[b], ['usd', 'calls']);
  const rewrite = {};
  for (const c of CAUSES) rewrite[c] = pick(s.rewrite && s.rewrite[c], ['usd', 'n', 'main_usd', 'sub_usd']);
  const classes = {};
  for (const c of CLASSES) classes[c] = pick(s.subagentClasses && s.subagentClasses[c], ['usd', 'n', 'upper_usd', 'upper_no_model_usd']);
  const roles = s.roles || {};
  return {
    schema: 1, kind: KIND, complete: s.complete === true, generated: String(s.generated || ''), device: validDevice(device) ? device : null,
    period: { days: r6(s.period && s.period.days), start: String((s.period && s.period.start) || ''), end: String((s.period && s.period.end) || '') },
    totals: { usd: r6(s.totals && s.totals.usd), calls: r6(s.totals && s.totals.calls), tokens: r6(s.totals && s.totals.tokens), parts: partsOf(s.totals && s.totals.parts) },
    byFamily,
    roles: { main: pick(roles.main, ['usd', 'calls']), sub: pick(roles.sub, ['usd', 'calls', 'agents', 'share']) },
    ctxBands, rewrite, subagentClasses: classes,
    oldModels: pick(s.oldModels, ['usd', 'calls', 'sessions', 'unpriced_calls', 'unpriced_tokens']),
    compaction: pick(s.compaction, ['auto', 'manual', 'hint_events', 'hint_followed', 'hint_saving_usd']),
    unpriced: { other: pick(s.unpriced && s.unpriced.other, ['calls', 'tokens']) },
    pricing: { date: String((s.pricing && s.pricing.date) || '') },
  };
}

// analysis = buildAll result ({windows:{d7}}) or one window. Uses the 7-day window.
function toSnapshot(analysis, opts) {
  opts = opts || {};
  const w = analysis && analysis.windows ? analysis.windows.d7 : analysis;
  const unpriced = { calls: 0, tokens: 0 };
  for (const k of Object.keys(w.unpriced || {})) { unpriced.calls += num(w.unpriced[k].calls); unpriced.tokens += num(w.unpriced[k].tokens); }
  const shape = {
    complete: !(analysis && analysis.partial) && !!(w && w.period),
    generated: w.generated,
    period: { days: w.period.days, start: dateOf(w.period.start), end: dateOf(w.period.end) },
    totals: w.totals, byFamily: {}, roles: w.roles, ctxBands: w.ctxBands, rewrite: w.rewrite,
    subagentClasses: w.subagents && w.subagents.byClass, oldModels: w.oldModels, compaction: w.compaction,
    unpriced: { other: unpriced }, pricing: { date: (w.pricing && w.pricing.date) || pricing.PRICING_DATE },
  };
  for (const k of Object.keys(w.byFamily || {})) shape.byFamily[FAMS.includes(k) ? k : 'other'] = w.byFamily[k];
  return normalize(shape, opts.device);
}

export const historyDir = (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'history');

// Writes history/<end>.json and prunes to the newest `keep` dated files. $.fs has no delete: a pruned file is emptied
// (a zero-length file reads as no snapshot) and is not listed again once empty.
export async function writeHistory(ctx: AdvisorCtx, snap: any, keep?: number): Promise<{ file: string; pruned: string[] }> {
  const dir = historyDir(ctx);
  const file = joinPath(dir, snap.period.end + '.json');
  await writeJson(ctx.io, file, snap);
  const n = Math.max(1, Math.floor(typeof keep === 'number' && keep > 0 ? keep : 12));
  const ents = (await ctx.io.list(dir)) || [];
  const names = ents.filter((e) => e.kind === 'file' && e.size > 0 && /^\d{4}-\d{2}-\d{2}\.json$/.test(e.name)).map((e) => e.name).sort().reverse();
  const pruned: string[] = [];
  for (const f of names.slice(n)) { try { await ctx.io.write(joinPath(dir, f), ''); pruned.push(f); } catch { /* keep */ } }
  return { file, pruned };
}

// ---- export (section 12)
async function exportSnapshot(ctx, analysis, cfg, outDir) {
  const device = cfg && cfg.advisorDevice;
  if (!validDevice(device)) return { ok: false, message: 'advisorDevice must be set to an alias matching ^[a-z0-9][a-z0-9-]{0,23}$ (never a hostname or username). Nothing written.' };
  const dir = outDir || (cfg && cfg.advisorExportDir);
  if (!dir) return { ok: false, message: 'No export folder: pass --out <dir> or set advisorExportDir. Nothing written.' };
  if (analysis && analysis.partial) return { ok: false, message: 'The analysis is partial (scan cut short by a time budget); a snapshot needs a complete scan. Nothing written.' };
  const snap = toSnapshot(analysis, { device });
  const file = joinPath(dir, `ts-usage-${device}-${snap.period.end}.json`);
  await writeJson(ctx.io, file, snap);
  return { ok: true, file, snapshot: snap };
}

// ---- merge (section 12)
function sumInto(a, b) {
  for (const k of Object.keys(b)) {
    if (typeof b[k] === 'number') a[k] = (a[k] || 0) + b[k];
    else if (b[k] && typeof b[k] === 'object') sumInto(a[k] || (a[k] = {}), b[k]);
  }
  return a;
}
function sumSnapshots(list) {
  const o = {};
  for (const s of list) {
    sumInto(o, { totals: s.totals, byFamily: s.byFamily, roles: s.roles, ctxBands: s.ctxBands, rewrite: s.rewrite,
      subagentClasses: s.subagentClasses, oldModels: s.oldModels, compaction: s.compaction, unpriced: s.unpriced });
  }
  if (o.roles && o.roles.sub && o.totals) o.roles.sub.share = o.totals.usd > 0 ? o.roles.sub.usd / o.totals.usd : 0; // a ratio, not a sum
  return o;
}

async function mergeDir(ctx, dir, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const skipped = [];
  const ents = await ctx.io.list(dir);
  if (!ents) return { ok: false, message: 'Cannot read folder: ' + dir };
  const names = ents.filter((e) => e.kind === 'file' && /^ts-usage-.+\.json$/.test(e.name)).map((e) => e.name).sort();
  const kept = new Map(); // device|start|end -> snapshot
  for (const f of names) {
    let j;
    try { j = JSON.parse((await ctx.io.read(joinPath(dir, f))) as string); } catch (e) { skipped.push({ file: f, reason: 'unreadable' }); continue; }
    if (!j || j.kind !== KIND) { skipped.push({ file: f, reason: 'kind' }); continue; }
    if (typeof j.schema !== 'number' || Math.floor(j.schema) !== 1) { skipped.push({ file: f, reason: 'schema' }); continue; }
    if (j.complete !== true) { skipped.push({ file: f, reason: 'partial' }); continue; }
    if (!validDevice(j.device)) { skipped.push({ file: f, reason: 'device' }); continue; }
    const p = j.period || {};
    if (!isDate(p.start) || !isDate(p.end)) { skipped.push({ file: f, reason: 'period' }); continue; }
    const endMs = Date.parse(p.end + 'T23:59:59Z');
    if (!isFinite(endMs) || now - endMs > MERGE_MAX_AGE_DAYS * DAY) { skipped.push({ file: f, reason: 'stale' }); continue; }
    const snap = normalize(j, j.device);
    const key = [snap.device, snap.period.start, snap.period.end].join('|');
    const prev = kept.get(key);
    if (!prev || snap.generated > prev.snap.generated) { if (prev) skipped.push({ file: prev.file, reason: 'duplicate' }); kept.set(key, { snap, file: f }); }
    else skipped.push({ file: f, reason: 'duplicate' });
  }
  const snaps = Array.from(kept.values()).map((x) => x.snap);
  const groups = new Map();
  for (const s of snaps) {
    const k = s.period.start + '|' + s.period.end;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const periods = Array.from(groups.keys()).sort().map((k) => {
    const list = groups.get(k);
    return Object.assign({ start: list[0].period.start, end: list[0].period.end, devices: list.map((s) => s.device).sort() }, sumSnapshots(list));
  });
  const latest = periods.length ? periods[periods.length - 1] : null;
  const perDevice = snaps.map((s) => ({ device: s.device, start: s.period.start, end: s.period.end, usd: s.totals.usd, calls: s.totals.calls }))
    .sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
  return { ok: true, schema: 1, kind: 'ts-usage-merged', devices: Array.from(new Set(snaps.map((s) => s.device))).sort(), periods,
    totals: latest ? latest.totals : null, byFamily: latest ? latest.byFamily : null, perDevice, skipped };
}

export { toSnapshot, normalize, exportSnapshot, mergeDir, getSalt };
