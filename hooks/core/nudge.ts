// UserPromptSubmit / SessionStart hook: one-line additionalContext when the grade changes.
// Ported from scripts/nudge.js. Already pure in the original (no fs reads inside decide/message),
// so this is a direct port with no signature changes.

import { assess, fmt1, fmtReset, fmtClock, type AssessResult, type PaceConfig, type PaceState } from './pacer.ts';

export interface NudgeMsgTable {
  red7: (a: AssessResult) => string;
  red5: (a: AssessResult) => string;
  yellow: (a: AssessResult) => string;
}

export const MSG: Record<string, NudgeMsgTable> = {
  en: {
    red7: (a) => `Token Stamina: weekly usage ${Math.round((a.d7 as any).used)}% is over pace; today's share is ${fmt1(a.quota as number)}% (resets ${fmtReset((a.d7 as any).resetsAt, 'en')}). Use Sonnet/Haiku for subagents and keep big outputs in subagents.`,
    red5: (a) => `Token Stamina: 5-hour window ${Math.round((a.h5 as any).used)}% used (resets ${fmtClock((a.h5 as any).resetsAt)}). Defer big tasks until after the reset or run subagent work on Haiku/Sonnet.`,
    yellow: (a) => `Token Stamina: slightly over pace (${a.worst}); prefer Sonnet/Haiku for routine subagent work.`,
  },
  ko: {
    red7: (a) => `Token Stamina: 주간 ${Math.round((a.d7 as any).used)}% 로 오늘 몫(${fmt1(a.quota as number)}%)을 넘었어요 (리셋 ${fmtReset((a.d7 as any).resetsAt, 'ko')}). 하위 작업은 Sonnet/Haiku, 큰 출력은 하위 에이전트에.`,
    red5: (a) => `Token Stamina: 5시간 창 ${Math.round((a.h5 as any).used)}% 사용 (리셋 ${fmtClock((a.h5 as any).resetsAt)}). 큰 작업은 리셋 뒤로 미루거나 하위 작업을 Haiku/Sonnet 으로.`,
    yellow: (a) => `Token Stamina: 속도가 약간 빨라요(${a.worst}). 반복 하위 작업은 Sonnet/Haiku 로.`,
  },
};

export function message(a: AssessResult, lang: string | undefined): string | null {
  const m = MSG[lang as string] || MSG.en;
  if (a.grade === 'red') return (a.worst === '5h' ? m.red5 : m.red7)(a);
  if (a.grade === 'yellow') return m.yellow(a);
  return null;
}

export interface NudgeCfg extends PaceConfig {
  nudge?: boolean; lang?: string;
  usageSync?: boolean; usageSyncHintCooldownSec?: number; usageSyncNaBackoffSec?: number;
}
export interface NudgeInput { hook_event_name?: string; session_id?: string }
export interface DecideResult { text: string | null; grade: string | null | undefined; worst?: string | null }

// Pure: returns {text|null, grade} given the previous grade recorded for this session.
// Nudges only on a grade change (green is recorded silently); SessionStart repeats a red line.
export function decide(
  input: NudgeInput,
  state: PaceState | null | undefined,
  cfg: NudgeCfg,
  now: number,
  last: string | null | undefined,
): DecideResult {
  if (cfg.nudge === false) return { text: null, grade: last };
  const a = assess(state, now, cfg);
  if (!a.grade || a.stale) return { text: null, grade: last };
  const changed = a.grade !== last;
  const sessionRed = input.hook_event_name === 'SessionStart' && a.grade === 'red';
  if (!changed && !sessionRed) return { text: null, grade: a.grade };
  return { text: message(a, cfg.lang), grade: a.grade, worst: a.worst };
}

