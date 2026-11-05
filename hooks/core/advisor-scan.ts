// Transcript scan: ~/.claude/projects/**/*.jsonl -> per-call records. No text is kept: prompts and descriptions are
// classified in memory and dropped; session/file ids leave this module only as salted hashes.
// Mod build differences from the Node scan: `$.fs.read` returns a whole file and rejects one over 4 MiB, so a file is
// parsed from a string (parseTranscript). A bigger file is read through io.read(p, { adv: true }) (0.6.8: register.ts streams it with
// scripts/transcript-slim.js --adv, any size); when that is not possible it is only counted (coverage). The
// incremental cache is split into 64 shards (advisor/scan-cache/<00..3f>.json), each kept under 3.5 MiB.
import type { CmdIO } from './cmd-io.ts';
import { walkJsonl, baseName, parentDir } from './cmd-io.ts';
import { sha1Hex, joinPath } from './text.ts';
import * as pricing from './advisor-pricing.ts';
import * as taskClass from './task-class.ts';
import { parseMeta } from './fleet.ts';
import { DAY, MAX_READ_BYTES, randomHex, sha, hash12, relPath, readJson, utf8Bytes, maybeYield, type AdvisorCtx, dataDir } from './advisor-io.ts';

export const BIG_WRITE = 50000;
export const DEFAULT_MAX_CALLS = 2000000;
export const FIRST_USER_CHARS = 600;
export const CACHE_VERSION = 3; // 3: pricing keys changed (explicit old Opus/Sonnet/Haiku rows, no family prefixes)
export const SHARDS = 64;
export const SHARD_MAX_BYTES = 3.5 * 1024 * 1024;
const USER_RE = /"type"\s*:\s*"user"/;

export interface Kw { judgment: string[]; simple: string[]; implementation: string[] }

const num = (x: any) => (typeof x === 'number' && isFinite(x) && x > 0 ? x : 0);
export const hasKeyword = (text: unknown, list: unknown) => taskClass.hasKeyword(text, list) !== null;
const toCfg = (kw: Kw) => ({ judgmentKeywords: kw.judgment, implementationKeywords: kw.implementation, simpleKeywords: kw.simple });

// Fallback text (the first user message = the subagent prompt): shared classifier, prompt order
// implementation > judgment > simple; empty -> unknown.
export function classifyText(text: unknown, judgment: string[], simple: string[], implementation: string[]): string {
  if (!text || !String(text).trim()) return 'unknown';
  return taskClass.classifyTask('', text, toCfg({ judgment, simple, implementation })).cls;
}

// Description-first: the short label alone. No description keyword -> null and the caller falls back to the first user message.
export function classifyDescription(desc: unknown, kw: Kw): string | null {
  if (!desc || !String(desc).trim()) return null;
  const r = taskClass.classifyTask(desc, '', toCfg(kw));
  return r.source === 'description' ? r.cls : null;
}

function userText(r: any): string {
  const c = r && r.message && r.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x: any) => (x && typeof x.text === 'string' ? x.text : '')).join(' ');
  return '';
}

// Tags every call of one file (calls: {t, seq, input, read, w5, w1}); boundaries: compact_boundary times (ms).
export function causeTag(file: { calls: any[]; boundaries: number[] }): void {
  const calls = file.calls.slice().sort((a, b) => a.t - b.t || a.seq - b.seq);
  const bounds = file.boundaries.slice().sort((a, b) => a - b);
  let prev: any = null, firstSeen = false;
  for (const c of calls) {
    const big = c.w5 + c.w1 > BIG_WRITE;
    let cause: string;
    if (!big) cause = 'small';
    else if (!firstSeen) { cause = 'first'; firstSeen = true; }
    else {
      const gap = prev ? (c.t - prev.t) / 1000 : 0;
      const prevCtx = prev ? prev.input + prev.read + prev.w5 + prev.w1 : 0;
      const ctx = c.input + c.read + c.w5 + c.w1;
      const bounded = prev ? bounds.some((b) => b > prev.t && b <= c.t) : false;
      if (gap >= 3600) cause = 'idle_1h';
      else if (gap >= 300 && c.w5 > c.w1) cause = 'ttl_5m';
      else if (bounded || ctx < 0.7 * prevCtx) cause = 'compaction';
      else cause = 'prefix_change';
    }
    c.cause = cause;
    prev = c;
  }
}

