'use strict';
// Savings estimate (no LLM): how many tokens the plugin plausibly saved, as an ESTIMATE.
// Every figure compares what happened with a counterfactual "no plugin" assumption (stated in the output).
// Usage: node savings.js [--since YYYY-MM-DD] [--dir <projects dir>] [--text]
const fs = require('fs');
const os = require('os');
const path = require('path');
const pace = require('./pace');
const { WEIGHT, walk, family } = require('./report');
const { estimateTokens } = require('./audit');

const ALERT_EVENTS = new Set(['inline_hint', 'topic_gate', 'boundary', 'topic_check']);
const ALERT_WINDOW_MS = 3 * 3600 * 1000;
const DEFAULT_MAX_CALLS = 50;

// Relative cost of one usage record on model family `fam` (cache write 1.25x, cache read 0.1x, output 5x).
function cost(u, fam) {
  const w = WEIGHT[fam] || 0;
  return ((u.input || 0) + 1.25 * (u.cache_creation || 0) + 0.1 * (u.cache_read || 0) + 5 * (u.output || 0)) * w;
}
const opusEquiv = (c) => c / WEIGHT.opus;
const ctxOf = (u) => (u.input || 0) + (u.cache_read || 0) + (u.cache_creation || 0);
const blank = () => ({ input: 0, cache_read: 0, cache_creation: 0, output: 0 });

function addUsage(a, b) {
  a.input += b.input || 0; a.cache_read += b.cache_read || 0; a.cache_creation += b.cache_creation || 0; a.output += b.output || 0;
  return a;
}
// Raw API usage ({input_tokens, ...}) -> internal shape.
const fromApi = (u) => ({ input: u.input_tokens || 0, cache_read: u.cache_read_input_tokens || 0,
  cache_creation: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 });

const RELEVANT = /"usage"|"toolUseResult"|"tool_result"|compact_boundary|"isCompactSummary"/;

function readEntries(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line || !RELEVANT.test(line)) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* skip */ }
  }
  return out;
}

// Pure: unique assistant messages (field-wise max over repeated ids), in order of first appearance.
// Each: {id, ts, model, fam, u, idx, side, toolUseIds}
function assistantCalls(entries) {
  const map = new Map();
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
    const c = map.get(key);
    if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use' && b.id && !c.toolUseIds.includes(b.id)) c.toolUseIds.push(b.id);
  });
  return Array.from(map.values());
}
const mainCalls = (entries) => assistantCalls(entries).filter((c) => !c.side);

// Pure: find the tool_result for a tool_use id -> toolUseResult object (or null).
function findToolResult(entries, toolUseId) {
  for (const o of entries) {
    if (!o || o.type !== 'user' || !o.message || !Array.isArray(o.message.content)) continue;
    if (o.message.content.some((b) => b && b.type === 'tool_result' && b.tool_use_id === toolUseId)) return o.toolUseResult || {};
  }
  return null;
}

// Pure: usage of a finished Agent call. The subagent transcript (summed over all its calls) wins when present;
// a sync result's usage may cover only its last call, so it is the fallback.
// Returns {u, fam} or null. subCalls = unique assistant messages of the subagent file (or null).
function agentUsage(tur, subCalls, fallbackFam) {
  if (!tur) return null;
  let fam = family(tur.resolvedModel);
  if (subCalls && subCalls.length) {
    const u = subCalls.reduce((a, c) => addUsage(a, c.u), blank());
    if (fam === 'other') fam = subCalls[0].fam !== 'other' ? subCalls[0].fam : fallbackFam;
    return { u, fam };
  }
  if (tur.usage && typeof tur.usage === 'object' && tur.status !== 'async_launched') {
    if (fam === 'other') fam = fallbackFam;
    return { u: fromApi(tur.usage), fam };
  }
  return null;
}

// A. Model downgrades. Assumption: the stronger model would have used the same tokens.
// Returns {saving, cost_actual, cost_cf, tokens} or null when it cannot be priced.
function downgradeSaving(usage, cfFam, actualFam) {
  if (!usage || !WEIGHT[cfFam] || !WEIGHT[actualFam]) return null;
  const a = cost(usage, actualFam), c = cost(usage, cfFam);
  return { cost_actual: a, cost_cf: c, saving: Math.max(0, c - a), tokens: usage.input + usage.cache_read + usage.cache_creation + usage.output };
}

