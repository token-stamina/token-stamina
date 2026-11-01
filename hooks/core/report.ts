// Local transcript aggregation (no LLM), ported from scripts/report.js. The file walk and reading
// live in register.ts; this takes each file's text and keeps the per-message maxima.

// Rough relative price weights per model family (output-equivalent tokens are NOT billing; for trend only).
export const WEIGHT: Record<string, number> = { haiku: 1, sonnet: 3, opus: 5, fable: 5 };

export function family(model: unknown): string {
  const m = String(model || '').toLowerCase();
  for (const k of Object.keys(WEIGHT)) if (m.includes(k)) return k;
  return 'other';
}

export interface Usage5 { input: number; cache_read: number; cache_creation: number; output: number; messages: number }
const blank = (): Usage5 => ({ input: 0, cache_read: 0, cache_creation: 0, output: 0, messages: 0 });
const total = (u: Usage5) => u.input + u.cache_read + u.cache_creation + u.output;

export interface ReportOpts { since: string | null; until: string | null }

export interface ReportResult {
  since: string | null;
  until: string | null;
  generated: string;
  files_scanned: number;
  unique_messages: number;
  main: Record<string, Usage5>;
  subagent: Record<string, Usage5>;
  by_day: Record<string, { tokens: number; weighted: number }>;
  agent_calls: { total: number; with_model: number; without_model: number; unspecified_rate: number | null };
  subagent_opus_fable_share: { of_total_tokens: number | null; of_noncache_tokens: number | null; of_output_tokens: number | null };
  weights: Record<string, number>;
}

interface Msg { side: boolean; model: string; u: Usage5; day: string | null }

// The mod command parses every transcript (about 5 s of CPU on a big history, against a 10 s command
// budget), so with neither --since nor --until the window is the last DEFAULT_REPORT_DAYS days.
export const DEFAULT_REPORT_DAYS = 30;
export function defaultWindow(opts: ReportOpts, defaultSince: string): { opts: ReportOpts; defaulted: boolean } {
  if (opts.since || opts.until) return { opts, defaulted: false };
  return { opts: { since: defaultSince, until: null }, defaulted: true };
}
export function defaultWindowNote(lang: string): string {
  return lang === 'ko'
    ? `기본 범위는 최근 ${DEFAULT_REPORT_DAYS}일이에요. 더 넓히려면 --since YYYY-MM-DD 를 붙이세요.`
    : `Default window: the last ${DEFAULT_REPORT_DAYS} days. Widen it with --since YYYY-MM-DD.`;
}

export function sinceMsOf(since: string | null): number {
  return since ? Date.parse(since + 'T00:00:00') : 0;
}

export interface ReportAgg {
  addFile(text: string, fileSub: boolean): void;
  result(): ReportResult;
}

export function createAgg(opts: ReportOpts): ReportAgg {
  const sinceMs = sinceMsOf(opts.since);
  const untilMs = opts.until ? Date.parse(opts.until + 'T00:00:00') + 86400000 : Infinity;
  const msgs = new Map<string, Msg>();
  const toolCalls = new Map<string, { sidechain: boolean; hasModel: boolean }>();
  let files = 0;
  let lines = 0;

  function addFile(text: string, fileSub: boolean): void {
    files++;
    for (const line of text.split('\n')) {
      if (line.indexOf('"usage"') < 0 && line.indexOf('"tool_use"') < 0) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.type !== 'assistant' || !o.message) continue;
      const ts = Date.parse(o.timestamp);
      if (isFinite(ts) && (ts < sinceMs || ts >= untilMs)) continue;
      lines++;
      const side = !!o.isSidechain || fileSub;
      const m = o.message;
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c && c.type === 'tool_use' && (c.name === 'Agent' || c.name === 'Task') && c.id && !toolCalls.has(c.id)) {
            toolCalls.set(c.id, { sidechain: side, hasModel: !!(c.input && c.input.model) });
          }
        }
      }
      const u = m.usage;
      if (!u || !m.model || m.model === '<synthetic>') continue;
      const key = m.id || (o.uuid || String(lines));
      const cur: Msg = msgs.get(key) || { side, model: m.model, u: blank(), day: isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : null };
      cur.u.input = Math.max(cur.u.input, u.input_tokens || 0);
      cur.u.cache_read = Math.max(cur.u.cache_read, u.cache_read_input_tokens || 0);
      cur.u.cache_creation = Math.max(cur.u.cache_creation, u.cache_creation_input_tokens || 0);
      cur.u.output = Math.max(cur.u.output, u.output_tokens || 0);
      if (side) cur.side = true;
      msgs.set(key, cur);
    }
  }

  function result(): ReportResult {
    const out: ReportResult = {
      since: opts.since, until: opts.until, generated: new Date().toISOString(), files_scanned: files,
      unique_messages: msgs.size, main: {}, subagent: {}, by_day: {},
      agent_calls: { total: 0, with_model: 0, without_model: 0, unspecified_rate: null },
      subagent_opus_fable_share: { of_total_tokens: null, of_noncache_tokens: null, of_output_tokens: null },
      weights: WEIGHT,
    };
    for (const v of msgs.values()) {
      const bucket = v.side ? out.subagent : out.main;
      const t = bucket[v.model] || (bucket[v.model] = blank());
      t.input += v.u.input; t.cache_read += v.u.cache_read; t.cache_creation += v.u.cache_creation; t.output += v.u.output; t.messages++;
      if (v.day) {
        const d = out.by_day[v.day] || (out.by_day[v.day] = { tokens: 0, weighted: 0 });
        const n = total(v.u);
        d.tokens += n;
        d.weighted += n * (WEIGHT[family(v.model)] || 1);
      }
    }
    const heavy = (b: Record<string, Usage5>, f: (u: Usage5) => number) => {
      let s = 0;
      for (const [m, u] of Object.entries(b)) { const fam = family(m); if (fam === 'opus' || fam === 'fable') s += f(u); }
      return s;
    };
    const all = (b: Record<string, Usage5>, f: (u: Usage5) => number) => Object.values(b).reduce((s, u) => s + f(u), 0);
    const noCache = (u: Usage5) => u.input + u.cache_creation + u.output;
    out.subagent_opus_fable_share = {
      of_total_tokens: all(out.subagent, total) ? heavy(out.subagent, total) / all(out.subagent, total) : null,
      of_noncache_tokens: all(out.subagent, noCache) ? heavy(out.subagent, noCache) / all(out.subagent, noCache) : null,
      of_output_tokens: all(out.subagent, (u) => u.output) ? heavy(out.subagent, (u) => u.output) / all(out.subagent, (u) => u.output) : null,
    };
    let withM = 0;
    for (const c of toolCalls.values()) if (c.hasModel) withM++;
    out.agent_calls = {
      total: toolCalls.size, with_model: withM, without_model: toolCalls.size - withM,
      unspecified_rate: toolCalls.size ? (toolCalls.size - withM) / toolCalls.size : null,
    };
    return out;
  }

  return { addFile, result };
}

