// Savings estimate (no LLM), ported from scripts/savings.js: how many tokens the plugin plausibly
// saved, as an ESTIMATE. Every figure compares what happened with a counterfactual "no plugin"
// assumption (stated in the output). The files are read through CmdIO (register.ts fills it from
// $.fs); a transcript over 4 MiB cannot be read there, is counted by io.skipped(), and its
// session then counts as unresolved/unmeasurable.
import { WEIGHT, family } from './report.ts';
import { estimateTokens, joinPath } from './text.ts';
import { baseName, parentDir, walkJsonl, type CmdIO, type FileInfo } from './cmd-io.ts';
import { readEvents } from './events.ts';

export const ALERT_EVENTS = new Set(['inline_hint', 'topic_gate', 'boundary', 'topic_check']);
const ALERT_WINDOW_MS = 3 * 3600 * 1000;
const DEFAULT_MAX_CALLS = 50;

interface U4 { input: number; cache_read: number; cache_creation: number; output: number }
export interface Call { id: string; ts: number; model: string; fam: string; u: U4; idx: number; side: boolean; toolUseIds: string[] }

// Relative cost of one usage record on model family `fam` (cache write 1.25x, cache read 0.1x, output 5x).
export function cost(u: U4, fam: string): number {
  const w = WEIGHT[fam] || 0;
  return ((u.input || 0) + 1.25 * (u.cache_creation || 0) + 0.1 * (u.cache_read || 0) + 5 * (u.output || 0)) * w;
}
export const opusEquiv = (c: number) => c / (WEIGHT.opus as number);
const ctxOf = (u: U4) => (u.input || 0) + (u.cache_read || 0) + (u.cache_creation || 0);
const blank = (): U4 => ({ input: 0, cache_read: 0, cache_creation: 0, output: 0 });

function addUsage(a: U4, b: U4): U4 {
  a.input += b.input || 0; a.cache_read += b.cache_read || 0; a.cache_creation += b.cache_creation || 0; a.output += b.output || 0;
  return a;
}
const fromApi = (u: any): U4 => ({
  input: u.input_tokens || 0, cache_read: u.cache_read_input_tokens || 0,
  cache_creation: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0,
});

const RELEVANT = /"usage"|"toolUseResult"|"tool_result"|compact_boundary|"isCompactSummary"/;

export function parseEntries(txt: string | null): any[] {
  if (txt == null) return [];
  const out: any[] = [];
  for (const line of txt.split('\n')) {
    if (!line || !RELEVANT.test(line)) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

// Unique assistant messages (field-wise max over repeated ids), in order of first appearance.
export function assistantCalls(entries: any[]): Call[] {
  const map = new Map<string, Call>();
  entries.forEach((o, idx) => {
    if (!o || o.type !== 'assistant' || !o.message || !o.message.usage || o.message.model === '<synthetic>') return;
    const m = o.message;
    const key = m.id || o.uuid || 'i' + idx;
    const u = fromApi(m.usage);
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { id: key, ts: Date.parse(o.timestamp), model: m.model, fam: family(m.model), u, idx, side: !!o.isSidechain, toolUseIds: [] });
    } else {
      cur.u.input = Math.max(cur.u.input, u.input); cur.u.cache_read = Math.max(cur.u.cache_read, u.cache_read);
      cur.u.cache_creation = Math.max(cur.u.cache_creation, u.cache_creation); cur.u.output = Math.max(cur.u.output, u.output);
    }
    const c = map.get(key)!;
    if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use' && b.id && !c.toolUseIds.includes(b.id)) c.toolUseIds.push(b.id);
  });
  return Array.from(map.values());
}
const mainCalls = (entries: any[]) => assistantCalls(entries).filter((c) => !c.side);

// The tool_result for a tool_use id -> toolUseResult object (or null).
export function findToolResult(entries: any[], toolUseId: string): any | null {
  for (const o of entries) {
    if (!o || o.type !== 'user' || !o.message || !Array.isArray(o.message.content)) continue;
    if (o.message.content.some((b: any) => b && b.type === 'tool_result' && b.tool_use_id === toolUseId)) return o.toolUseResult || {};
  }
  return null;
}