// B/C. Tokens no longer re-read: dropped context x number of later calls, each re-read at the cache-read rate.
function rereadSaving(dropped, calls, fam, maxCalls) {
  const n = Math.min(calls, maxCalls);
  const tokens = Math.max(0, dropped) * n;
  return { calls: n, tokens, cost: tokens * 0.1 * (WEIGHT[fam] || 0) };
}

// B. The /compact request itself reads the whole context once (cache read) and writes the summary (output).
// summaryTokens is measured from the summary message when present; postTokens is the upper-bound fallback.
function compactCost(preTokens, summaryTokens, fam) {
  return (0.1 * preTokens + 5 * summaryTokens) * (WEIGHT[fam] || 0);
}

// Pure: token estimate of the compact summary message following boundary index bi (null if none).
function summaryTokens(entries, bi, endIdx) {
  for (let i = bi + 1; i < Math.min(entries.length, endIdx); i++) {
    const o = entries[i];
    if (o && o.type === 'user' && o.isCompactSummary && o.message) {
      const c = o.message.content;
      return estimateTokens(typeof c === 'string' ? c : JSON.stringify(c));
    }
  }
  return null;
}

const alertsBefore = (events, sid, tsMs) => events.filter((e) => e.session === sid && ALERT_EVENTS.has(e.event)
  && Date.parse(e.ts) <= tsMs && Date.parse(e.ts) >= tsMs - ALERT_WINDOW_MS);
const hasAlert = (events, sid, tsMs) => alertsBefore(events, sid, tsMs).length > 0;
// The alert that most plausibly prompted the action: the latest one in the window.
const lastAlert = (events, sid, tsMs) => alertsBefore(events, sid, tsMs).pop() || null;

function parseArgs(argv) {
  const d = new Date(Date.now() - 7 * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  const o = { since: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), dir: path.join(os.homedir(), '.claude', 'projects'), text: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') o.since = argv[++i];
    else if (argv[i] === '--dir') o.dir = argv[++i];
    else if (argv[i] === '--text') o.text = true;
  }
  return o;
}

function readEvents(sinceMs) {
  const out = [];
  let txt = '';
  try { txt = fs.readFileSync(path.join(pace.home(), 'events.jsonl'), 'utf8'); } catch (e) { return out; }
  for (const line of txt.split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (Date.parse(e.ts) >= sinceMs) out.push(e); } catch (e) { /* skip */ }
  }
  return out;
}

// sessionId -> main transcript path
function indexSessions(dir) {
  const idx = new Map();
  for (const f of walk(dir)) {
    if (f.split(path.sep).includes('subagents')) continue;
    idx.set(path.basename(f, '.jsonl'), f);
  }
  return idx;
}

const agg = () => ({ count: 0, tokens: 0, cost: 0, opus_input_equiv: 0 });
function bump(a, tokens, c) { a.count++; a.tokens += tokens; a.cost += c; a.opus_input_equiv += opusEquiv(c); }

