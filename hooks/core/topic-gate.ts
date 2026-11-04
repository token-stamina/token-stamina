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
    return `Token Stamina: 컨텍스트 ${t}. 이번 요청이 앞 작업과 다른 주제면 답 끝에 메모(${file})를 쓰고 "비우기"/"비우지 않기" 카드로만 물으세요(앱의 새 세션 카드가 떠 있으면 그 뒤에). 같은 주제면 무시하세요.`;
  }
  if (app) {
    return `Token Stamina: context ${t}. If this request is a different topic from the work so far, end your reply by writing the note (${file}) and asking with a "Clear" / "Keep going" card only (after the app's own new-session card, if one is up). Same topic: ignore this line.`;
  }
  if (lang === 'ko') {
    return `Token Stamina: 컨텍스트 ${t}. 이번 요청이 앞 작업과 다른 주제면 답 끝에 메모(${file})를 쓰고 "비우기"/"비우지 않기" 버튼으로 물으세요(앱: 누르면 clear_session self, CLI: /clear 안내). 같은 주제면 무시하세요.`;
  }
  return `Token Stamina: context ${t}. If this request is a different topic from the work so far, end your reply by writing the note (${file}) and asking with "Clear" / "Keep going" buttons (app: clear_session self on accept; CLI: suggest /clear). Same topic: ignore this line.`;
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
    return `Token Stamina: 컨텍스트 ${t}, ${why}. 이번 요청이 이전 작업과 무관하면 인계 메모를 ${file} 에 쓰고 카드(버튼)로만 새 시작(비우기 또는 새 세션)을 제안하세요. 관련 있으면 무시하세요.`;
  }
  if (app) {
    return `Token Stamina: context ${t}, ${why}. If this request is unrelated to prior work, write a short handoff to ${file} and offer a fresh start (clear or new session) with a card (buttons) only. Otherwise ignore.`;
  }
  if (lang === 'ko') {
    return `Token Stamina: 컨텍스트 ${t}, ${why}. 이번 요청이 이전 작업과 무관하면 인계 메모를 ${file} 에 쓰고 새 시작을 제안하세요(앱: clear_session self 또는 새 세션, CLI: /clear 안내). 관련 있으면 무시하세요.`;
  }
  return `Token Stamina: context ${t}, ${why}. If this request is unrelated to prior work, write a short handoff to ${file} and offer a fresh start (app: clear_session self / new session; CLI: suggest /clear). Otherwise ignore.`;
}

