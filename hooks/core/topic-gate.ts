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
  [key: string]: unknown;
}

export function lastAssistantTs(entries: any[]): number | null {
  let ts: number | null = null;
  for (const o of entries) if (o.type === 'assistant' && !o.isSidechain && o.timestamp) ts = Date.parse(o.timestamp);
  return ts !== null && isFinite(ts) ? ts : null;
}

// True when Claude already offered a clear in the recent transcript (a clear_session self button or call).
export function clearOffered(entries: any[]): boolean {
  for (const o of entries) {
    if (o.type !== 'assistant' || o.isSidechain || !o.message || !Array.isArray(o.message.content)) continue;
    for (const c of o.message.content)
      if (c && c.type === 'tool_use' && JSON.stringify(c.input || {}).includes('clear_session')) return true;
  }
  return false;
}

// Claude desktop app sets CLAUDE_CODE_ENTRYPOINT=claude-desktop for its sessions (CLI/IDE use other values).
// In the app we ask for a card only; elsewhere the paste-line wording stays.
export function isDesktopApp(env?: Record<string, string | undefined>): boolean {
  return String((env || process.env).CLAUDE_CODE_ENTRYPOINT || '') === 'claude-desktop';
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
    return `Token Stamina: 컨텍스트 ${t}. 데스크탑 앱이에요. 이번 요청이 앞의 작업과 다른 주제면, 답 끝에 결정·남은 일을 ${file} 에 쓰고 "비우기"/"비우지 않기" 카드(버튼)로만 물으세요. 채팅 글로 /compact·/clear 안내를 쓰지 마세요. 누르면 clear_session self 를 호출해요. 같은 주제면 이 줄은 무시하세요.`;
  }
  if (app) {
    return `Token Stamina: context ${t}. This is the Claude desktop app. If this request is a different topic from the work so far, end your reply by writing decisions and open items to ${file} and asking with a "Clear" / "Keep going" card (buttons) only. Do not write /compact or /clear instructions as chat text. On accept call clear_session self. If it is the same topic, ignore this line.`;
  }
  if (lang === 'ko') {
    return `Token Stamina: 컨텍스트 ${t}. 이번 요청이 앞의 작업과 다른 주제면, 답 끝에 결정·남은 일을 ${file} 에 쓰고 "비우기"/"비우지 않기" 버튼으로 물으세요(데스크탑 앱: 누르면 clear_session self, CLI: /clear 안내). 같은 주제면 이 줄은 무시하세요.`;
  }
  return `Token Stamina: context ${t}. If this request is a different topic from the work so far, end your reply by writing decisions and open items to ${file} and asking with "Clear" / "Keep going" buttons (desktop app: clear_session self on accept; CLI: suggest /clear). If it is the same topic, ignore this line.`;
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
    return `Token Stamina: 컨텍스트 ${t}, ${why}. 데스크탑 앱이에요. 이번 요청이 이전 작업과 무관하면: 짧은 인계 메모를 ${file} 에 쓰고, 카드(버튼)로만 새 시작을 제안하세요(clear_session self 또는 새 세션). 채팅 글로 /clear 안내를 쓰지 마세요. 관련 있으면 이 줄은 무시하세요.`;
  }
  if (app) {
    return `Token Stamina: context ${t}, ${why}. This is the Claude desktop app. If this request is unrelated to prior work: write a short handoff to ${file}, then offer a fresh start with a card (buttons) only (clear_session self / new session). Do not write /clear instructions as chat text. Otherwise ignore.`;
  }
  if (lang === 'ko') {
    return `Token Stamina: 컨텍스트 ${t}, ${why}. 이번 요청이 이전 작업과 무관하면: 짧은 인계 메모를 ${file} 에 쓰고, 새 시작을 제안하세요(데스크탑 앱: clear_session self 또는 새 세션, CLI: /clear 안내). 관련 있으면 이 줄은 무시하세요.`;
  }
  return `Token Stamina: context ${t}, ${why}. If this request is unrelated to prior work: write a short handoff to ${file}, then offer a fresh start (desktop app: clear_session self / new session; CLI: suggest /clear). Otherwise ignore.`;
}

