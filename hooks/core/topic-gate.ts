// UserPromptSubmit hook: when the context is big and the user returns after a long idle gap (or
// from another cwd), add ONE line of additionalContext so Claude can offer a fresh start with a
// handoff note. Above gateAt every prompt also gets a short topic-check line until Claude offers
// a clear. Otherwise silent. Ported from scripts/topic-gate.js.
//
// `pace.thresholds(cfg)` became `thresholds(cfg, user)` in pacer.ts (see that file's header), so
// every function here that calls it (`decideTopicCheck`, `decideHint`, `decide`) now also takes
// an explicit `user` parameter -- the raw (not merged-with-defaults) user config.json content --
// instead of re-reading config.json off disk. register.ts owns that read.

import { thresholds } from './pacer.ts';
import { tokLabel } from './boundary.ts';
import { hintLine } from './clear-savings.ts';

export interface TopicGateCfg {
  topicCheck?: boolean;
  topicCheckStepTokens?: number;
  renotifyGrowthTokens?: number;
  inlineCompactHint?: boolean;
  idleGapSec?: number;
  topicGate?: boolean;
  // Usage Advisor R2: 'gap' = the inline hint only comes after an idle/cwd gap; 'always' (default) = as before.
  hintTrigger?: string;
  // Usage Advisor R2: no inline hint unless the clear card's low estimate reaches this (0 = off). Applied by register.ts via meetsMinEffect().
  hintMinEffectTokens?: number;
  [key: string]: unknown;
}

export function lastAssistantTs(entries: any[]): number | null {
  let ts: number | null = null;
  for (const o of entries) if (o.type === 'assistant' && !o.isSidechain && o.timestamp) ts = Date.parse(o.timestamp);
  return ts !== null && isFinite(ts) ? ts : null;
}

// Last assistant time for the idle gap. A transcript over 4 MiB is rebuilt without timestamps, so the
// time of the session's last Stop (side file stopAt) stands in. A prompt newer than that Stop means the
// turn ended without one (interrupted): the idle time is unknown then, so null and no gate.
export function lastActiveMs(entries: any[], stopAt: unknown, promptAt: unknown): number | null {
  const a = lastAssistantTs(entries);
  if (a !== null) return a;
  if (typeof stopAt !== 'number' || !isFinite(stopAt)) return null;
  if (typeof promptAt === 'number' && promptAt > stopAt) return null;
  return stopAt;
}

// True when Claude already offered a clear in the recent transcript (a clear_session self button or call).
export function clearOffered(entries: any[]): boolean {
  for (const o of entries) {
    if (o.type !== 'assistant' || o.isSidechain || !o.message || !Array.isArray(o.message.content)) continue;
    for (const c of o.message.content) {
      if (!c || c.type !== 'tool_use') continue;
      if (JSON.stringify(c.input || {}).includes('clear_session')) return true;
      // The app's own new-session card (start_session offer/own_initiative) or a hand-off already answers a topic change.
      const name = String(c.name || '');
      const init = c.input && c.input.initiation;
      if (/start_session$/.test(name) && (init === 'offer' || init === 'own_initiative')) return true;
      if (/hand_off_to_session$/.test(name)) return true;
    }
  }
  return false;
}

// Claude desktop app sets CLAUDE_CODE_ENTRYPOINT=claude-desktop for its sessions (CLI/IDE use other values).
// In the app we ask for a card only; elsewhere the paste-line wording stays.
export function isDesktopApp(env?: Record<string, string | undefined>): boolean {
  const p = (globalThis as any).process;
  const e = env || (p ? p.env : {}); // the hooks module passes its own; Node tests may not
  return String(e.CLAUDE_CODE_ENTRYPOINT || '') === 'claude-desktop';
}

export interface TopicCheckResult { check: boolean; offeredAt: number | null; checkedAt: number | null }