// Usage of a finished Agent call. The subagent transcript (summed over all its calls) wins when present;
// a sync result's usage may cover only its last call, so it is the fallback.
export function agentUsage(tur: any, subCalls: Call[] | null, fallbackFam: string): { u: U4; fam: string } | null {
  if (!tur) return null;
  let fam = family(tur.resolvedModel);
  if (subCalls && subCalls.length) {
    const u = subCalls.reduce((a, c) => addUsage(a, c.u), blank());
    if (fam === 'other') fam = subCalls[0]!.fam !== 'other' ? subCalls[0]!.fam : fallbackFam;
    return { u, fam };
  }
  if (tur.usage && typeof tur.usage === 'object' && tur.status !== 'async_launched') {
    if (fam === 'other') fam = fallbackFam;
    return { u: fromApi(tur.usage), fam };
  }
  return null;
}

// A. Model downgrades. Assumption: the stronger model would have used the same tokens.
export function downgradeSaving(usage: U4 | null, cfFam: string, actualFam: string): { cost_actual: number; cost_cf: number; saving: number; tokens: number } | null {
  if (!usage || !WEIGHT[cfFam] || !WEIGHT[actualFam]) return null;
  const a = cost(usage, actualFam), c = cost(usage, cfFam);
  return { cost_actual: a, cost_cf: c, saving: Math.max(0, c - a), tokens: usage.input + usage.cache_read + usage.cache_creation + usage.output };
}

// B/C. Tokens no longer re-read: dropped context x number of later calls, each re-read at the cache-read rate.
export function rereadSaving(dropped: number, calls: number, fam: string, maxCalls: number): { calls: number; tokens: number; cost: number } {
  const n = Math.min(calls, maxCalls);
  const tokens = Math.max(0, dropped) * n;
  return { calls: n, tokens, cost: tokens * 0.1 * (WEIGHT[fam] || 0) };
}

// B. The /compact request itself reads the whole context once (cache read) and writes the summary (output).
export function compactCost(preTokens: number, summaryTokensN: number, fam: string): number {
  return (0.1 * preTokens + 5 * summaryTokensN) * (WEIGHT[fam] || 0);
}

// Token estimate of the compact summary message following boundary index bi (null if none).
export function summaryTokens(entries: any[], bi: number, endIdx: number): number | null {
  for (let i = bi + 1; i < Math.min(entries.length, endIdx); i++) {
    const o = entries[i];
    if (o && o.type === 'user' && o.isCompactSummary && o.message) {
      const c = o.message.content;
      return estimateTokens(typeof c === 'string' ? c : JSON.stringify(c));
    }
  }
  return null;
}

const alertsBefore = (events: any[], sid: string, tsMs: number) => events.filter((e) => e.session === sid && ALERT_EVENTS.has(e.event)
  && Date.parse(e.ts) <= tsMs && Date.parse(e.ts) >= tsMs - ALERT_WINDOW_MS);
export const hasAlert = (events: any[], sid: string, tsMs: number) => alertsBefore(events, sid, tsMs).length > 0;
export const lastAlert = (events: any[], sid: string, tsMs: number) => alertsBefore(events, sid, tsMs).pop() || null;

export interface SavingsOpts { since: string; text: boolean; json: boolean }

export function parseArgs(argv: string[], defaultSince: string): SavingsOpts {
  const o: SavingsOpts = { since: defaultSince, text: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') o.since = String(argv[++i] || defaultSince);
    else if (argv[i] === '--json') { o.json = true; o.text = false; }
  }
  return o;
}

// The event log: the old single files and the per-session slot files (core/events.ts).
export { readEvents };

interface Agg { count: number; tokens: number; cost: number; opus_input_equiv: number }
const agg = (): Agg => ({ count: 0, tokens: 0, cost: 0, opus_input_equiv: 0 });
function bump(a: Agg, tokens: number, c: number): void { a.count++; a.tokens += tokens; a.cost += c; a.opus_input_equiv += opusEquiv(c); }

export interface SavingsResult {
  estimate: true;
  period: { since: string; until: string };
  unit: string;
  note: string;
  assumptions: Record<string, string>;
  downgrade: any; compact: any; clear: any; topic_check_cost: any;
  total_opus_input_equiv: number;
}