// Inline compact hint: Claude cannot see its own context size, so once the context passes compactAt
// we tell it the size and ask it to put the /compact hint in its reply when the task ends.
// That works on every surface (desktop, IDE, CLI), unlike a systemMessage the user may never see.
export function hintMessage(
  lang: string | undefined,
  tokens: number,
  file: string,
  cfg: Record<string, unknown> | undefined,
  prof: Parameters<typeof hintLine>[4],
  app?: boolean,
): string {
  const t = tokLabel(tokens, lang);
  const est = hintLine(tokens, lang, 'compact', cfg as any, prof);
  const estClear = hintLine(tokens, lang, 'clear', cfg as any, prof);
  const tail = `${est ? ` ${lang === 'ko' ? '권장 문구 옆에 이 추정을 그대로 붙이세요(숫자를 바꾸거나 금액·한도 %로 환산하지 마세요)' : 'Put this estimate next to the recommendation as is (do not change the numbers or convert to money or limit %)'}: "${est}"` : ''}${estClear ? ` ${lang === 'ko' ? '비우기 버튼 카드에는' : 'On the Clear button card'}: "${estClear}"` : ''}`;
  if (app && lang === 'ko') {
    return `Token Stamina: 컨텍스트 ${t} 토큰(매 턴 다시 읽음). 데스크탑 앱이에요. 이번 작업이 끝나면(커밋·결정·답 직후) 채팅 글로 /compact 안내를 쓰지 말고 카드(버튼) 한 번으로만 알리세요: 결정·남은 일을 ${file} 에 쓰고, "비우기" 버튼(또는 예/아니오 질문)으로 묻고, 사용자가 누르면 clear_session self 를 호출하세요(비운 뒤 그 메모가 자동 복원돼요). 다음 일이 다른 주제면 새 세션 카드를 권하세요. 카드를 띄울 도구가 이번 세션에 없을 때만 /compact 한 줄로 대신하세요. 작업이 아직 진행 중이면 끝날 때까지 미루세요.${tail}`;
  }
  if (app) {
    return `Token Stamina: context is ${t} tokens (re-read every turn). This is the Claude desktop app. When this task finishes (after a commit, decision or answer), do not write a /compact instruction as chat text; offer one card (buttons) only: write decisions and open items to ${file}, offer a "Clear" button (or a yes/no question), and when the user accepts call clear_session self (the note is restored after the clear). If the next work is a different topic, offer a new-session card instead. Fall back to a one-line /compact only if no card tool is available in this session. If the task is still in progress, wait until it ends.${tail}`;
  }
  if (lang === 'ko') {
    return `Token Stamina: 컨텍스트 ${t} 토큰(매 턴 다시 읽음). 이번 작업이 끝나면(커밋·결정·답 직후) 답 끝에 "지금 /compact 하기 좋은 때예요"와 바로 붙여 넣을 한 줄(/compact 남길 결정·열린 PR·남은 일)을 쓰세요. 다음 일이 다른 주제면 새 세션을 권하세요. 그냥 /compact 만 쳐도 인계 메모가 복원된다고 덧붙여도 돼요. clear_session 같은 세션 비우기 도구가 있으면(Claude 데스크탑 앱) 붙여 넣을 줄 대신 클릭 한 번으로 끝나게 하세요: 결정·남은 일을 ${file} 에 쓰고, "비우기" 버튼(또는 예/아니오 질문)으로 묻고, 사용자가 누르면 clear_session self 를 호출하세요(비운 뒤 그 메모가 자동 복원돼요). 작업이 아직 진행 중이면 끝날 때까지 미루세요.${est ? ` 권장 문구 옆에 이 추정을 그대로 붙이세요(숫자를 바꾸거나 금액·한도 %로 환산하지 마세요): "${est}"` : ''}${estClear ? ` 비우기 버튼 카드에는: "${estClear}"` : ''}`;
  }
  return `Token Stamina: context is ${t} tokens (re-read every turn). When this task finishes (after a commit, decision or answer), end your reply with "Good time to /compact" and one line the user can paste: /compact <decisions to keep, open PRs, what is left>. If the next work is a different topic, suggest a new session instead. You may add that plain /compact also works (the handoff note is restored). If you have a session-clearing tool such as clear_session (Claude desktop app), make it one click instead of a paste line: write decisions and open items to ${file}, offer a "Clear" button (or a yes/no question), and when the user accepts call clear_session self (the note is restored after the clear). If the task is still in progress, wait until it ends.${est ? ` Put this estimate next to the recommendation as is (do not change the numbers or convert to money or limit %): "${est}"` : ''}${estClear ? ` On the Clear button card: "${estClear}"` : ''}`;
}

export interface HintResult { hint: boolean; hintAt: number | null }

// Pure. hintAt = tokens when the last hint was given (null if none or reset by a compact).
export function decideHint(
  tokens: number,
  cfg: TopicGateCfg,
  user: Record<string, unknown> | undefined,
  hintAt: number | null | undefined,
): HintResult {
  let ha: number | null = typeof hintAt === 'number' ? hintAt : null;
  if (cfg.inlineCompactHint === false || !tokens) return { hint: false, hintAt: ha };
  const at = thresholds(cfg, user).compactAt;
  const grow = cfg.renotifyGrowthTokens || 100000;
  if (typeof ha === 'number' && tokens < ha) ha = null; // context shrank: compacted
  if (tokens < at) return { hint: false, hintAt: ha };
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
export interface DecideResult { gate: boolean; reason?: string; idleSec?: number; cwdChanged?: boolean }

// Pure decision. rec = {cwd, gatedAt} previously recorded for this session.
export function decide(
  info: DecideInfo,
  cfg: TopicGateCfg,
  user: Record<string, unknown> | undefined,
  rec: DecideRec | null | undefined,
): DecideResult {
  if (cfg.topicGate === false) return { gate: false, reason: 'off' };
  const gateAt = thresholds(cfg, user).gateAt;
  const idleGap = cfg.idleGapSec || 3600;
  const grow = cfg.renotifyGrowthTokens || 100000;
  if (!info.tokens || info.tokens < gateAt) return { gate: false, reason: 'below_threshold' };
  const idleSec = info.lastAssistantMs ? Math.max(0, (info.nowMs - info.lastAssistantMs) / 1000) : 0;
  const cwdChanged = !!(rec && rec.cwd && info.cwd && !sameTree(rec.cwd, info.cwd));
  if (!(idleSec >= idleGap || cwdChanged)) return { gate: false, reason: 'no_gap' };
  if (rec && typeof rec.gatedAt === 'number' && info.tokens >= rec.gatedAt && info.tokens < rec.gatedAt + grow)
    return { gate: false, reason: 'renotify_suppressed' };
  return { gate: true, idleSec, cwdChanged };
}

// NOTE: the original module's impure `run(raw)` orchestration (reads/writes topic-gate.json via
// pace.readJson/writeJson, reads the transcript tail via boundary.readTail, calls
// handoff.sessionFile, pace.appendEvent, pace.attributed) is NOT ported here -- that is
// register.ts's job (desktop-only, unverified on this PC). Everything above is the pure decision
// core register.ts will call with data it fetched via `$.fs` / `$.session`.