// Inline compact hint: Claude cannot see its own context size, so once the context passes compactAt
// we tell it the size and ask it to put the /compact hint in its reply when the task ends.
// That works on every surface (desktop, IDE, CLI), unlike a systemMessage the user may never see.
// first = the first hint in this session (full instructions); later hints are one short line that points back to it.
// The app variant carries only the clear estimate; the CLI variant carries both.
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
  const est = hintLine(tokens, lang, 'compact', cfg as any, prof);
  const estClear = hintLine(tokens, lang, 'clear', cfg as any, prof);
  const ko = lang === 'ko';
  if (app) {
    if (!first) {
      return ko
        ? `Token Stamina: 컨텍스트 ${t} 토큰. 끝나면 앞서 안내대로 메모(${file}) 쓰고 "비우기" 카드로 물으세요.${estClear ? ` "${estClear}"` : ''}`
        : `Token Stamina: context ${t} tokens. When done, write the note (${file}) and use the "Clear" card as before.${estClear ? ` "${estClear}"` : ''}`;
    }
    return ko
      ? `Token Stamina: 컨텍스트 ${t} 토큰(매 턴 다시 읽음). 이번 작업이 끝나면(커밋·결정·답 직후) 결정·남은 일을 ${file} 에 쓰고 "비우기" 버튼 카드로만 물으세요(채팅 글로 /compact 안내 금지). 누르면 clear_session self — 메모는 비운 뒤 자동 복원돼요. 다음 일이 다른 주제면 새 세션 카드를, 진행 중이면 끝날 때까지 미루세요.${estClear ? ` 카드에 이 추정을 그대로: "${estClear}"` : ''}`
      : `Token Stamina: context ${t} tokens (re-read every turn). When this task finishes (commit, decision or answer), write decisions and open items to ${file} and ask with a "Clear" button card only (no /compact text in chat). On accept call clear_session self; the note is restored after the clear. Offer a new-session card if the next work is a different topic; if the task is still running, wait.${estClear ? ` Put this estimate on the card as is: "${estClear}"` : ''}`;
  }
  if (!first) {
    return ko
      ? `Token Stamina: 컨텍스트 ${t} 토큰. 작업이 끝나면 앞서 안내한 대로 "/compact" 한 줄(또는 clear_session 카드)로 알리세요.${est ? ` 추정: "${est}"` : ''}${estClear ? ` 비우기 카드에: "${estClear}"` : ''}`
      : `Token Stamina: context ${t} tokens. When the task finishes, give the /compact line (or the clear_session card) as instructed earlier.${est ? ` Estimate: "${est}"` : ''}${estClear ? ` On the Clear card: "${estClear}"` : ''}`;
  }
  return ko
    ? `Token Stamina: 컨텍스트 ${t} 토큰(매 턴 다시 읽음). 이번 작업이 끝나면(커밋·결정·답 직후) 답 끝에 "지금 /compact 하기 좋은 때예요"와 바로 붙여 넣을 한 줄(/compact 남길 결정·열린 PR·남은 일)을 쓰세요. 다른 주제로 넘어가면 새 세션을 권하세요. 그냥 /compact 만 쳐도 인계 메모가 복원돼요. clear_session 도구가 있으면(데스크탑 앱) 결정·남은 일을 ${file} 에 쓰고 "비우기" 버튼으로 물은 뒤 누르면 clear_session self 를 호출하세요. 진행 중이면 끝날 때까지 미루세요.${est ? ` 추정을 그대로 붙이세요(숫자 변환 금지): "${est}"` : ''}${estClear ? ` 비우기 카드에: "${estClear}"` : ''}`
    : `Token Stamina: context ${t} tokens (re-read every turn). When this task finishes (after a commit, decision or answer), end your reply with "Good time to /compact" and one line the user can paste: /compact <decisions to keep, open PRs, what is left>. Suggest a new session if the next work is a different topic. Plain /compact also works (the handoff note is restored). With a clear_session tool (desktop app), write decisions and open items to ${file}, ask with a "Clear" button, and on accept call clear_session self. If the task is still running, wait.${est ? ` Put this estimate next to it as is (no conversions): "${est}"` : ''}${estClear ? ` On the Clear card: "${estClear}"` : ''}`;
}

export interface HintResult { hint: boolean; hintAt: number | null }

// Pure. hintAt = tokens when the last hint was given (null if none or reset by a compact).
// gap (optional): result of decide(); with hintTrigger "gap" the hint only comes after an idle/cwd gap (advisor R2).
export function decideHint(
  tokens: number,
  cfg: TopicGateCfg,
  user: Record<string, unknown> | undefined,
  hintAt: number | null | undefined,
  gap?: DecideResult,
): HintResult {
  let ha: number | null = typeof hintAt === 'number' ? hintAt : null;
  if (cfg.inlineCompactHint === false || !tokens) return { hint: false, hintAt: ha };
  const at = thresholds(cfg, user).compactAt;
  const grow = cfg.renotifyGrowthTokens || 100000;
  if (typeof ha === 'number' && tokens < ha) ha = null; // context shrank: compacted
  if (tokens < at) return { hint: false, hintAt: ha };
  if (cfg.hintTrigger === 'gap' && gap !== undefined && !(gap && (gap.gate || gap.gapMet))) return { hint: false, hintAt: ha };
  if (typeof ha === 'number' && tokens < ha + grow) return { hint: false, hintAt: ha };
  return { hint: true, hintAt: tokens };
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