// Topic check (0.4.2): above gateAt, one short line so Claude can spot a topic change itself (no idle gap or cwd
// change needed). Since 0.4.5 it waits for topicCheckStepTokens (50k) of growth after each line: every line stays in
// the context and is re-read on every later call. Pure. offeredAt = tokens when Claude last offered a clear,
// checkedAt = tokens at the last line (null if none).
export function decideTopicCheck(
  tokens: number,
  cfg: TopicGateCfg,
  user: Record<string, unknown> | undefined,
  offeredAt: number | null | undefined,
  checkedAt?: number | null,
): TopicCheckResult {
  let oa: number | null = typeof offeredAt === 'number' ? offeredAt : null;
  let ca: number | null = typeof checkedAt === 'number' ? checkedAt : null;
  if (cfg.topicCheck === false || !tokens) return { check: false, offeredAt: oa, checkedAt: ca };
  if (typeof oa === 'number' && tokens < oa) oa = null; // context shrank: compacted or cleared
  if (ca !== null && tokens < ca) ca = null;
  if (tokens < thresholds(cfg, user).gateAt) return { check: false, offeredAt: oa, checkedAt: ca };
  const grow = cfg.renotifyGrowthTokens || 100000;
  if (typeof oa === 'number' && tokens < oa + grow) return { check: false, offeredAt: oa, checkedAt: ca };
  const step = cfg.topicCheckStepTokens == null ? 50000 : cfg.topicCheckStepTokens;
  if (ca !== null && tokens < ca + step) return { check: false, offeredAt: oa, checkedAt: ca };
  return { check: true, offeredAt: oa, checkedAt: tokens };
}

export function topicCheckMessage(lang: string | undefined, tokens: number, file: string, app?: boolean): string {
  const t = tokLabel(tokens, lang);
  if (app && lang === 'ko') {
    return `Token Stamina: 컨텍스트 ${t}. 다른 주제의 요청이면 답 끝에 메모(${file})를 쓰고 "비우기"/"비우지 않기" 카드로 물으세요(새 세션 카드가 있으면 그 뒤). 같은 주제면 무시.`;
  }
  if (app) {
    return `Token Stamina: context ${t}. If this request is a different topic, end your reply by writing the note (${file}) and ask with a "Clear" / "Keep going" card (after the app's new-session card, if any). Same topic: ignore.`;
  }
  if (lang === 'ko') {
    return `Token Stamina: 컨텍스트 ${t}. 다른 주제의 요청이면 답 끝에 메모(${file})를 쓰고 "비우기"/"비우지 않기" 버튼으로 물으세요(CLI: /clear). 같은 주제면 무시.`;
  }
  return `Token Stamina: context ${t}. If this request is a different topic, end your reply by writing the note (${file}) and ask with "Clear" / "Keep going" buttons (CLI: suggest /clear). Same topic: ignore.`;
}

export function message(lang: string | undefined, tokens: number, idleSec: number, cwdChanged: boolean, file: string, app?: boolean): string {
  const t = tokLabel(tokens, lang);
  const why =
    lang === 'ko'
      ? cwdChanged
        ? '작업 폴더가 바뀜'
        : `${Math.round(idleSec / 3600)}시간 자리 비움`
      : cwdChanged
        ? 'working folder changed'
        : `${Math.round(idleSec / 3600)}h idle`;
  if (app && lang === 'ko') {
    return `Token Stamina: 컨텍스트 ${t}, ${why}. 이번 요청이 무관하면 인계 메모를 ${file} 에 쓰고 카드로만 새 시작(비우기·새 세션)을 제안하세요. 관련 있으면 무시.`;
  }
  if (app) {
    return `Token Stamina: context ${t}, ${why}. If this request is unrelated to prior work, write a handoff to ${file} and offer a fresh start (clear or new session) with a card only. Otherwise ignore.`;
  }
  if (lang === 'ko') {
    return `Token Stamina: 컨텍스트 ${t}, ${why}. 무관한 요청이면 인계 메모를 ${file} 에 쓰고 새 시작을 제안하세요(앱: clear_session·새 세션, CLI: /clear). 관련 있으면 무시.`;
  }
  return `Token Stamina: context ${t}, ${why}. If this request is unrelated to prior work, write a handoff to ${file} and offer a fresh start (app: clear_session self / new session; CLI: /clear). Otherwise ignore.`;
}