// One file's text -> cache entry. No window logic here (the cache must serve any window). Text-free:
//   calls [t, normalized model key, input, read, w5, w1, output, sidechain, dedupKeyHash]
//   bd    [t, manual]                       compact_boundary events
//   ag    [toolIdHash, t, hasModel, descHash, promptHash, descClass|null]   Agent tool_use in this transcript
//   sid   hashed session id, fu class of the first user message (subagent files), fh hash of that message
export function parseTranscript(content: string, st: { size: number; mtimeMs: number }, pathSub: boolean, salt: string, kw: Kw): any {
  const e: any = { size: st.size, mtimeMs: st.mtimeMs, pathSub, sidechain: false, sid: null, fu: 'unknown', fh: '', calls: [], bd: [], ag: [], skippedLines: 0 };
  let firstUser: string | null = null, sessionId: string | null = null;
  const byKey = new Map<string, any>();
  for (let line of content.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) continue;
    const wantUser = pathSub && firstUser === null && USER_RE.test(line);
    if (!wantUser && !line.includes('"usage"') && !line.includes('compact_boundary') && !line.includes('tool_use')) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { e.skippedLines++; continue; }
    if (!r || typeof r !== 'object') { e.skippedLines++; continue; }
    if (!sessionId && typeof r.sessionId === 'string') sessionId = r.sessionId;
    if (r.isSidechain === true) e.sidechain = true;
    const t = Date.parse(r.timestamp);
    if (wantUser && r.type === 'user') firstUser = userText(r).slice(0, FIRST_USER_CHARS);
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      if (isFinite(t)) e.bd.push([t, r.compactMetadata && r.compactMetadata.trigger === 'manual' ? 1 : 0]);
      continue;
    }
    const msg = r.message;
    if (!msg || typeof msg !== 'object') continue;
    if (Array.isArray(msg.content)) {
      for (const it of msg.content) {
        if (!it || it.type !== 'tool_use' || (it.name !== 'Agent' && it.name !== 'Task')) continue;
        const inp = it.input && typeof it.input === 'object' ? it.input : {};
        const hasModel = typeof inp.model === 'string' && inp.model.length > 0;
        const desc = typeof inp.description === 'string' ? inp.description : '';
        const prompt = typeof inp.prompt === 'string' ? inp.prompt.slice(0, FIRST_USER_CHARS) : '';
        e.ag.push([it.id ? sha(salt, it.id) : '', isFinite(t) ? t : 0, hasModel ? 1 : 0, desc ? sha(salt, desc) : '', prompt ? sha(salt, prompt) : '', classifyDescription(desc, kw)]);
      }
    }
    const u = msg.usage;
    if (!u || typeof u !== 'object' || !isFinite(t)) continue;
    const model = typeof msg.model === 'string' ? msg.model : '';
    if (model === '<synthetic>') continue;
    const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {};
    let w5 = cc.ephemeral_5m_input_tokens, w1 = cc.ephemeral_1h_input_tokens;
    if (w5 === undefined && w1 === undefined) { w5 = u.cache_creation_input_tokens; w1 = 0; }
    const pk = pricing.priceOf(model).key; // normalized pricing key; an unpriced model keeps its stripped name (listed as unpriced)
    const rec: any[] = [t, pk || pricing.strip(model) || 'unknown', num(u.input_tokens), num(u.cache_read_input_tokens), num(w5), num(w1), num(u.output_tokens),
      r.isSidechain === true ? 1 : 0, msg.id ? sha(salt, msg.id + '|' + (r.requestId || '')) : ''];
    const old = rec[8] ? byKey.get(rec[8]) : null;
    if (old) { for (let i = 2; i <= 6; i++) if (rec[i] > old[i]) old[i] = rec[i]; continue; } // streaming repeats an id: max per usage field
    if (rec[8]) byKey.set(rec[8], rec);
    e.calls.push(rec);
  }
  e.sid = sessionId ? hash12(salt, sessionId) : null;
  e.fu = classifyText(firstUser, kw.judgment, kw.simple, kw.implementation);
  e.fh = firstUser ? sha(salt, firstUser) : '';
  return e;
}

export interface ScanFile { path: string; rel: string; e: any; meta: any | null }

