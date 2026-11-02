// PreToolUse hook (matcher Bash|PowerShell), advisor R4 companion, ported from scripts/sub-wait.js: when a SUBAGENT is
// about to run a long foreground command, add one short informational line (once per agent_id per session). Never
// blocks. Off unless cfg.subagentLongCmdAdvice === true.
//
// Pure: the Node build keeps the "seen agents" list in <home>/sub-wait/<session>.json (firstTime) and prunes old
// files. Here the caller (register.ts) reads that list, hands it to decide() and writes the returned list back
// (and prunes files older than PRUNE_MS); this module does no file I/O.

import { ADVISOR_DEFAULTS } from './advisor-defaults.ts';

export const LONG_MS = 300000;
export const PRUNE_MS = 2 * 86400000;
export const SEEN_KEEP = 200;

export const T: Record<string, (sig: string) => string> = {
  en: (sig) => `Token Stamina (info): this command may have run over 5 minutes (${sig}). If the subagent waited more than 5 minutes, its prompt cache expired and the next call rewrites it; running long commands in the background from the main session is usually cheaper.`,
  ko: (sig) => `Token Stamina (안내): 이 명령은 5분 넘게 걸렸을 수 있어요 (${sig}). 하위 에이전트가 5분 넘게 기다렸다면 프롬프트 캐시가 만료돼 다음 호출에서 다시 쓰게 돼요. 긴 명령은 메인 세션에서 백그라운드로 돌리는 편이 보통 더 싸요.`,
  ja: (sig) => `Token Stamina (情報): このコマンドは5分以上かかった可能性があります (${sig})。サブエージェントが5分以上待った場合、プロンプトキャッシュは失効し、次の呼び出しで再書き込みされます。長いコマンドはメインセッションのバックグラウンドで実行する方が通常は安価です。`,
};

export interface SubWaitCfg { subagentLongCmdAdvice?: boolean; longCmdPatterns?: unknown; lang?: string }
export interface SubWaitInput { agent_id?: unknown; session_id?: unknown; tool_input?: any }

export function signal(ti: any, cfg: SubWaitCfg): string | null {
  const t = Number(ti.timeout);
  if (isFinite(t) && t > LONG_MS) return `timeout ${Math.round(t / 1000)}s`;
  const cmd = typeof ti.command === 'string' ? ti.command : '';
  if (!cmd) return null;
  const pats = Array.isArray(cfg.longCmdPatterns) ? cfg.longCmdPatterns : ADVISOR_DEFAULTS.longCmdPatterns;
  for (const p of pats) {
    if (typeof p !== 'string' || !p) continue;
    let m: RegExpExecArray | null;
    try { m = new RegExp(p, 'i').exec(cmd); } catch (e) { continue; } // invalid entry: skipped
    if (m) return 'command: ' + cmd.replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  return null;
}

// Pure version of firstTime(): true when `aid` is not in `ids` yet; returns the updated list (newest SEEN_KEEP).
export function firstTime(ids: unknown, aid: string): { first: boolean; seenIds: string[] } {
  const cur = Array.isArray(ids) ? (ids as string[]).slice() : [];
  if (cur.includes(aid)) return { first: false, seenIds: cur };
  cur.push(aid);
  return { first: true, seenIds: cur.slice(-SEEN_KEEP) };
}

// Pure counterpart of run(): same conditions. text is the sentence to add as PreToolUse additionalContext (null = say
// nothing). seenIds is the list to store for this session (unchanged when nothing is said).
export function decide(input: SubWaitInput, cfg: SubWaitCfg, seenIds?: unknown): { text: string | null; seenIds: string[] } {
  const seen = Array.isArray(seenIds) ? (seenIds as string[]) : [];
  const none = { text: null, seenIds: seen };
  if (cfg.subagentLongCmdAdvice !== true) return none;
  if (typeof input.agent_id !== 'string' || !input.agent_id) return none;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (ti.run_in_background === true) return none;
  const sig = signal(ti, cfg);
  if (!sig) return none;
  const f = firstTime(seen, input.agent_id);
  if (!f.first) return none;
  return { text: (T[cfg.lang as string] || T.en)(sig), seenIds: f.seenIds };
}