// Impure part: read events and transcripts, return the full report object.
function compute(opts, cfg) {
  cfg = cfg || pace.loadConfig();
  const sinceMs = Date.parse(opts.since + 'T00:00:00');
  const maxCalls = cfg.savingsMaxCalls || DEFAULT_MAX_CALLS;
  const events = readEvents(sinceMs);
  const sessions = indexSessions(opts.dir);
  const cache = new Map();
  const load = (sid) => {
    if (cache.has(sid)) return cache.get(sid);
    const f = sessions.get(sid);
    const r = f ? { file: f, entries: readEntries(f) } : null;
    if (r) r.calls = mainCalls(r.entries);
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
    const s = e.tool_use_id ? load(e.session) : null;
    if (!s) { A.unresolved++; continue; }
    const tur = findToolResult(s.entries, e.tool_use_id);
    const caller = s.calls.find((c) => c.toolUseIds.includes(e.tool_use_id))
      || s.calls.filter((c) => c.ts <= Date.parse(e.ts)).pop();
    if (!tur || !caller || caller.fam === 'other') { A.unresolved++; continue; }
    let subCalls = null;
    if (tur.agentId) {
      const f = path.join(path.dirname(s.file), path.basename(s.file, '.jsonl'), 'subagents', 'agent-' + tur.agentId + '.jsonl');
      if (fs.existsSync(f)) subCalls = assistantCalls(readEntries(f));
    }
    const au = agentUsage(tur, subCalls, family(e.model));
    const r = au && downgradeSaving(au.u, caller.fam, au.fam);
    if (!r) { A.unresolved++; continue; }
    bump(A, r.tokens, r.saving);
  }

  // B: compact boundaries in main transcripts
  for (const [sid, f] of sessions) {
    let st; try { st = fs.statSync(f); } catch (e) { continue; }
    if (st.mtimeMs < sinceMs) continue;
    const s = load(sid);
    if (!s) continue;
    const bs = s.entries.map((o, i) => ({ o, i })).filter((x) => x.o && x.o.type === 'system' && x.o.subtype === 'compact_boundary');
    bs.forEach((b, k) => {
      const ts = Date.parse(b.o.timestamp);
      if (!(ts >= sinceMs)) return;
      const md = b.o.compactMetadata || {};
      if (md.trigger !== 'manual') { B.excluded_auto++; return; }
      if (!hasAlert(events, sid, ts)) { B.excluded_no_alert++; return; }
      const endIdx = k + 1 < bs.length ? bs[k + 1].i : Infinity;
      const after = s.calls.filter((c) => c.idx > b.i && c.idx < endIdx);
      const before = s.calls.filter((c) => c.idx < b.i).pop();
      const first = after[0];
      const post = typeof md.postTokens === 'number' ? md.postTokens : (first ? ctxOf(first.u) : null);
      const fam = (first || before || {}).fam;
      if (typeof md.preTokens !== 'number' || post === null || !WEIGHT[fam] || md.preTokens - post <= 0 || !after.length) { B.unmeasurable++; return; }
      const r = rereadSaving(md.preTokens - post, after.length, fam, maxCalls);
      const st = summaryTokens(s.entries, b.i, endIdx === Infinity ? s.entries.length : endIdx);
      const overhead = compactCost(md.preTokens, st === null ? post : st, fam);
      B.compact_overhead_opus_input_equiv += opusEquiv(overhead);
      if (r.cost <= overhead) B.not_worth_it++;
      bump(B, r.tokens, Math.max(0, r.cost - overhead));
      if (lastAlert(events, sid, ts).event === 'topic_check') { B.after_topic_check++; B.after_topic_check_opus_input_equiv += opusEquiv(Math.max(0, r.cost - overhead)); }
    });
  }

  // C: /clear with a restored handoff note
  for (const e of events) {
    if (e.event !== 'handoff_restore' || e.source !== 'clear') continue;
    if (!e.from_session) { C.unlinked++; continue; }
    const ts = Date.parse(e.ts);
    if (!hasAlert(events, e.from_session, ts)) { C.excluded_no_alert++; continue; }
    const prev = load(e.from_session), cur = load(e.session);
    const last = prev && prev.calls[prev.calls.length - 1];
    const first = cur && cur.calls[0];
    if (!last || !first || !WEIGHT[first.fam]) { C.unmeasurable++; continue; }
    const dropped = ctxOf(last.u) - ctxOf(first.u);
    if (dropped <= 0) { C.unmeasurable++; continue; }
    const r = rereadSaving(dropped, cur.calls.length, first.fam, maxCalls);
    bump(C, r.tokens, r.cost);
    if (lastAlert(events, e.from_session, ts).event === 'topic_check') { C.after_topic_check++; C.after_topic_check_opus_input_equiv += opusEquiv(r.cost); }
  }

  // D: cost of the topic-check lines themselves (0.4.2): each line stays in context and is re-read on later calls.
  const D = agg();
  for (const e of events) {
    if (e.event !== 'topic_check') continue;
    const s = load(e.session);
    const later = s ? s.calls.filter((c) => c.ts > Date.parse(e.ts)) : [];
    const fam = (later[0] || {}).fam;
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

const L = {
  ko: {
    head: (r) => '절약 추정치 (' + r.period.since + ' ~ ' + r.period.until + ') - 모두 추정이에요',
    a: (x) => '모델 강등: ' + x.count + '건, ' + k(x.tokens) + ' 토큰, Opus 입력 환산 ' + k(x.opus_input_equiv) + ' (추정)',
    aEx: (x) => '  제안만 한 건 ' + x.suggest_only + '건, 계산 못 한 건 ' + x.unresolved + '건은 뺐어요 (추정)',
    b: (x) => '알림 뒤 수동 압축: ' + x.count + '건, 다시 안 읽은 토큰 ' + k(x.tokens) + ', Opus 입력 환산 ' + k(x.opus_input_equiv) + ' (추정)',
    bEx: (x) => '  압축 요청 비용(환산 ' + k(x.compact_overhead_opus_input_equiv) + ')은 뺐어요, 본전 못 찾은 압축 ' + x.not_worth_it + '건 · 제외: 자동 압축 ' + x.excluded_auto + '건, 알림 없는 수동 압축 ' + x.excluded_no_alert + '건, 측정 불가 ' + x.unmeasurable + '건 (추정)',
    c: (x) => '알림 뒤 비우기: ' + x.count + '건, 다시 안 읽은 토큰 ' + k(x.tokens) + ', Opus 입력 환산 ' + k(x.opus_input_equiv) + ' (추정)',
    cEx: (x) => '  제외: 연결 불가 ' + x.unlinked + '건, 알림 없음 ' + x.excluded_no_alert + '건, 측정 불가 ' + x.unmeasurable + '건 (추정)',
    d: (x, b, c) => '주제 확인 줄 비용: ' + x.count + '줄, 다시 읽은 토큰 ' + k(x.tokens) + ', Opus 입력 환산 ' + k(x.opus_input_equiv) + '(합계에서 뺌) · 이 줄 뒤 압축 ' + b.after_topic_check + '건, 비우기 ' + c.after_topic_check + '건, 그 절약 ' + k(b.after_topic_check_opus_input_equiv + c.after_topic_check_opus_input_equiv) + ' (추정)',
    t: (r) => '합계: Opus 입력 토큰 환산 약 ' + k(r.total_opus_input_equiv) + ' (추정)',
    foot: '추정치예요: 플러그인이 없었다면 썼을 양과의 차이를 가정으로 계산했어요. 실제 청구량이 아니에요.',
  },
  en: {
    head: (r) => 'Savings estimate (' + r.period.since + ' to ' + r.period.until + ') - all figures are estimates',
    a: (x) => 'Model downgrade: ' + x.count + ' calls, ' + k(x.tokens) + ' tokens, Opus-input equiv ' + k(x.opus_input_equiv) + ' (est.)',
    aEx: (x) => '  Excluded: suggest-only ' + x.suggest_only + ', unresolvable ' + x.unresolved + ' (est.)',
    b: (x) => 'Manual compact after hint: ' + x.count + ', tokens not re-read ' + k(x.tokens) + ', Opus-input equiv ' + k(x.opus_input_equiv) + ' (est.)',
    bEx: (x) => '  Compact request cost ' + k(x.compact_overhead_opus_input_equiv) + ' subtracted, compacts that did not pay off ' + x.not_worth_it + ' · Excluded: auto compacts ' + x.excluded_auto + ', manual without hint ' + x.excluded_no_alert + ', unmeasurable ' + x.unmeasurable + ' (est.)',
    c: (x) => 'Clear after hint: ' + x.count + ', tokens not re-read ' + k(x.tokens) + ', Opus-input equiv ' + k(x.opus_input_equiv) + ' (est.)',
    cEx: (x) => '  Excluded: unlinked ' + x.unlinked + ', no hint ' + x.excluded_no_alert + ', unmeasurable ' + x.unmeasurable + ' (est.)',
    d: (x, b, c) => 'Topic-check line cost: ' + x.count + ' lines, re-read tokens ' + k(x.tokens) + ', Opus-input equiv ' + k(x.opus_input_equiv) + ' (subtracted from the total) · after such a line: compacts ' + b.after_topic_check + ', clears ' + c.after_topic_check + ', their saving ' + k(b.after_topic_check_opus_input_equiv + c.after_topic_check_opus_input_equiv) + ' (est.)',
    t: (r) => 'Total: about ' + k(r.total_opus_input_equiv) + ' Opus input-token equivalents (est.)',
    foot: 'This is an estimate: the difference from what would likely have been used without the plugin, computed under assumptions. Not actual billing.',
  },
};
function k(n) {
  n = Math.round(n);
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function renderText(r, lang) {
  const t = L[lang] || L.en;
  return [t.head(r), t.a(r.downgrade), t.aEx(r.downgrade), t.b(r.compact), t.bEx(r.compact), t.c(r.clear), t.cEx(r.clear), t.d(r.topic_check_cost, r.compact, r.clear), t.t(r), t.foot].join('\n') + '\n';
}

module.exports = { cost, opusEquiv, assistantCalls, findToolResult, agentUsage, downgradeSaving, rereadSaving, compactCost, summaryTokens, hasAlert, lastAlert, parseArgs, compute, renderText, ALERT_EVENTS };

if (require.main === module) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const r = compute(o);
    process.stdout.write(o.text ? renderText(r, require('./lang').withLang(pace.loadConfig(), {}).lang) : JSON.stringify(r, null, 2) + '\n');
  } catch (e) { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); }
}