export async function compute(io: CmdIO, opts: { since: string; projectsDir: string; home: string }, cfg: { savingsMaxCalls?: number }): Promise<SavingsResult> {
  const sinceMs = Date.parse(opts.since + 'T00:00:00');
  const maxCalls = cfg.savingsMaxCalls || DEFAULT_MAX_CALLS;
  const events = await readEvents(io, opts.home, sinceMs);
  const sessions = new Map<string, FileInfo>();
  for (const f of await walkJsonl(io, opts.projectsDir)) if (!f.sub) sessions.set(baseName(f.path, '.jsonl'), f);
  const cache = new Map<string, { file: FileInfo; entries: any[]; calls: Call[] } | null>();
  const load = async (sid: string) => {
    if (cache.has(sid)) return cache.get(sid)!;
    const f = sessions.get(sid);
    let r: { file: FileInfo; entries: any[]; calls: Call[] } | null = null;
    if (f) {
      const entries = parseEntries(await io.read(f.path));
      r = { file: f, entries, calls: mainCalls(entries) };
    }
    cache.set(sid, r);
    return r;
  };

  const A = Object.assign(agg(), { suggest_only: 0, unresolved: 0 });
  const B = Object.assign(agg(), { after_topic_check: 0, after_topic_check_opus_input_equiv: 0, excluded_auto: 0, excluded_no_alert: 0, unmeasurable: 0, compact_overhead_opus_input_equiv: 0, not_worth_it: 0 });
  const C = Object.assign(agg(), { after_topic_check: 0, after_topic_check_opus_input_equiv: 0, unlinked: 0, excluded_no_alert: 0, unmeasurable: 0 });

  // A
  for (const e of events) {
    if (e.event !== 'agent_model') continue;
    if (e.action === 'suggest') { A.suggest_only++; continue; }
    if (e.action !== 'inject') continue;
    const s = e.tool_use_id ? await load(e.session) : null;
    if (!s) { A.unresolved++; continue; }
    const tur = findToolResult(s.entries, e.tool_use_id);
    const caller = s.calls.find((c) => c.toolUseIds.includes(e.tool_use_id))
      || s.calls.filter((c) => c.ts <= Date.parse(e.ts)).pop();
    if (!tur || !caller || caller.fam === 'other') { A.unresolved++; continue; }
    let subCalls: Call[] | null = null;
    if (tur.agentId) {
      const f = joinPath(parentDir(s.file.path), baseName(s.file.path, '.jsonl'), 'subagents', 'agent-' + tur.agentId + '.jsonl');
      if (await io.exists(f)) subCalls = assistantCalls(parseEntries(await io.read(f)));
    }
    const au = agentUsage(tur, subCalls, family(e.model));
    const cfFam = e.requested_model && family(e.requested_model) !== 'other' ? family(e.requested_model) : caller.fam; // explicit upper-tier request is the counterfactual
    const r = au && downgradeSaving(au.u, cfFam, au.fam);
    if (!r) { A.unresolved++; continue; }
    bump(A, r.tokens, r.saving);
  }

  // B: compact boundaries in main transcripts
  for (const [sid, f] of sessions) {
    if (f.mtimeMs < sinceMs) continue;
    const s = await load(sid);
    if (!s) continue;
    const bs = s.entries.map((o, i) => ({ o, i })).filter((x) => x.o && x.o.type === 'system' && x.o.subtype === 'compact_boundary');
    bs.forEach((b, kk) => {
      const ts = Date.parse(b.o.timestamp);
      if (!(ts >= sinceMs)) return;
      const md = b.o.compactMetadata || {};
      if (md.trigger !== 'manual') { B.excluded_auto++; return; }
      if (!hasAlert(events, sid, ts)) { B.excluded_no_alert++; return; }
      const endIdx = kk + 1 < bs.length ? bs[kk + 1]!.i : Infinity;
      const after = s.calls.filter((c) => c.idx > b.i && c.idx < endIdx);
      const before = s.calls.filter((c) => c.idx < b.i).pop();
      const first = after[0];
      const post = typeof md.postTokens === 'number' ? md.postTokens : (first ? ctxOf(first.u) : null);
      const fam = (first || before || ({} as Partial<Call>)).fam as string;
      if (typeof md.preTokens !== 'number' || post === null || !WEIGHT[fam] || md.preTokens - post <= 0 || !after.length) { B.unmeasurable++; return; }
      const r = rereadSaving(md.preTokens - post, after.length, fam, maxCalls);
      const st = summaryTokens(s.entries, b.i, endIdx === Infinity ? s.entries.length : endIdx);
      const overhead = compactCost(md.preTokens, st === null ? post : st, fam);
      B.compact_overhead_opus_input_equiv += opusEquiv(overhead);
      if (r.cost <= overhead) B.not_worth_it++;
      bump(B, r.tokens, Math.max(0, r.cost - overhead));
      if (lastAlert(events, sid, ts)!.event === 'topic_check') { B.after_topic_check++; B.after_topic_check_opus_input_equiv += opusEquiv(Math.max(0, r.cost - overhead)); }
    });
  }

  // C: /clear with a restored handoff note
  for (const e of events) {
    if (e.event !== 'handoff_restore' || e.source !== 'clear') continue;
    if (!e.from_session) { C.unlinked++; continue; }
    const ts = Date.parse(e.ts);
    if (!hasAlert(events, e.from_session, ts)) { C.excluded_no_alert++; continue; }
    const prev = await load(e.from_session);
    const cur = await load(e.session);
    const last = prev && prev.calls[prev.calls.length - 1];
    const first = cur && cur.calls[0];
    if (!last || !first || !WEIGHT[first.fam]) { C.unmeasurable++; continue; }
    const dropped = ctxOf(last.u) - ctxOf(first.u);
    if (dropped <= 0) { C.unmeasurable++; continue; }
    const r = rereadSaving(dropped, cur!.calls.length, first.fam, maxCalls);
    bump(C, r.tokens, r.cost);
    if (lastAlert(events, e.from_session, ts)!.event === 'topic_check') { C.after_topic_check++; C.after_topic_check_opus_input_equiv += opusEquiv(r.cost); }
  }

  // D: cost of the topic-check lines themselves (0.4.2): each line stays in context and is re-read on later calls.
  const D = agg();
  for (const e of events) {
    if (e.event !== 'topic_check') continue;
    const s = await load(e.session);
    const later = s ? s.calls.filter((c) => c.ts > Date.parse(e.ts)) : [];
    const fam = (later[0] || ({} as Partial<Call>)).fam as string;
    const r = rereadSaving(e.line_tokens || 0, later.length, WEIGHT[fam] ? fam : 'opus', maxCalls);
    bump(D, r.tokens, r.cost);
  }

  const total = A.opus_input_equiv + B.opus_input_equiv + C.opus_input_equiv - D.opus_input_equiv;
  return {
    estimate: true,
    period: { since: opts.since, until: new Date().toISOString().slice(0, 10) },
    unit: 'opus_input_equiv = relative cost / Opus weight (Opus input-token equivalents)',
    note: 'Estimate: the difference from what would likely have been used without the plugin, computed under assumptions.',
    assumptions: {
      downgrade: 'The stronger model would have used the same tokens as the downgraded subagent.',
      reread: 'Dropped context would have been re-read from cache on every later call (capped at ' + maxCalls + ' calls), priced at 0.1x input.',
      compact_cost: 'A /compact request reads the whole context once (0.1x) and writes the summary (5x, measured from the summary message, else postTokens); it is subtracted from compact savings, floored at 0. /clear costs nothing.',
      attribution: 'Only manual compacts/clears within 3h after a plugin hint count; auto compacts and unhinted ones are excluded.',
    },
    downgrade: A, compact: B, clear: C, topic_check_cost: D,
    total_opus_input_equiv: total,
  };
}