function k(n: number): string {
  n = Math.round(n);
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
const pct = (x: number | null) => (x == null ? '-' : (x * 100).toFixed(1) + '%');

// The Node version prints JSON that the command's .md has Claude summarize; a mod command answers
// without a model, so this renders the same figures as text.
export function render(r: ReportResult, lang: string): string {
  const ko = lang === 'ko';
  const L = (a: string, b: string) => (ko ? a : b);
  const out: string[] = [];
  const span = (r.since || L('처음', 'start')) + ' ~ ' + (r.until || L('지금', 'now'));
  out.push(L(`토큰 사용 요약 (${span}, 파일 ${r.files_scanned}개, 고유 메시지 ${r.unique_messages}개)`, `Token usage report (${span}, ${r.files_scanned} files, ${r.unique_messages} unique messages)`));
  out.push('');
  const head = [L('구분', 'Where'), L('모델', 'Model'), L('메시지', 'Messages'), 'Input', 'Cache read', 'Cache write', 'Output'];
  const rows: string[][] = [];
  for (const [where, b] of [[L('메인', 'main'), r.main], [L('하위 에이전트', 'subagent'), r.subagent]] as [string, Record<string, Usage5>][]) {
    for (const [model, u] of Object.entries(b).sort((a, c) => total(c[1]) - total(a[1]))) {
      rows.push([where, model, String(u.messages), k(u.input), k(u.cache_read), k(u.cache_creation), k(u.output)]);
    }
  }
  if (rows.length) {
    out.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
    for (const row of rows) out.push(`| ${row.join(' | ')} |`);
  } else out.push(L('(사용 기록 없음)', '(no usage records)'));
  out.push('');
  const s = r.subagent_opus_fable_share;
  out.push(L(
    `하위 에이전트 중 Opus/Fable 비중: 전체 토큰 ${pct(s.of_total_tokens)} · 캐시 제외 ${pct(s.of_noncache_tokens)} · 출력 ${pct(s.of_output_tokens)}`,
    `Opus/Fable share of subagent tokens: total ${pct(s.of_total_tokens)} · non-cache ${pct(s.of_noncache_tokens)} · output ${pct(s.of_output_tokens)}`,
  ));
  const a = r.agent_calls;
  out.push(L(
    `Agent 호출 ${a.total}건 중 모델 지정 ${a.with_model}건, 미지정 ${a.without_model}건 (미지정 ${pct(a.unspecified_rate)})`,
    `Agent calls: ${a.total}, with a model ${a.with_model}, without ${a.without_model} (unspecified ${pct(a.unspecified_rate)})`,
  ));
  const days = Object.keys(r.by_day).sort().slice(-7);
  if (days.length) {
    out.push('', L('최근 날짜별 (가중 토큰은 모델 가격 비율 환산, 청구량 아님)', 'By day, newest 7 (weighted = model price ratio, not billing)'));
    out.push(`| ${L('날짜', 'Day')} | ${L('토큰', 'Tokens')} | ${L('가중', 'Weighted')} |`, '|---|---|---|');
    for (const d of days) out.push(`| ${d} | ${k(r.by_day[d]!.tokens)} | ${k(r.by_day[d]!.weighted)} |`);
  }
  return out.join('\n');
}