// Entries of the files that were read (or came from the cache), in sorted path order -> the scan result.
// `files` holds only readable files; `coverage` is computed by the caller (it knows the unread ones).
export function assemble(files: ScanFile[], o: { sinceMs: number; untilMs: number; salt: string; kw: Kw; maxCalls?: number }): any {
  const { sinceMs, untilMs, salt, kw } = o;
  const maxCalls = o.maxCalls || DEFAULT_MAX_CALLS;
  const fs: any[] = files.map((f) => ({ path: f.path, rel: f.rel, e: f.e, meta: f.meta, pathSub: f.e.pathSub, sidechain: f.e.sidechain }));
  let skippedLines = 0;
  for (const f of fs) skippedLines += f.e.skippedLines || 0;
  const seenTools = new Set<string>();
  const compactEvents: any[] = [], agentEvents: any[] = [];
  const byKey = new Map<string, any>();
  let seq = 0, nCalls = 0, truncated = false;
  for (const f of fs) {
    f.agentUses = [];
    for (const a of f.e.ag) {
      if (a[0] && seenTools.has(a[0])) continue;
      if (a[0]) seenTools.add(a[0]);
      f.agentUses.push({ dh: a[3], ph: a[4], hasModel: !!a[2], dc: a[5] });
      if (a[1] >= sinceMs && a[1] <= untilMs) agentEvents.push({ t: a[1], hasModel: !!a[2] });
    }
    f.boundaries = [];
    for (const b of f.e.bd) {
      if (b[0] >= sinceMs && b[0] <= untilMs) { f.boundaries.push(b[0]); compactEvents.push({ t: b[0], trigger: b[1] ? 'manual' : 'auto' }); }
    }
    f.calls = [];
    for (const r of f.e.calls) {
      if (r[0] < sinceMs || r[0] > untilMs) continue;
      const old = r[8] ? byKey.get(r[8]) : null;
      const rec: any = { t: r[0], model: r[1], input: r[2], read: r[3], w5: r[4], w1: r[5], output: r[6], sidechain: r[7] === 1, seq: seq++ };
      if (old) { for (const k of ['input', 'read', 'w5', 'w1', 'output']) if (rec[k] > old[k]) old[k] = rec[k]; continue; }
      if (nCalls >= maxCalls) { truncated = true; continue; }
      nCalls++;
      if (r[8]) byKey.set(r[8], rec);
      f.calls.push(rec);
    }
  }

  // Subagent classification: the sibling meta.json description first, else the parent transcript's Agent tool_use (matched by
  // description hash, or by first-message hash when there is no description); the description's keywords decide, the
  // first user message only when the description matched nothing.
  const parentUses = new Map<string, any[]>(); // parent main transcript path without extension -> Agent uses
  for (const f of fs) if (!f.pathSub && !f.sidechain) parentUses.set(f.path.replace(/\.jsonl$/, ''), f.agentUses);
  for (const f of fs) {
    f.isSubFile = f.pathSub || f.sidechain;
    f.key = hash12(salt, f.rel);
    if (f.isSubFile) {
      const inSubDir = baseName(parentDir(f.path)) === 'subagents';
      const pDir = inSubDir ? parentDir(parentDir(f.path)) : null;
      f.sessionKey = pDir ? hash12(salt, baseName(pDir)) : (f.e.sid || hash12(salt, f.rel));
      const meta = f.meta;
      const desc = meta && typeof meta.description === 'string' ? meta.description : '';
      const uses = pDir ? parentUses.get(pDir) : null;
      let hit: any = null;
      if (uses) {
        if (desc !== '') { const dh = sha(salt, desc); hit = uses.find((u) => u.dh === dh) || null; }
        else if (f.e.fh) hit = uses.find((u) => u.ph === f.e.fh) || null;
      }
      const dcl = desc !== '' ? classifyDescription(desc, kw) : (hit ? hit.dc : null);
      f.descriptionClass = dcl || f.e.fu;
      f.explicitModel = meta ? typeof meta.model === 'string' : (hit ? hit.hasModel : null);
    } else {
      f.sessionKey = f.e.sid || hash12(salt, f.rel);
    }
  }

  const calls: any[] = [];
  const unpriced: Record<string, { calls: number; tokens: number }> = {};
  for (const f of fs) {
    causeTag(f);
    for (const c of f.calls) {
      const p: any = pricing.priceOf(c.model);
      const rec: any = { t: c.t, fileKey: f.key, sessionKey: f.sessionKey, isSub: f.isSubFile || c.sidechain, model: c.model, family: p.family,
        tier: p.tier, priced: !!p.row, input: c.input, read: c.read, w5: c.w5, w1: c.w1, output: c.output, ctx: c.input + c.read + c.w5 + c.w1,
        usd: 0, usdParts: { read: 0, w5: 0, w1: 0, input: 0, output: 0 }, cause: c.cause };
      if (rec.isSub) { rec.descriptionClass = f.descriptionClass || 'unknown'; rec.explicitModel = f.explicitModel === undefined ? null : f.explicitModel; }
      if (p.row) { rec.usdParts = pricing.usdParts(p.row, c); rec.usd = pricing.usdOf(p.row, c); }
      else {
        const k = pricing.strip(c.model) || 'unknown';
        const u = unpriced[k] || (unpriced[k] = { calls: 0, tokens: 0 });
        u.calls++; u.tokens += rec.ctx + rec.output;
      }
      calls.push(rec);
    }
  }
  calls.sort((a, b) => a.t - b.t || (a.fileKey < b.fileKey ? -1 : a.fileKey > b.fileKey ? 1 : 0));
  let auto = 0, manual = 0;
  for (const e of compactEvents) if (e.trigger === 'manual') manual++; else auto++;
  const sortedUnpriced: Record<string, any> = {};
  for (const k of Object.keys(unpriced).sort()) sortedUnpriced[k] = unpriced[k];
  return {
    calls, files: fs.length, skipped_lines: skippedLines, truncated,
    unpriced: sortedUnpriced, compactions: { auto, manual }, compactEvents: compactEvents.sort((a, b) => a.t - b.t),
    agentCalls: { total: agentEvents.length, withModel: agentEvents.filter((e) => e.hasModel).length },
    agentEvents: agentEvents.sort((a, b) => a.t - b.t),
  };
}

