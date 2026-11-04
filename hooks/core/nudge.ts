// UserPromptSubmit / SessionStart hook: one-line additionalContext when the grade changes.
// Ported from scripts/nudge.js. Already pure in the original (no fs reads inside decide/message),
// so this is a direct port with no signature changes.

import { assess, RANK, fmt1, fmtReset, fmtClock, type AssessResult, type PaceConfig, type PaceState } from './pacer.ts';

export interface NudgeMsgTable {
  red7: (a: AssessResult, cfg?: NudgeCfg) => string;
  red5: (a: AssessResult, cfg?: NudgeCfg) => string;
  yellow7: (a: AssessResult, cfg?: NudgeCfg) => string;
  yellow5: (a: AssessResult, cfg?: NudgeCfg) => string;
}

// Every % is against the window's own limit: U = used, E = share of the window already elapsed, Q = daily share
// that lasts to the reset, X = projected exhaustion time. The Sonnet/Haiku clause is left out for people who already default to them.
const cheapAlready = (cfg?: NudgeCfg): boolean => /^(sonnet|haiku)/i.test(String((cfg && cfg.agentModelDefault) || ''));
const u7 = (a: AssessResult) => Math.round((a.d7 as any).used);
const e7 = (a: AssessResult) => Math.round((a.d7 as any).elapsedPct);
const u5 = (a: AssessResult) => Math.round((a.h5 as any).used);
const e5 = (a: AssessResult) => Math.round((a.h5 as any).elapsedPct);
const r7 = (a: AssessResult, lang: string) => fmtReset((a.d7 as any).resetsAt, lang);
const r5 = (a: AssessResult) => fmtClock((a.h5 as any).resetsAt);

export const MSG: Record<string, NudgeMsgTable> = {
  en: {
    red7: (a, cfg) =>
      `Token Stamina: weekly limit ${u7(a)}% used with ${e7(a)}% of the week gone. ` +
      (a.exhaust7d != null ? `At this rate it runs out ${fmtReset(a.exhaust7d, 'en')} (resets ${r7(a, 'en')})` : 'At this rate it runs out before the reset') +
      `; staying under ${fmt1(a.quota as number)}% a day lasts to the reset.` +
      (cheapAlready(cfg) ? '' : ' Use Sonnet/Haiku for subagents.'),
    red5: (a) =>
      `Token Stamina: 5-hour window ${u5(a)}% used with ${e5(a)}% of it gone. ` +
      (a.exhaust5h != null ? `At this rate it runs out at ${fmtClock(a.exhaust5h)} (resets ${r5(a)}). ` : `It resets at ${r5(a)}. `) +
      'Defer big tasks until after the reset.',
    yellow7: (a) => `Token Stamina: weekly limit ${u7(a)}% used with ${e7(a)}% of the week gone, slightly ahead of pace. Staying under ${fmt1(a.quota as number)}% a day lasts to the reset.`,
    yellow5: (a) => `Token Stamina: 5-hour window ${u5(a)}% used with ${e5(a)}% of it gone, slightly ahead of pace (resets ${r5(a)}).`,
  },
  ko: {
    red7: (a, cfg) =>
      `Token Stamina: 주간 한도 ${u7(a)}% 사용(기간은 ${e7(a)}% 지남). ` +
      (a.exhaust7d != null ? `이 속도면 ${fmtReset(a.exhaust7d, 'ko')} 에 소진돼요(리셋 ${r7(a, 'ko')}).` : '이 속도면 리셋 전에 소진돼요.') +
      ` 리셋까지 하루 ${fmt1(a.quota as number)}% 안에 쓰면 돼요.` +
      (cheapAlready(cfg) ? '' : ' 하위 에이전트는 Sonnet/Haiku 로.'),
    red5: (a) =>
      `Token Stamina: 5시간 창 ${u5(a)}% 사용(시간은 ${e5(a)}% 지남). ` +
      (a.exhaust5h != null ? `이 속도면 ${fmtClock(a.exhaust5h)} 에 소진돼요(리셋 ${r5(a)}).` : `리셋은 ${r5(a)} 이에요.`) +
      ' 큰 작업은 리셋 뒤로 미루세요.',
    yellow7: (a) => `Token Stamina: 주간 한도 ${u7(a)}% 사용(기간은 ${e7(a)}% 지남), 조금 빨라요. 리셋까지 하루 ${fmt1(a.quota as number)}% 안에 쓰면 돼요.`,
    yellow5: (a) => `Token Stamina: 5시간 창 ${u5(a)}% 사용(시간은 ${e5(a)}% 지남), 조금 빨라요(리셋 ${r5(a)}).`,
  },
};

export function message(a: AssessResult, lang: string | undefined, cfg?: NudgeCfg): string | null {
  const m = MSG[lang as string] || MSG.en;
  if (a.grade === 'red') return (a.worst === '5h' ? m.red5 : m.red7)(a, cfg);
  if (a.grade === 'yellow') return (a.worst === '5h' ? m.yellow5 : m.yellow7)(a, cfg);
  return null;
}

