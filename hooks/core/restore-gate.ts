// Pure rules for the restore that runs from prompt.submit when a managed plugin sends the classic events and prompt.context
// past this plugin (0.6.15), and the text of /ts-selftest. No file access here.

export interface EndReport { sid: string; reason: string; at: number }

export interface SubmitRestoreIn {
  sid: string;
  nowMs: number;
  first: boolean; // the first real prompt this process sees for the session
  lastEnd: EndReport | null; // the last session.end of this process (never consumed by this rule)
  compactAt: number | null; // when a compaction of this session stood (session.compact), not yet served
  restoredAt: number | null; // when another path (a marker, a classic hook, prompt.context) put a restore in this session
  endMaxAgeMs: number;
  dedupMs: number;
}

// Which restore the prompt.submit path adds beside this prompt: 'compact' after a compaction, 'clear' for the first prompt of a
// session that session.end reported as a clear, else null. A resume, an exit or no report restores nothing (a plain startup too).
// A restore another path already made stands: for a clear anywhere in dedupMs, for a compaction only if it came after it.
export function submitRestoreSource(i: SubmitRestoreIn): 'clear' | 'compact' | null {
  if (i.compactAt !== null && (i.restoredAt === null || i.restoredAt < i.compactAt)) return 'compact';
  if (i.restoredAt !== null && i.nowMs - i.restoredAt < i.dedupMs) return null;
  if (!i.first) return null;
  const e = i.lastEnd;
  if (!e || e.reason !== 'clear') return null;
  if (e.sid === i.sid) return null;
  if (i.nowMs < e.at || i.nowMs - e.at >= i.endMaxAgeMs) return null;
  return 'clear';
}

// A compaction that counts: of the main conversation, a real one (not the ahead-of-time 'precompute'), and it stood (not skipped).
export function compactStood(e: { trigger?: string; agentId?: string } | null | undefined, r: { messages?: unknown; skip?: unknown } | null | undefined): boolean {
  if (!e || e.agentId !== undefined || e.trigger === 'precompute') return false;
  return !!r && r.skip === undefined && Array.isArray(r.messages);
}

export interface FireCounts {
  'classic.SessionStart': number; 'classic.UserPromptSubmit': number; 'classic.Stop': number;
  'prompt.context': number; 'prompt.submit': number; 'turn.complete': number; 'session.end': number; 'session.compact': number;
}
export const FIRE_KEYS: (keyof FireCounts)[] = ['classic.SessionStart', 'classic.UserPromptSubmit', 'classic.Stop', 'prompt.context', 'prompt.submit', 'turn.complete', 'session.end', 'session.compact'];
export const newCounts = (): FireCounts => ({ 'classic.SessionStart': 0, 'classic.UserPromptSubmit': 0, 'classic.Stop': 0, 'prompt.context': 0, 'prompt.submit': 0, 'turn.complete': 0, 'session.end': 0, 'session.compact': 0 });

export interface SelfCheck { name: string; ok: boolean; detail?: string }

export function renderSelftest(counts: FireCounts, bypassed: boolean, checks: SelfCheck[], lang: string): string {
  const ko = lang === 'ko';
  const rows = FIRE_KEYS.map((k) => `  ${k.padEnd(26)} ${counts[k]}`);
  const ctxNote = counts['prompt.submit'] > 0 && counts['prompt.context'] === 0 ? (ko ? ' (prompt.context 는 아직 한 번도 안 왔어요: 건너뛰는 중일 수 있어요)' : ' (prompt.context has not fired yet: it may be skipped)') : '';
  const pass = checks.length > 0 && checks.every((c) => c.ok);
  const out: string[] = [];
  out.push(ko ? 'Token Stamina 자가 점검 (이 프로세스에서 발화한 횟수)' : 'Token Stamina self-test (events fired in this process)');
  out.push(...rows);
  out.push((ko ? '우회 판정: ' : 'bypass: ') + (bypassed ? (ko ? '예 (턴은 도는데 classic 훅이 한 번도 안 왔어요)' : 'yes (turns run, no classic hook ever fired)') : (ko ? '아니오' : 'no')) + ctxNote);
  out.push(ko ? '복원 로직 (임시 폴더, 실제 데이터는 건드리지 않아요):' : 'restore logic (scratch folder, your real data is untouched):');
  for (const c of checks) out.push(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' - ' + c.detail : ''}`);
  out.push(pass ? 'PASS' : 'FAIL');
  return out.join('\n');
}