// ---- salt and cache (advisor/salt, advisor/scan-cache/<hex>.json)

export async function getSalt(ctx: AdvisorCtx): Promise<string> {
  const f = joinPath(dataDir(ctx), 'salt');
  const cur = await ctx.io.read(f);
  if (cur && /^[0-9a-f]{32}$/.test(cur.trim())) return cur.trim();
  const s = randomHex(16);
  try { await ctx.io.write(f, s + '\n'); } catch { /* read-only home: session-only salt */ }
  return s;
}

export const kwHash = (kw: Kw) => sha1Hex(JSON.stringify([kw.judgment, kw.simple, kw.implementation])).slice(0, 16);
export const shardOf = (ck: string) => (parseInt(ck.slice(0, 2), 16) & 0x3f).toString(16).padStart(2, '0');
export const shardFile = (ctx: AdvisorCtx, hex: string) => joinPath(dataDir(ctx), 'scan-cache', hex + '.json');

async function loadCache(ctx: AdvisorCtx, kwh: string): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (let i = 0; i < SHARDS; i++) {
    const c: any = await readJson(ctx.io, shardFile(ctx, i.toString(16).padStart(2, '0')), null);
    if (c && c.v === CACHE_VERSION && c.pricingDate === pricing.PRICING_DATE && c.keywordsHash === kwh && c.files && typeof c.files === 'object') Object.assign(out, c.files);
  }
  return out;
}

// Rewrites the shards that changed; a shard whose JSON would pass SHARD_MAX_BYTES is not written (its files are read again next time).
export async function saveCache(ctx: AdvisorCtx, kwh: string, keep: Record<string, any>, dirty: Set<string>): Promise<{ written: number; tooBig: number }> {
  const shards = new Map<string, Record<string, any>>();
  for (const k of Object.keys(keep)) {
    const s = shardOf(k);
    if (!dirty.has(s)) continue;
    (shards.get(s) || shards.set(s, {}).get(s)!)[k] = keep[k];
  }
  let written = 0, tooBig = 0;
  for (const s of dirty) {
    const text = JSON.stringify({ v: CACHE_VERSION, pricingDate: pricing.PRICING_DATE, keywordsHash: kwh, files: shards.get(s) || {} });
    if (utf8Bytes(text) > SHARD_MAX_BYTES) { tooBig++; continue; } // bytes, not UTF-16 units: $.fs.read rejects over 4 MiB of bytes
    try { await ctx.io.write(shardFile(ctx, s), text); written++; } catch { /* read-only home: no cache, still answer */ }
  }
  return { written, tooBig };
}

export interface ScanOpts {
  dir: string; sinceMs?: number; untilMs?: number; salt?: string;
  judgmentKeywords?: string[]; simpleKeywords?: string[]; implementationKeywords?: string[];
  maxCalls?: number; cache?: boolean; budgetMs?: number; maxReads?: number; maxFileBytes?: number;
  onProgress?: (done: number, total: number, leftSec: number) => void;
}

