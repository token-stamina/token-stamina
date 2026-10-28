// Stop hook: at a work boundary with a big context, show the user a /compact (or new session) hint.
// Ported from scripts/boundary.js. Output is `systemMessage` only (user-facing); never uses
// decision:"block"; nothing goes into model context.
//
// The original `readTail(file, bytes)` did an OS-level partial/offset read (`fs.openSync` +
// `fstatSync` + `readSync` from a computed byte offset). The mods `$.fs` API caps reads at 4 MiB
// and does not support partial/offset reads (PLAN-0.5-mods.md §1), so that cannot be ported as-is.
// `parseTailLines(buf, bytes)` below is the pure replacement: it takes an already-fully-read
// Buffer and does the same "keep only the last `bytes` bytes, drop a possibly-partial first line,
// parse each remaining line as JSON" logic in JS. register.ts (desktop-only, unverified on this PC)
// must whole-file-read the transcript via `$.fs` and pass the resulting Buffer in here.

import { card as _card } from './clear-savings.ts';
import { hintLine } from './clear-savings.ts';
import { thresholds as paceThresholds, type PaceConfig } from './pacer.ts';

export const TAIL_BYTES = 256 * 1024;
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
export const GIT_COMMIT = /\bgit(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+commit\b/;

// Pure replacement for scripts/boundary.js `readTail(file, bytes)`: given the whole file already
// read into a Buffer, keep only the trailing `bytes` bytes, drop a possibly-partial leading line
// when the read started mid-file, and parse each remaining non-blank line as JSON (parse failures
// -- partial or foreign lines -- are silently skipped, exactly as the original did).
export function parseTailLines(buf: Buffer, bytes: number): any[] {
  const size = buf.length;
  const start = Math.max(0, size - bytes);
  const tail = buf.subarray(start);
  let lines = tail.toString('utf8').split('\n');
  if (start > 0) lines = lines.slice(1);
  const out: any[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch (e) {
      /* partial or foreign line */
    }
  }
  return out;
}

export function isRealPrompt(o: any): boolean {
  if (!o || o.type !== 'user' || o.isSidechain || o.isMeta || !o.message) return false;
  const c = o.message.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  if (c.some((b: any) => b && b.type === 'tool_result')) return false;
  return c.some((b: any) => b && b.type === 'text' && String(b.text || '').trim());
}

export function contextTokens(usage: any): number {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
}

export function commitSubject(cmd: string): string | null {
  const hd = /<<-?\s*['"]?(\w+)['"]?\r?\n\s*([^\r\n]+)/.exec(cmd);
  let s: string | null = hd ? hd[2] : null;
  if (!s) {
    const m = /(?:^|\s)-m\s+(?:"([^"\n]*)"|'([^'\n]*)')/.exec(cmd);
    if (m) s = m[1] != null ? m[1] : m[2];
  }
  if (!s) return null;
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

export interface AnalyzeResult {
  tokens: number;
  turnFound: boolean;
  commits: string[];
  commitCount: number;
  edited: boolean;
  endsWithAnswer: boolean;
}

// Pure: entries = parsed transcript lines (tail). Returns {tokens, turnFound, commits[], edited, endsWithAnswer}.
export function analyze(entries: any[]): AnalyzeResult {
  let tokens = 0;
  for (const o of entries) {
    if (o.type === 'assistant' && !o.isSidechain && o.message && o.message.usage && o.message.model !== '<synthetic>') {
      const t = contextTokens(o.message.usage);
      if (t > 0) tokens = t;
    }
  }
  let promptIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--)
    if (isRealPrompt(entries[i])) {
      promptIdx = i;
      break;
    }
  const res: AnalyzeResult = { tokens, turnFound: promptIdx >= 0, commits: [], commitCount: 0, edited: false, endsWithAnswer: false };
  if (promptIdx < 0) return res;
  const failed = new Set<string>();
  const calls: any[] = [];
  let lastAssistant: any[] | null = null;
  for (let i = promptIdx + 1; i < entries.length; i++) {
    const o = entries[i];
    if (!o || o.isSidechain || !o.message) continue;
    const c = o.message.content;
    if (o.type === 'user' && Array.isArray(c)) {
      for (const b of c) if (b && b.type === 'tool_result' && b.is_error) failed.add(b.tool_use_id);
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      lastAssistant = c;
      for (const b of c) if (b && b.type === 'tool_use') calls.push(b);
    }
  }
  const seen = new Set<string>();
  for (const b of calls) {
    if (b.id) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
    }
    if (EDIT_TOOLS.has(b.name)) res.edited = true;
    const cmd = b.input && typeof b.input.command === 'string' ? b.input.command : '';
    if (SHELL_TOOLS.has(b.name) && GIT_COMMIT.test(cmd) && !failed.has(b.id)) {
      res.commitCount++;
      const s = commitSubject(cmd);
      if (s && res.commits.length < 2) res.commits.push(s);
    }
  }
  res.endsWithAnswer = !!lastAssistant && !lastAssistant.some((b) => b && b.type === 'tool_use');
  return res;
}