// --- Stage 0: ask Claude (desktop only) to sync the usage record via get_usage -> sync-usage.js ---
// Neutral wording (W7 #8): the hint says what the call does; it never asks Claude to keep anything from the user.
// HEAD.stale(age) when a record exists, HEAD.none when there is none yet (W7 #9: no "none h old").
const SYNC_HEAD: Record<string, { stale: (age: string) => string; none: string }> = {
  ko: { stale: (age: string) => `Token Stamina: 한도 기록이 ${age}시간 전 것이에요.`, none: 'Token Stamina: 아직 한도 기록이 없어요.' },
  en: { stale: (age: string) => `Token Stamina: the usage record is ${age}h old.`, none: 'Token Stamina: there is no usage record yet.' },
  ja: { stale: (age: string) => `Token Stamina: 使用量の記録が${age}時間前のものです。`, none: 'Token Stamina: 使用量の記録はまだありません。' },
};
// 5h fresh, weekly (7d) missing or stale: the hint names the weekly record (mirror of scripts/nudge.js SYNC_HEAD_7D).
const SYNC_HEAD_7D: Record<string, { stale: (age: string) => string; none: string }> = {
  ko: { stale: (age: string) => `Token Stamina: 주간(7d) 한도 기록이 ${age}시간 전 것이에요.`, none: 'Token Stamina: 주간(7d) 한도 기록이 없어요.' },
  en: { stale: (age: string) => `Token Stamina: the weekly (7d) usage record is ${age}h old.`, none: 'Token Stamina: there is no weekly (7d) usage record.' },
  ja: { stale: (age: string) => `Token Stamina: 週間(7d)の使用量の記録が${age}時間前のものです。`, none: 'Token Stamina: 週間(7d)の使用量の記録がありません。' },
};
// Age of the 7d window from its own recorded_at; null when missing or >120 s ahead (unknown). Mirror of nudge.js.
export function syncAgeSec(state: any, now: number): number | null {
  const w = state && state.seven_day;
  const t = w && w.recorded_at;
  if (typeof t !== 'number' || !Number.isFinite(t) || t > now + 120) return null;
  return Math.max(0, now - t);
}
const SYNC_BODY: Record<string, (root: string) => string> = {
  ko: (root: string) => ` 이 세션에서 한 번, mcp__ccd_session_mgmt__get_usage 도구가 있으면 불러서 결과 JSON 을 그대로 \`node "${root}/scripts/sync-usage.js"\` 의 stdin 으로 넘기면 기록이 새로 고쳐져요. 도구가 없으면 건너뛰면 돼요.`,
  en: (root: string) => ` Once in this session, if the tool mcp__ccd_session_mgmt__get_usage exists, calling it and piping its JSON result unchanged into \`node "${root}/scripts/sync-usage.js"\` (stdin) refreshes the record. If the tool does not exist, skip this.`,
  ja: (root: string) => ` このセッションで一度、mcp__ccd_session_mgmt__get_usage ツールがあれば呼び出し、結果の JSON をそのまま \`node "${root}/scripts/sync-usage.js"\` の stdin に渡すと記録が更新されます。ツールがなければ省略してかまいません。`,
};
// Answers from the app that sync-usage.js remembers in last_reject (status:*, invalid:*, no_window): back off on all of them.
const BACKOFF_RE = /^(status:|invalid:|no_window$)/;

export interface SyncBook { hinted_at?: number; hinted_session?: string; last_reject?: { ts?: number; reason?: string } }
export interface SyncAssess { grade?: string | null; stale?: boolean; ageSec?: number | null; d7?: unknown; staleWindows?: string[] }
export interface SyncResult { text: string | null; reason: string; age_sec?: number | null }

export function isDesktop(entrypoint: string | undefined, desktopVersion: string | undefined): boolean {
  return entrypoint === 'claude-desktop' || !!desktopVersion;
}

// Pure mirror of scripts/nudge.js syncHint. env is injected; root = plugin root for the script path.
export function syncHint(
  input: NudgeInput,
  a: SyncAssess | null | undefined,
  cfg: NudgeCfg,
  now: number,
  book: SyncBook | null | undefined,
  env: Record<string, string | undefined>,
  root = '',
): SyncResult {
  if (cfg.usageSync === false) return { text: null, reason: 'disabled' };
  if (!input || input.hook_event_name !== 'SessionStart') return { text: null, reason: 'event' };
  if (!isDesktop(env.CLAUDE_CODE_ENTRYPOINT, env.CLAUDE_CODE_DESKTOP_APP_VERSION)) return { text: null, reason: 'not_desktop' };
  const noState = !a || a.grade === null || a.grade === undefined;
  // per-window freshness: a fresh 5h next to a missing/stale 7d (d7 null) still asks for a sync
  const miss7 = !noState && !a!.stale && !a!.d7;
  if (!noState && !a!.stale && !miss7) return { text: null, reason: 'fresh' };
  const b = book || {};
  const cool = Number.isFinite(cfg.usageSyncHintCooldownSec) ? (cfg.usageSyncHintCooldownSec as number) : 900;
  if (typeof b.hinted_at === 'number' && now - b.hinted_at < cool) return { text: null, reason: 'cooldown' };
  const naSec = Number.isFinite(cfg.usageSyncNaBackoffSec) ? (cfg.usageSyncNaBackoffSec as number) : 86400;
  const lr = b.last_reject;
  if (lr && BACKOFF_RE.test(String(lr.reason)) && typeof lr.ts === 'number' && now - lr.ts < naSec) return { text: null, reason: 'na_backoff' };
  const lang = cfg.lang && SYNC_HEAD[cfg.lang] ? cfg.lang : 'en';
  const ageSec = a && typeof a.ageSec === 'number' && Number.isFinite(a.ageSec) ? a.ageSec : null;
  const H = miss7 ? SYNC_HEAD_7D[lang] : SYNC_HEAD[lang];
  const head = noState || ageSec === null ? H.none : H.stale(String(Math.floor(ageSec / 3600)));
  const reason = noState ? 'no_state' : (miss7 ? ((a!.staleWindows || []).includes('7d') ? 'stale_7d' : 'no_7d') : 'stale');
  return { text: head + SYNC_BODY[lang](root), reason, age_sec: ageSec };
}

// NOTE: the original module's impure `run(raw)` (reads stdin, pace.loadConfig/readState/
// readJson/writeJson/appendEvent/attributed, lang.withLang) is NOT ported here -- that is
// register.ts's job (desktop-only, unverified on this PC).