// Lists the projects folder (file names and sizes come from the listing), reads what changed (newest first, under an
// optional time budget) and assembles. A file over 4 MiB is not read: it is counted in `coverage`.
export async function scanProjects(ctx: AdvisorCtx, opts: ScanOpts): Promise<any> {
  const io: CmdIO = ctx.io;
  const sinceMs = opts.sinceMs || 0, untilMs = opts.untilMs === undefined ? Infinity : opts.untilMs;
  const maxBytes = opts.maxFileBytes || MAX_READ_BYTES;
  const salt = opts.salt || await getSalt(ctx);
  const kw: Kw = { judgment: opts.judgmentKeywords || [], simple: opts.simpleKeywords || [], implementation: opts.implementationKeywords || [] };
  const useCache = opts.cache !== false;
  const kwh = kwHash(kw);
  const cached = useCache ? await loadCache(ctx, kwh) : {};
  let skippedFiles = 0, staleFiles = 0;
  // read_bytes: bytes of the files that were read (or came from the cache); unread: left by the time budget; failed: a read that returned nothing
  const cov = { files: 0, read: 0, skipped: 0, bytes: 0, skipped_bytes: 0, skipped_main: 0, skipped_sub: 0, read_bytes: 0, unread: 0, failed: 0, failed_bytes: 0 };

  interface Cand { p: string; size: number; mtimeMs: number; ck: string; sub: boolean; entry: any | null; dead?: boolean; big?: boolean }
  const cands: Cand[] = [];
  const onDisk = new Set<string>();
  const listed = (await walkJsonl(io, opts.dir)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of listed) {
    const ck = sha1Hex(salt + f.path);
    onDisk.add(ck);
    if (f.mtimeMs < sinceMs) { staleFiles++; continue; }
    const sub = f.sub || f.name.startsWith('agent-');
    cov.files++; cov.bytes += f.size;
    const c = cached[ck];
    cands.push({ p: f.path, size: f.size, mtimeMs: f.mtimeMs, ck, sub, big: f.size > maxBytes, entry: c && c.size === f.size && c.mtimeMs === f.mtimeMs ? c : null });
  }

  const todo = cands.filter((c) => !c.entry).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.p < b.p ? -1 : 1));
  const total = cands.length, cachedCount = total - todo.length;
  const t0 = Date.now();
  let lastProg = t0, reread = 0, left = todo.length, tick = 0;
  const dirty = new Set<string>();
  for (const c of todo) {
    if ((typeof opts.budgetMs === 'number' && Date.now() - t0 >= opts.budgetMs) || (typeof opts.maxReads === 'number' && reread >= opts.maxReads)) break;
    left--;
    await maybeYield(ctx, ++tick); // every YIELD_EVERY files: let other hooks run
    const text = await io.read(c.p, c.big ? { slim: true, adv: true } : undefined);
    if (text == null) {
      c.dead = true;
      if (c.big) { cov.skipped++; cov.skipped_bytes += c.size; if (c.sub) cov.skipped_sub++; else cov.skipped_main++; } // over 4 MiB and not streamable: counted, not read
      else { skippedFiles++; cov.failed_bytes += c.size; }
      continue;
    }
    c.entry = parseTranscript(text, { size: c.size, mtimeMs: c.mtimeMs }, c.sub, salt, kw);
    dirty.add(shardOf(c.ck));
    reread++;
    const now = Date.now();
    if (opts.onProgress && now - lastProg >= 2000) {
      lastProg = now;
      opts.onProgress(total - left, total, Math.round((now - t0) / 1000 / reread * left));
    }
  }
  const unread = cands.filter((c) => !c.entry && !c.dead).length;
  if (useCache && (reread > 0 || Object.keys(cached).some((k) => !onDisk.has(k)))) {
    const keep: Record<string, any> = {};
    for (const k of Object.keys(cached)) if (onDisk.has(k)) keep[k] = cached[k]; // vanished files drop out
    for (const c of cands) if (c.entry && !c.dead) keep[c.ck] = c.entry;
    for (const k of Object.keys(cached)) if (!onDisk.has(k)) dirty.add(shardOf(k));
    await saveCache(ctx, kwh, keep, dirty);
  }

  cov.unread = unread;
  cov.failed = skippedFiles;
  const files: ScanFile[] = [];
  for (const c of cands) {
    if (!c.entry || c.dead) continue;
    cov.read_bytes += c.size;
    await maybeYield(ctx, files.length + 1);
    let meta: any = null;
    if (c.sub) { const mt = await io.read(c.p.replace(/\.jsonl$/, '.meta.json')); meta = mt ? parseMeta(mt) : null; }
    files.push({ path: c.p, rel: relPath(opts.dir, c.p), e: c.entry, meta });
  }
  cov.read = files.length;
  const res = assemble(files, { sinceMs, untilMs, salt, kw, maxCalls: opts.maxCalls });
  res.skipped_files = skippedFiles;
  res.stale_files = staleFiles;
  res.reread_files = reread;
  res.cached_files = cachedCount;
  res.partial = unread > 0 ? { files_done: total - unread, files_total: total } : null;
  res.coverage = cov;
  return res;
}

export const defaultDir = (ctx: AdvisorCtx) => joinPath(ctx.claudeDir, 'projects');
export { DAY };