// Inline compact hint: Claude cannot see its own context size, so once the context passes compactAt
// we tell it the size and ask it to put the /compact hint in its reply when the task ends.
// That works on every surface (desktop, IDE, CLI), unlike a systemMessage the user may never see.
// first = the first hint in this session (full instructions + the savings estimate); later hints are one short
// line that points back to it and carry no estimate. The app variant carries the clear estimate, the CLI the compact one.
export function hintMessage(
  lang: string | undefined,
  tokens: number,
  file: string,
  cfg: Record<string, unknown> | undefined,
  prof: Parameters<typeof hintLine>[4],
  app?: boolean,
  first: boolean = true,
): string {
  const t = tokLabel(tokens, lang);
  const ko = lang === 'ko';
  if (!first) {
    if (app) {
      return ko
        ? `Token Stamina: 컨텍스트 ${t} 토큰. 끝나면 앞서 안내대로 메모(${file}) 쓰고 "비우기" 카드로 물으세요.`
        : `Token Stamina: context ${t} tokens. When done, write the note (${file}) and use the "Clear" card as before.`;
    }
    return ko
      ? `Token Stamina: 컨텍스트 ${t} 토큰. 끝나면 앞서 안내대로 "/compact" 한 줄(또는 clear_session 카드)로 알리세요.`
      : `Token Stamina: context ${t} tokens. When done, give the /compact line (or the clear_session card) as before.`;
  }
  if (app) {
    const estClear = hintLine(tokens, lang, 'clear', cfg as any, prof);
    return ko
      ? `Token Stamina: 컨텍스트 ${t} 토큰(매 턴 다시 읽음). 작업이 끝나면(커밋·결정·답 직후) 결정·남은 일을 ${file} 에 쓰고 "비우기" 버튼 카드로만 물으세요(채팅에 /compact 안내 금지). 누르면 clear_session self, 메모는 자동 복원돼요. 다른 주제면 새 세션 카드,${estClear ? ` 카드에 그대로: "${estClear}"` : ''}`
      : `Token Stamina: context ${t} tokens (re-read every turn). When this task finishes, write decisions and open items to ${file} and ask with a "Clear" button card only (no /compact text in chat). On accept call clear_session self; the note is restored. Different topic next: new-session card. Task still running: wait.${estClear ? ` Put on the card as is: "${estClear}"` : ''}`;
  }
  const est = hintLine(tokens, lang, 'compact', cfg as any, prof);
  return ko
    ? `Token Stamina: 컨텍스트 ${t} 토큰(매 턴 다시 읽음). 작업이 끝나면답 끝에 "지금 /compact 하기 좋은 때예요"와 붙여 넣을 한 줄(/compact 남길 결정·열린 PR·남은 일)을 쓰세요. 그냥 /compact 도 메모가 복원돼요. clear_session 이 있으면 ${file} 에 메모 쓰고 "비우기" 버튼으로 물으세요.${est ? ` 추정 그대로: "${est}"` : ''}`
    : `Token Stamina: context ${t} tokens (re-read every turn). When this task finishes, end your reply with "Good time to /compact" and a paste-ready line: /compact <decisions to keep, open PRs, what is left>. Plain /compact also restores the note. With clear_session, write ${file} and ask with a "Clear" button.${est ? ` Estimate as is: "${est}"` : ''}`;
}

export interface HintResult { hint: boolean; hintAt: number | null; hintCount: number; first: boolean }

// Context growth needed before the next REPEAT hint: max(100k, 10% of the configured window). A big window therefore
// repeats rarely; no window configured = 100k. cfg.hintStepTokens overrides (tests, tuning).
export function hintStep(cfg: TopicGateCfg, user: Record<string, unknown> | undefined): number {
  if (typeof cfg.hintStepTokens === 'number' && cfg.hintStepTokens > 0) return cfg.hintStepTokens;
  const w = Number(cfg.compactWindowTokens) || Number((user || {}).compactWindowTokens) || 0;
  return Math.max(100000, Math.round(0.1 * w));
}
export const HINT_MAX_PER_CONTEXT = 5;