export function tokLabel(n: number, lang: string | undefined): string {
  if (lang === 'ko' || lang === 'ja') {
    const ja = lang === 'ja';
    if (n >= 10000) {
      const v = Math.round(n / 1000) / 10;
      return (Number.isInteger(v) ? v : v.toFixed(1)) + (ja ? '万' : '만');
    }
    return Math.round(n / 1000) + (ja ? '千' : '천');
  }
  return Math.round(n / 1000) + 'k';
}

export function message(
  res: AnalyzeResult,
  lang: string | undefined,
  level: 'compact' | 'new_session',
  cfg: Record<string, unknown> | undefined,
  prof: Parameters<typeof hintLine>[4],
): string {
  const t = tokLabel(res.tokens, lang);
  const est = hintLine(res.tokens, lang, level === 'new_session' ? 'clear' : 'compact', cfg as any, prof);
  const tail = est ? ' ' + est : '';
  const fill = res.commits.length ? res.commits.join(' · ') : null;
  if (lang === 'ko') {
    if (level === 'new_session') {
      return `Token Stamina: 컨텍스트 ${t} 토큰 — 매 턴 이만큼 다시 읽어요. 새 세션 권장: 결론·남은 일은 파일에 남기고 새로 시작하세요(/clear 뒤에도 자동 저장된 인계 메모가 복원돼요). 이어 가려면 /compact 만 쳐도 되고, 직접 정하려면 /compact ${fill || '(남길 결정·남은 일)'}${tail}`;
    }
    return `Token Stamina: 컨텍스트 ${t} 토큰 — 매 턴 이만큼 다시 읽어요. 작업이 끝났으면 지금 /compact 하기 좋은 때예요. 그냥 /compact 만 쳐도 돼요(자동 저장된 인계 메모가 복원돼요; 단축키는 /token-stamina:setup). 직접 정하려면: /compact ${fill || '(남길 결정·남은 일)'}${tail}`;
  }
  if (lang === 'ja') {
    if (level === 'new_session') {
      return `Token Stamina: コンテキストは ${t} トークン — 毎ターンこれだけ読み直します。新しいセッションをおすすめします: 結論と残りの作業をファイルに残してから始めてください(/clear の後も自動保存した引き継ぎメモが復元されます)。続けるなら /compact だけでも構いません。残す内容を決めるなら /compact ${fill || '(残す決定・残りの作業)'}${tail}`;
    }
    return `Token Stamina: コンテキストは ${t} トークン — 毎ターンこれだけ読み直します。作業が終わったなら今が /compact のしどきです。/compact だけで構いません(自動保存した引き継ぎメモが復元されます; ショートカットは /token-stamina:setup)。決めるなら: /compact ${fill || '(残す決定・残りの作業)'}${tail}`;
  }
  if (level === 'new_session') {
    return `Token Stamina: context is ${t} tokens, re-read every turn. Starting a new session is recommended: save conclusions and open items to a file first (the auto-saved handoff note is restored after /clear). To continue instead, plain /compact works, or choose what to keep: /compact ${fill || '(decisions to keep · what is left)'}${tail}`;
  }
  return `Token Stamina: context is ${t} tokens, re-read every turn. If the task is done, now is a good time to /compact. Plain /compact is enough (the auto-saved handoff note is restored; keybinding: /token-stamina:setup). To choose what to keep: /compact ${fill || '(decisions to keep · what is left)'}${tail}`;
}

export interface BoundaryDecision {
  notify: boolean;
  reason?: string;
  kind?: 'commit' | 'edit';
  level?: 'compact' | 'new_session';
}

// Pure decision. `last` = tokens at the previous notification for this session (or undefined).
// `user` is the raw (not merged-with-defaults) user config.json object -- see pacer.ts `thresholds`
// for why this must stay separate from the already-merged `cfg`.
export function decide(
  res: AnalyzeResult,
  cfg: PaceConfig & { boundary?: boolean; renotifyGrowthTokens?: number },
  user: Record<string, unknown> | undefined,
  last: number | undefined,
): BoundaryDecision {
  // Screen hint (systemMessage) is opt-in: by default Claude writes the hint in its reply (topic-gate inline hint).
  if (cfg.boundary !== true) return { notify: false, reason: 'off' };
  const { compactAt, newAt } = paceThresholds(cfg, user);
  const grow = cfg.renotifyGrowthTokens || 100000;
  if (!res.tokens || res.tokens < compactAt) return { notify: false, reason: 'below_threshold' };
  if (!res.turnFound) return { notify: false, reason: 'no_turn' };
  let kind: 'commit' | 'edit' | null = null;
  if (res.commitCount > 0) kind = 'commit';
  else if (res.edited && res.endsWithAnswer) kind = 'edit';
  if (!kind) return { notify: false, reason: 'not_boundary' };
  // A smaller context than last time means /compact or a new window happened: start over.
  if (typeof last === 'number' && res.tokens >= last && res.tokens < last + grow) return { notify: false, reason: 'renotify_suppressed' };
  return { notify: true, kind, level: res.tokens >= newAt ? 'new_session' : 'compact' };
}