export interface NudgeCfg extends PaceConfig {
  nudge?: boolean; lang?: string;
  nudgeCooldownSec?: number; agentModelDefault?: string;
  usageSync?: boolean; usageSyncHintCooldownSec?: number; usageSyncNaBackoffSec?: number;
}
export interface NudgeInput { hook_event_name?: string; session_id?: string }
export interface NudgeGlobal { grade: string; ts: number }
export interface DecideResult { text: string | null; grade: string | null | undefined; worst?: string | null; global?: NudgeGlobal }

// Pure: returns {text|null, grade, global?} given the previous grade recorded for this session and the machine-wide
// last alert. Nudges only on a grade change (green is recorded silently); SessionStart repeats a red line. Within
// nudgeCooldownSec (3h) of the last alert on this machine only a worse grade speaks, so yellow/red flapping and a second
// session's identical red stay quiet. `global` is returned only when a line is sent.
export function decide(
  input: NudgeInput,
  state: PaceState | null | undefined,
  cfg: NudgeCfg,
  now: number,
  last: string | null | undefined,
  global?: NudgeGlobal | null,
): DecideResult {
  if (cfg.nudge === false) return { text: null, grade: last };
  const a = assess(state, now, cfg);
  if (!a.grade || a.stale) return { text: null, grade: last };
  const changed = a.grade !== last;
  const sessionRed = input.hook_event_name === 'SessionStart' && a.grade === 'red';
  if (!changed && !sessionRed) return { text: null, grade: a.grade };
  const cool = typeof cfg.nudgeCooldownSec === 'number' && isFinite(cfg.nudgeCooldownSec) ? cfg.nudgeCooldownSec : 10800;
  if (global && typeof global.ts === 'number' && now - global.ts < cool && RANK[a.grade] <= (RANK[global.grade] ?? -1)) return { text: null, grade: a.grade };
  const text = message(a, cfg.lang, cfg);
  if (!text) return { text: null, grade: a.grade, worst: a.worst };
  return { text, grade: a.grade, worst: a.worst, global: { grade: a.grade, ts: now } };
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

// oldModelWarn (advisor R5): one systemMessage per session when the transcript tail's last assistant model is an old tier.
// Node's oldModelNotice reads the tail (boundary.readTail), old-model-warn.json (pace.readJson/writeJson) and
// advisor/pricing itself; here the caller hands them in through deps and persists the returned book:
//   deps.entries  parsed transcript tail (boundary.parseTailLines)
//   deps.book     contents of old-model-warn.json ({[sid]: ms}) or null
//   deps.priceOf  model id -> {tier, key?}  (advisor pricing)
//   deps.strip    optional model-id shortener used when priceOf gives no key
//   deps.now      optional clock
// Returns {text, book}; text '' = nothing to say (book unchanged).
export const OLD_MODEL: Record<string, (m: string) => string> = {
  en: (m) => `Token Stamina: this session runs ${m}, an older model generation with higher prices. Starting a new session on the current model is usually cheaper.`,
  ko: (m) => `Token Stamina: 이 세션은 구세대 모델(${m})로 돌아가고 있어요. 단가가 더 높으니 현재 세대 모델로 새 세션을 여는 편이 보통 더 싸요.`,
  ja: (m) => `Token Stamina: このセッションは旧世代のモデル(${m})で動いています。単価が高いため、現行モデルで新しいセッションを始める方が通常は安くなります。`,
};
export interface OldModelDeps {
  entries: any[];
  book?: unknown;
  priceOf: (model: string) => { tier?: string; key?: string };
  strip?: (model: string) => string;
  now?: number;
}
export function oldModelNotice(
  input: { transcript_path?: string; session_id?: string } | null | undefined,
  cfg: { oldModelWarn?: boolean; lang?: string },
  sid: string,
  deps: OldModelDeps,
): { text: string; book: Record<string, number> } {
  const b0: Record<string, number> = deps && deps.book && typeof deps.book === 'object' && !Array.isArray(deps.book) ? (deps.book as Record<string, number>) : {};
  try {
    if (cfg.oldModelWarn !== true || !input || !input.transcript_path || !input.session_id) return { text: '', book: b0 };
    if (b0[sid]) return { text: '', book: b0 };
    let model: string | null = null;
    for (const o of deps.entries || []) if (o && o.type === 'assistant' && !o.isSidechain && o.message && o.message.model && o.message.model !== '<synthetic>') model = o.message.model;
    if (!model) return { text: '', book: b0 };
    const p = deps.priceOf(model);
    if (!p || p.tier !== 'old') return { text: '', book: b0 };
    const b = { ...b0 };
    b[sid] = deps.now === undefined ? Date.now() : deps.now;
    const keys = Object.keys(b);
    if (keys.length > 50) keys.sort((x, y) => b[x] - b[y]).slice(0, keys.length - 50).forEach((k) => delete b[k]);
    return { text: (OLD_MODEL[cfg.lang as string] || OLD_MODEL.en)(p.key || (deps.strip ? deps.strip(model) : model)), book: b };
  } catch (e) { return { text: '', book: b0 }; }
}

// NOTE: the original module's impure `run(raw)` (reads stdin, pace.loadConfig/readState/
// readJson/writeJson/appendEvent/attributed, lang.withLang) is NOT ported here -- that is
// register.ts's job (desktop-only, unverified on this PC).