// Pure. hintAt = tokens when the last hint was given (null if none or reset by a compact/clear); hintCount = hints
// given since that reset (the first one included, capped at HINT_MAX_PER_CONTEXT). A context drop (tokens below the last
// hint) starts over: counter 0, the next hint is a "first" (full text) again.
// gap (optional): result of decide(); with hintTrigger "gap" the hint only comes after an idle/cwd gap (advisor R2).
export function decideHint(
  tokens: number,
  cfg: TopicGateCfg,
  user: Record<string, unknown> | undefined,
  hintAt: number | null | undefined,
  gap?: DecideResult,
  hintCount?: number | null,
): HintResult {
  let ha: number | null = typeof hintAt === 'number' ? hintAt : null;
  // a stored hintAt from before the counter existed counts as one hint
  let n = typeof hintCount === 'number' && hintCount >= 0 ? Math.floor(hintCount) : ha !== null ? 1 : 0;
  const keep = (hint: boolean): HintResult => ({ hint, hintAt: ha, hintCount: n, first: false });
  if (cfg.inlineCompactHint === false || !tokens) return keep(false);
  const at = thresholds(cfg, user).compactAt;
  if (typeof ha === 'number' && tokens < ha) { ha = null; n = 0; } // context shrank: compacted or cleared
  if (tokens < at) return keep(false);
  if (cfg.hintTrigger === 'gap' && gap !== undefined && !(gap && (gap.gate || gap.gapMet))) return keep(false);
  if (typeof ha === 'number') {
    if (n >= HINT_MAX_PER_CONTEXT) return keep(false);
    if (tokens < ha + hintStep(cfg, user)) return keep(false);
  }
  const first = ha === null;
  return { hint: true, hintAt: tokens, hintCount: first ? 1 : n + 1, first };
}

// A move into a parent or child folder is the same project (tools often cd into subfolders).
export function sameTree(a: unknown, b: unknown): boolean {
  const n = (p: unknown) =>
    String(p)
      .replace(/[\\/]+/g, '/')
      .replace(/\/$/, '')
      .toLowerCase();
  const x = n(a);
  const y = n(b);
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

export interface DecideInfo { tokens: number; lastAssistantMs: number | null; nowMs: number; cwd?: string }
export interface DecideRec { cwd?: string; gatedAt?: number }
export interface DecideResult { gate: boolean; reason?: string; idleSec?: number; cwdChanged?: boolean; gapMet?: boolean }

// Pure decision. rec = {cwd, gatedAt} previously recorded for this session.
export function decide(
  info: DecideInfo,
  cfg: TopicGateCfg,
  user: Record<string, unknown> | undefined,
  rec: DecideRec | null | undefined,
): DecideResult {
  if (cfg.topicGate === false) {
    // The gate card is off, but the idle/cwd gap is still measured: hintTrigger "gap" depends on it, not on the gate card.
    const idle = info.lastAssistantMs ? Math.max(0, (info.nowMs - info.lastAssistantMs) / 1000) : 0;
    const moved = !!(rec && rec.cwd && info.cwd && !sameTree(rec.cwd, info.cwd));
    return { gate: false, reason: 'off', gapMet: idle >= (cfg.idleGapSec || 3600) || moved };
  }
  const gateAt = thresholds(cfg, user).gateAt;
  const idleGap = cfg.idleGapSec || 3600;
  const grow = cfg.renotifyGrowthTokens || 100000;
  // The gap is measured before any size check: the inline hint (hintTrigger "gap") starts at compactAt, below gateAt, and
  // reads gapMet from every outcome, not only from the ones that got past the size check.
  const idleSec = info.lastAssistantMs ? Math.max(0, (info.nowMs - info.lastAssistantMs) / 1000) : 0;
  const cwdChanged = !!(rec && rec.cwd && info.cwd && !sameTree(rec.cwd, info.cwd));
  const gapMet = idleSec >= idleGap || cwdChanged;
  if (!info.tokens || info.tokens < gateAt) return { gate: false, reason: 'below_threshold', gapMet };
  if (!gapMet) return { gate: false, reason: 'no_gap', gapMet: false };
  if (rec && typeof rec.gatedAt === 'number' && info.tokens >= rec.gatedAt && info.tokens < rec.gatedAt + grow)
    return { gate: false, reason: 'renotify_suppressed', gapMet };
  return { gate: true, idleSec, cwdChanged, gapMet };
}

// NOTE: the original module's impure `run(raw)` orchestration (reads/writes topic-gate.json via
// pace.readJson/writeJson, reads the transcript tail via boundary.readTail, calls
// handoff.sessionFile, pace.appendEvent, pace.attributed) is NOT ported here -- that is
// register.ts's job (desktop-only, unverified on this PC). Everything above is the pure decision
// core register.ts will call with data it fetched via `$.fs` / `$.session`.