function k(n: number): string {
  n = Math.round(n);
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

const L: Record<string, any> = {
  ko: {
    head: (r: SavingsResult) => '절약 추정치 (' + r.period.since + ' ~ ' + r.period.until + ') - 모두 추정이에요',
    a: (x: any) => '모델 강등: ' + x.count + '건, ' + k(x.tokens) + ' 토큰, Opus 입력 환산 ' + k(x.opus_input_equiv) + ' (추정)',
    aEx: (x: any) => '  제안만 한 건 ' + x.suggest_only + '건, 계산 못 한 건 ' + x.unresolved + '건은 뺐어요 (추정)',
    b: (x: any) => '알림 뒤 수동 압축: ' + x.count + '건, 다시 안 읽은 토큰 ' + k(x.tokens) + ', Opus 입력 환산 ' + k(x.opus_input_equiv) + ' (추정)',
    bEx: (x: any) => '  압축 요청 비용(환산 ' + k(x.compact_overhead_opus_input_equiv) + ')은 뺐어요, 본전 못 찾은 압축 ' + x.not_worth_it + '건 · 제외: 자동 압축 ' + x.excluded_auto + '건, 알림 없는 수동 압축 ' + x.excluded_no_alert + '건, 측정 불가 ' + x.unmeasurable + '건 (추정)',
    c: (x: any) => '알림 뒤 비우기: ' + x.count + '건, 다시 안 읽은 토큰 ' + k(x.tokens) + ', Opus 입력 환산 ' + k(x.opus_input_equiv) + ' (추정)',
    cEx: (x: any) => '  제외: 연결 불가 ' + x.unlinked + '건, 알림 없음 ' + x.excluded_no_alert + '건, 측정 불가 ' + x.unmeasurable + '건 (추정)',
    d: (x: any, b: any, c: any) => '주제 확인 줄 비용: ' + x.count + '줄, 다시 읽은 토큰 ' + k(x.tokens) + ', Opus 입력 환산 ' + k(x.opus_input_equiv) + '(합계에서 뺌) · 이 줄 뒤 압축 ' + b.after_topic_check + '건, 비우기 ' + c.after_topic_check + '건, 그 절약 ' + k(b.after_topic_check_opus_input_equiv + c.after_topic_check_opus_input_equiv) + ' (추정)',
    t: (r: SavingsResult) => '합계: Opus 입력 토큰 환산 약 ' + k(r.total_opus_input_equiv) + ' (추정)',
    foot: '추정치예요: 플러그인이 없었다면 썼을 양과의 차이를 가정으로 계산했어요. 실제 청구량이 아니에요.',
  },
  en: {
    head: (r: SavingsResult) => 'Savings estimate (' + r.period.since + ' to ' + r.period.until + ') - all figures are estimates',
    a: (x: any) => 'Model downgrade: ' + x.count + ' calls, ' + k(x.tokens) + ' tokens, Opus-input equiv ' + k(x.opus_input_equiv) + ' (est.)',
    aEx: (x: any) => '  Excluded: suggest-only ' + x.suggest_only + ', unresolvable ' + x.unresolved + ' (est.)',
    b: (x: any) => 'Manual compact after hint: ' + x.count + ', tokens not re-read ' + k(x.tokens) + ', Opus-input equiv ' + k(x.opus_input_equiv) + ' (est.)',
    bEx: (x: any) => '  Compact request cost ' + k(x.compact_overhead_opus_input_equiv) + ' subtracted, compacts that did not pay off ' + x.not_worth_it + ' · Excluded: auto compacts ' + x.excluded_auto + ', manual without hint ' + x.excluded_no_alert + ', unmeasurable ' + x.unmeasurable + ' (est.)',
    c: (x: any) => 'Clear after hint: ' + x.count + ', tokens not re-read ' + k(x.tokens) + ', Opus-input equiv ' + k(x.opus_input_equiv) + ' (est.)',
    cEx: (x: any) => '  Excluded: unlinked ' + x.unlinked + ', no hint ' + x.excluded_no_alert + ', unmeasurable ' + x.unmeasurable + ' (est.)',
    d: (x: any, b: any, c: any) => 'Topic-check line cost: ' + x.count + ' lines, re-read tokens ' + k(x.tokens) + ', Opus-input equiv ' + k(x.opus_input_equiv) + ' (subtracted from the total) · after such a line: compacts ' + b.after_topic_check + ', clears ' + c.after_topic_check + ', their saving ' + k(b.after_topic_check_opus_input_equiv + c.after_topic_check_opus_input_equiv) + ' (est.)',
    t: (r: SavingsResult) => 'Total: about ' + k(r.total_opus_input_equiv) + ' Opus input-token equivalents (est.)',
    foot: 'This is an estimate: the difference from what would likely have been used without the plugin, computed under assumptions. Not actual billing.',
  },
};

export function renderText(r: SavingsResult, lang: string): string {
  const t: any = L[lang] || L.en;
  return [t.head(r), t.a(r.downgrade), t.aEx(r.downgrade), t.b(r.compact), t.bEx(r.compact), t.c(r.clear), t.cEx(r.clear), t.d(r.topic_check_cost, r.compact, r.clear), t.t(r), t.foot].join('\n');
}
