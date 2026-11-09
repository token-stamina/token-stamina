// hooks/register.ts — the mods entry point (Claude Code function hooks, 2.1.309 API).
// Wires engine events to the pure logic in hooks/core/*.ts; every decision lives there.
//
// This file is the wiring only: fetch inputs through `$` (no Node: no node:fs, no process),
// call the pure function, persist through `$.fs`, answer the event. Every hook fails open:
// an error anywhere passes the event on unchanged, as each scripts/*.js did.
//
// Built into a mod folder by tools/build-mod.mjs (hooks.json = { "modules": ["./register.ts"] });
// the repo root stays the Node plugin, whose hooks.json never loads this file.
//
// Events, and the Node script each one replaces:
//   classic.SessionStart      nudge.js (grade), handoff.js (compact/clear restore, desktop clear marker)
//   classic.UserPromptSubmit  topic-gate.js, handoff.js (desktop clear marker), nudge.js
//   classic.Stop              boundary.js (notice), handoff.js (save + desktop clear marker)
//   prompt.submit / turn.complete / prompt.context / session.end   the same hints, notes and rows without a classic hook (0.6.14):
//                             a managed plugin can send the classic events past this one. Each turn is served once: whichever path
//                             comes second stands down (claimPrompt, classicStopSeen).
//   tool.call Agent / mcp__ccd_session__start_session   agent-model.js
//   every hook above          statusline.js, as $.ui.status from $.session.usage()
//   command.run fleet / savings / report / audit   scripts/{fleet,savings,report,audit}.js, answered as { text }
//                             (registered in session.start; setup, autocompact and board are mod/commands/*.md)
//   session.start / ui.render AbovePrompt   the last turns before a desktop clear, drawn above the prompt until the first prompt (screen only)
//   classic.Stop / UserPromptSubmit   board.js (the per-session board row, only with dashboardUrl set)
//   tool.call mcp__token-stamina__board   board.js --rows / --apply / --record-apply / --record-push / --json
//                             (the tool is declared in session.start; mod/commands/board.md calls it)
// Not ported here (no longer needed): first-run/setup-nudge (the status line needs no setup in a mod),
// the desktop usage-sync hint. Not in the board tool: board.js --json --live (the transcript scan).

import { atom, read, update } from 'claude-code';
import type { Register, EngineInterface } from 'claude-code';

import type { RecentBand, Recall } from '../types';

import { resolveLang, withLang, type LangBook } from './core/lang.ts';
import { decide as nudgeDecide, oldModelNotice, type NudgeCfg } from './core/nudge.ts';
import {
  decide as agentModelDecide,
  attributed,
  adaptSession,
  definitionPaths,
  effectiveMode,
  userAgentHook,
  recordLedger,
  waitAdvice,
  type AgentModelCfg,
  type AgentModelInput,
  type DecideResult as AgentDecision,
} from './core/agent-model.ts';
import {
  sessionDir as fleetSessionDir,
  scanEntries as fleetScanEntries,
  pressureWithSessions as fleetPressure,
  cachedSessions as fleetCachedSessions,
  type SessionsCacheEnt,
  emptySnap as fleetEmptySnap,
  tableWithSessions as fleetTable,
  parseHead as fleetParseHead,
  classifySession as fleetClassifySession,
  sessionsSnapshot as fleetSessionsSnapshot,
  excludedBySlug as fleetExcludedBySlug,
  type FleetEntry,
  type SessionItem,
} from './core/fleet.ts';
import { shouldSkipHook, paceSample, type PaceConfig, type PaceState } from './core/pacer.ts';
import {
  decide as topicGateDecide,
  decideHint,
  decideTopicCheck,
  isDesktopApp,
  message as topicGateMessage,
  hintMessage,
  topicCheckMessage,
  lastActiveMs,
  clearOffered,
  type TopicGateCfg,
} from './core/topic-gate.ts';
import { parseTailLines, analyze as boundaryAnalyze, decide as boundaryDecide, message as boundaryMessage, tokLabel } from './core/boundary.ts';
import { chatTurns, parseRows, recallLines, noPreviousLine } from './core/recall.ts';
import { usageChip, noWindowChip, dailyUse, todayUse, chipColor, type ChipExtra } from './core/usage-chip.ts';
import {
  scan as handoffScan,
  renderCapped,
  accumulate,
  nextRecent,
  fallbackPromptTs,
  promptStamps,
  buildMeta,
  pickFromData,
  additionalContext as handoffAdditionalContext,
  safeId,
  sessionFileName,
  latestFileName,
  type Accumulated,
  type NotePairFetch,
  TAIL_BYTES as HANDOFF_TAIL_BYTES,
  clearedSelf,
  CLEAR_LINK_MAX_SEC,
  decidePrompt,
  decidePromptReason,
  markerKey,
  clearContext,
  withTranscriptLine,
  pickClearNote,
  pendingClearName,
  recentLog,
  staleNotes,
  noteText,
} from './core/handoff.ts';
import { apiRows } from './core/api-rows.ts';
import { computeProfile, cacheIsFresh, firstCallTokensFromText, meetsMinEffect, hintLine, type ProfileResult } from './core/clear-savings.ts';
import { segment as statuslineSegment, legacyStatusNotice } from './core/statusline.ts';
import { joinPath, estimateTokens, encodeCwd, tildePath } from './core/text.ts';
import { splitArgs, dayAgo, skippedLine, walkJsonl, type CmdIO } from './core/cmd-io.ts';
import { createAgg as reportAgg, render as reportRender, sinceMsOf, defaultWindow as reportDefaultWindow, defaultWindowNote as reportWindowNote, DEFAULT_REPORT_DAYS } from './core/report.ts';
import { compute as savingsCompute, renderText as savingsRender, parseArgs as savingsArgs } from './core/savings.ts';
import {
  DIR as EVENTS_DIR,
  KEEP_MS as EVENTS_KEEP_MS,
  ROTATE_AT as EVENTS_ROTATE_AT,
  header as eventHeader,
  oldName as eventOldName,
  ownerOf as eventOwner,
  pickSlot,
  readEvents,
} from './core/events.ts';
import {
  DEFAULTS as BOARD_DEFAULTS,
  SID_RE as BOARD_SID_RE,
  isRowFile as boardIsRowFile,
  readBoardEntries as boardReadEntries,
  pruneList as boardPruneList,
  tailText as boardTailText,
  tailMetrics as boardTailMetrics,
  agentTailTokens as boardAgentTailTokens,
  liveAgentIds as boardLiveAgentIds,
  row as boardRowOf,
  rowsPayload as boardRowsPayload,
  applyPayload as boardApplyPayload,
  applyEvent as boardApplyEvent,
  ledgerOf as boardLedgerOf,
  ledgerAfter as boardLedgerAfter,
  pendingApprovals as boardPending,
  rememberProposals as boardRemember,
  recordApplyResult as boardRecordApplyResult,
  pushRecord as boardPushRecord,
  docFiles as boardDocFiles,
  docVersion as boardDocVersion,
  lastDetected as boardLastDetected,
  type BoardEntry,
} from './core/board.ts';
import { buildReport as auditBuild, render as auditRender, parseArgs as auditArgs } from './core/audit.ts';
import * as advRun from './core/advisor-run.ts';
import * as advApply from './core/advisor-apply.ts';
import * as advWeekly from './core/advisor-weekly.ts';
import type { AdvisorCtx } from './core/advisor-io.ts';
import { priceOf as advPriceOf, strip as advStrip } from './core/advisor-pricing.ts';
import { decide as subWaitDecide } from './core/sub-wait.ts';
import { advisorCardMessage } from './core/setup-nudge.ts';

type $T = EngineInterface;
type Cfg = Record<string, any>;

const BOUNDARY_TAIL_BYTES = 256 * 1024;

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

// ============================================================================
// Environment, read once per hook. `$.env.get` names must be string literals.
// ============================================================================

interface Env {
  home: string; // the data folder (pace.js::home())
  userHome: string;
  entrypoint: string;
  host: string; // CLAUDE_CODE_HOST_SESSION_ID: the desktop app's session id
  autoCompactWindow: number | null;
  autoCompactPct: number | null;
  configDir: string;
}

async function readEnv($: $T): Promise<Env> {
  const [tsHome, tpHome, profile, posixHome, entrypoint, host, win, pct, configDir] = await Promise.all([
    $.env.get('TOKEN_STAMINA_HOME'),
    $.env.get('TOKEN_PACER_HOME'),
    $.env.get('USERPROFILE'),
    $.env.get('HOME'),
    $.env.get('CLAUDE_CODE_ENTRYPOINT'),
    $.env.get('CLAUDE_CODE_HOST_SESSION_ID'),
    $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW'),
    $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'),
    $.env.get('CLAUDE_CONFIG_DIR'),
  ]);
  // Node's os.homedir(): USERPROFILE on Windows, HOME elsewhere.
  const userHome = profile || posixHome || '';
  return {
    home: tsHome || tpHome || joinPath(userHome, '.claude', 'token-stamina'),
    userHome,
    entrypoint: entrypoint || '',
    host: host || '',
    autoCompactWindow: num(Number(win)) || null,
    autoCompactPct: num(Number(pct)) || null,
    configDir: configDir || joinPath(userHome, '.claude'),
  };
}

// ============================================================================
// File helpers over $.fs (read rejects when missing or over 4 MiB; write makes folders).
// ============================================================================

async function readText($: $T, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path);
  } catch {
    return null;
  }
}

async function readJson<T>($: $T, path: string, fallback: T): Promise<T> {
  const t = await readText($, path);
  if (t == null) return fallback;
  try {
    return JSON.parse(t) as T;
  } catch {
    return fallback;
  }
}

async function writeText($: $T, path: string, text: string): Promise<void> {
  try {
    await $.fs.write(path, text);
  } catch {
    /* best-effort, never block */
  }
}

const writeJson = ($: $T, path: string, obj: unknown) => writeText($, path, JSON.stringify(obj));

async function mtimeOf($: $T, path: string): Promise<number | null> {
  try {
    return (await $.fs.stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

// The event log, one JSON line per event with `v: 5` (PLAN §2), in the session's own slot file
// events/sXXX.jsonl (core/events.ts): a slot is written by one session, so by one process, and $.fs
// rewriting the whole file loses no other process's line. Writes from this module are chained so two
// hooks never interleave. Past 3 MiB a slot is moved aside to sXXX.old.jsonl.
const slotOf = new Map<string, string>();
const noSlot = new Set<string>();
let eventChain: Promise<void> = Promise.resolve();
function appendEvent($: $T, env: Env, ev: Record<string, unknown>): Promise<void> {
  const nowMs = Date.now();
  const line = JSON.stringify(Object.assign({ v: 5, ts: new Date(nowMs).toISOString() }, ev)) + '\n';
  const sid = safeId(typeof ev.session === 'string' ? ev.session : undefined);
  // No session id: every such process would share one slot, so the line is not written. A session
  // that found no slot (folder crowded) does not search again in this process.
  if (sid === 'unknown' || noSlot.has(sid)) return eventChain;
  eventChain = eventChain.then(async () => {
    try {
      const dir = joinPath(env.home, EVENTS_DIR);
      const at = (n: string) => joinPath(dir, n);
      const skip = new Set<string>();
      for (let tries = 0; tries < 3; tries++) {
        let name = slotOf.get(sid);
        let prev: string | null = name ? await readText($, at(name)) : null;
        if (!name || prev == null || eventOwner(prev) !== sid) {
          if (name) skip.add(name);
          const list = await $.fs.list(dir).catch(() => []);
          const pick = await pickSlot(sid, list.filter((x) => x.kind === 'file'), nowMs, (n) => readText($, at(n)), skip);
          if (!pick) { noSlot.add(sid); return; } // every slot searched is held by a live session: the line is dropped
          name = pick.name;
          if (pick.fresh) {
            await $.fs.write(at(name), eventHeader(sid, nowMs));
            const old = at(eventOldName(name));
            const om = await mtimeOf($, old);
            if (om !== null && nowMs - om > EVENTS_KEEP_MS) await $.fs.write(old, ''); // a past owner's events
            prev = await readText($, at(name));
            if (eventOwner(prev) !== sid) { skip.add(name); continue; } // another session took it first
          } else prev = pick.text;
          slotOf.set(sid, name);
        }
        if (prev!.length > EVENTS_ROTATE_AT / 3 && new TextEncoder().encode(prev!).length > EVENTS_ROTATE_AT) {
          await $.fs.write(at(eventOldName(name)), prev!);
          prev = eventHeader(sid, nowMs);
        }
        await $.fs.write(at(name), prev + line);
        return;
      }
    } catch {
      /* best-effort, never block */
    }
  });
  return eventChain;
}

// ============================================================================
// Config (pace.js::loadConfig, lang.js::withLang).
// ============================================================================

async function loadUserConfigRaw($: $T, env: Env): Promise<Cfg> {
  const c = await readJson($, joinPath(env.home, 'config.json'), {} as Cfg | null);
  return c && typeof c === 'object' ? c : {};
}

async function loadConfig($: $T, env: Env): Promise<{ cfg: Cfg; user: Cfg }> {
  const def = await readJson($, joinPath($.plugin.root, 'config.default.json'), {} as Cfg);
  const user = await loadUserConfigRaw($, env);
  return { cfg: Object.assign({}, def, user), user };
}

async function withLangFrom($: $T, env: Env, cfg: Cfg, prompt: string | null, sid: string | undefined, nowMs: number): Promise<Cfg> {
  const bookFile = joinPath(env.home, 'lang.json');
  const book = await readJson($, bookFile, {} as LangBook);
  const r = resolveLang(cfg as any, prompt, sid, book, nowMs);
  if (r.nextBook) await writeJson($, bookFile, r.nextBook);
  return withLang(cfg, r.lang);
}

// ============================================================================
// Transcript. The file is read whole (its tail is what the pure parsers take). A transcript
// over 4 MiB cannot be read through $.fs; then the conversation is rebuilt from
// $.session.messages({ as: 'api' }) as transcript-shaped rows (no timestamps, no usage).
// ============================================================================

interface Transcript { raw: string | null; bytes: Uint8Array | null; fallback: any[] | null }

async function readTranscript($: $T, path: string | undefined): Promise<Transcript> {
  const raw = path ? await readText($, path) : null;
  if (raw != null) return { raw, bytes: new TextEncoder().encode(raw), fallback: null };
  try {
    const msgs: any = await $.session.messages({ as: 'api' });
    if (!Array.isArray(msgs)) return { raw: null, bytes: null, fallback: [] };
    return { raw: null, bytes: null, fallback: apiRows(msgs) };
  } catch {
    return { raw: null, bytes: null, fallback: [] };
  }
}

function tail(t: Transcript, bytes: number): any[] {
  if (t.bytes) {
    try {
      return parseTailLines(t.bytes, bytes);
    } catch {
      return [];
    }
  }
  return t.fallback || [];
}

// ============================================================================
// Usage: $.session.usage() -> PaceState ({seven_day, five_hour: {pct, resets_at}}, seconds), the
// shape state.json kept. With no rate-limit reading yet (before the first answer), state.json
// stands in; a fresh reading is written back so other sessions and the commands see it.
// ============================================================================

interface Usage { state: PaceState; tokens: number; window: number | null; noWindows: boolean; usd: number | null }

// A session that has had an answer (the context holds tokens) whose rate limits carry neither a 5-hour nor a weekly window: a plan
// with no such limit (an Enterprise seat, an API key). state.json must not stand in then: its weekly reading is another account's.
function hasNoWindows(u: any): boolean {
  if (!u) return false;
  const rls: any[] = Array.isArray(u.rateLimits) ? u.rateLimits : [];
  if (rls.some((r) => r && (r.kind === 'five_hour' || r.kind === 'seven_day'))) return false;
  return (num(u.context && u.context.tokens) || 0) > 0;
}

async function readUsage($: $T, env: Env, nowMs: number): Promise<Usage> {
  const nowSec = Math.floor(nowMs / 1000);
  const stateFile = joinPath(env.home, 'state.json');
  let u: any = null;
  try {
    u = await $.session.usage();
  } catch {
    u = null;
  }
  const fresh: Record<string, unknown> = {};
  for (const rl of (u && Array.isArray(u.rateLimits) ? u.rateLimits : []) as any[]) {
    const key = rl && rl.kind === 'seven_day' ? 'seven_day' : rl && rl.kind === 'five_hour' ? 'five_hour' : null;
    const pct = num(rl && rl.percentUsed);
    const resets = rl && rl.resetsAt ? Math.floor(Date.parse(rl.resetsAt) / 1000) : NaN;
    if (key && pct != null && Number.isFinite(resets)) fresh[key] = { pct, resets_at: resets, recorded_at: nowSec };
  }
  const noWin = hasNoWindows(u);
  const prev = noWin ? {} : await readJson($, stateFile, {} as Record<string, any>);
  let state: PaceState = prev && typeof prev === 'object' ? (prev as PaceState) : {};
  if (Object.keys(fresh).length) {
    state = Object.assign({}, prev, fresh, { recorded_at: nowSec, source: 'mod' }) as PaceState;
    await writeJson($, stateFile, state);
  }
  const ctx = u && u.context;
  return { state, tokens: num(ctx && ctx.tokens) || 0, window: num(ctx && ctx.window), noWindows: noWin, usd: num(u && u.cost && u.cost.usd) };
}

// ============================================================================
// Status line ($.ui.status), statusline.js's segment. cfg.wrap (another status command run
// first) is not available: a mod cannot run a shell command's status line.
// ============================================================================

function updateStatus($: $T, usage: Usage, cfg: Cfg, user: Cfg): void {
  try {
    const st: any = usage.state;
    const input = {
      rate_limits: {
        seven_day: st.seven_day ? { used_percentage: st.seven_day.pct, resets_at: st.seven_day.resets_at } : undefined,
        five_hour: st.five_hour ? { used_percentage: st.five_hour.pct, resets_at: st.five_hour.resets_at } : undefined,
      },
      context_window: { total_input_tokens: usage.tokens, context_window_size: usage.window ?? undefined },
    };
    const text = statuslineSegment(input as any, usage.state, Math.floor(Date.now() / 1000), cfg as any, user);
    $.ui.status(text || undefined);
  } catch {
    /* never block on the status line */
  }
}

// ============================================================================
// clear-savings profile for the "(estimate) ... saved" suffix. The cross-session history scan
// (scripts/clear-savings.js) is not ported: only its cache, compact-point.json, is read.
// ============================================================================

async function buildProfile($: $T, env: Env, cfg: Cfg, entries: any[], raw: string | null): Promise<ProfileResult> {
  const cache = await readJson($, joinPath(env.home, 'compact-point.json'), null as { ts: number; threshold: number | null } | null);
  const cached = cache ? cacheIsFresh(cache, Date.now()) : undefined;
  return computeProfile({
    cfgFixedTokens: num(cfg.fixedTokens),
    firstCallTokensValue: raw ? firstCallTokensFromText(raw) : null,
    cfgCompactAtTokens: num(cfg.compactAtTokens),
    entries,
    envWindow: env.autoCompactWindow,
    cfgCompactWindowTokens: num(cfg.compactWindowTokens),
    envPct: env.autoCompactPct,
    historyThresholdValue: cached ?? null,
  });
}

// Per-session books (nudge.json, boundary.json, topic-gate.json) keep the newest 50.
// Keys starting with "_" (nudge.json's machine-wide "_global" stamp) are not sessions: neither counted nor trimmed.
function trimBook(book: Record<string, { ts: number }>, max = 50): void {
  const keys = Object.keys(book).filter((k) => !k.startsWith('_'));
  if (keys.length <= max) return;
  keys
    .sort((x, y) => (book[x]?.ts ?? 0) - (book[y]?.ts ?? 0))
    .slice(0, keys.length - max)
    .forEach((k) => delete book[k]);
}

// pace_sample: numbers-only record of the pace readings, at most once an hour on this machine (pace-sample.json holds the
// last time), so a later back-test can judge the yellow threshold. Best-effort.
async function recordPaceSample($: $T, env: Env, cfg: Cfg, state: PaceState, sid: string, nowMs: number): Promise<void> {
  try {
    const file = joinPath(env.home, 'pace-sample.json');
    const last = await readJson($, file, {} as { ts?: number });
    if (typeof last.ts === 'number' && nowMs - last.ts < 3600 * 1000 && nowMs >= last.ts) return;
    const s = paceSample(state, Math.floor(nowMs / 1000), cfg as PaceConfig);
    if (!s) return;
    await writeJson($, file, { ts: nowMs });
    await appendEvent($, env, { event: 'pace_sample', session: sid, ...s });
  } catch {
    /* best-effort */
  }
}

// nudge.js::run: one line when the pace grade changes for this session.
async function nudge($: $T, env: Env, cfg: Cfg, state: PaceState, sid: string, event: string, nowMs: number): Promise<string | null> {
  await recordPaceSample($, env, cfg, state, sid, nowMs);
  try {
    const file = joinPath(env.home, 'nudge.json');
    const book = await readJson($, file, {} as Record<string, any>);
    const last = book[sid]?.grade;
    // _global = the last alert sent on this machine (seconds, as nudge.decide compares it with `now`)
    const g = book._global;
    const global = g && typeof g.ts === 'number' && typeof g.grade === 'string' ? { grade: g.grade as string, ts: g.ts as number } : null;
    const nowSec = Math.floor(nowMs / 1000);
    const d = nudgeDecide({ hook_event_name: event }, state, cfg as NudgeCfg, nowSec, last, global);
    const gradeChanged = !!d.grade && d.grade !== last;
    if (gradeChanged || d.global) {
      if (gradeChanged) book[sid] = { grade: d.grade, ts: nowMs };
      if (d.global) book._global = d.global;
      trimBook(book);
      await writeJson($, file, book);
    }
    if (!d.text) return null;
    const line = attributed(d.text, cfg.lang, cfg._langAuto);
    await appendEvent($, env, { event: 'nudge', session: sid, hook: event, grade: d.grade, worst: d.worst, line_tokens: estimateTokens(line) });
    return line;
  } catch {
    return null;
  }
}

// Marker keys this process already consumed (a marker whose delete failed must not inject its note a second time).
const spentMarkers = new Set<string>();

// Did a plugin line (hint, topic check or gate) reach the old session within 3h before it cleared?
async function hintedBefore($: $T, env: Env, mk: { from: string; at: number }): Promise<boolean> {
  try {
    const book = await readJson($, joinPath(env.home, 'topic-gate.json'), {} as Record<string, any>);
    const rec = book[mk.from];
    if (!rec) return false;
    const spoke = ['hintAt', 'checkedAt', 'gatedAt'].some((k) => typeof rec[k] === 'number');
    return spoke && typeof rec.ts === 'number' && rec.ts >= mk.at - 3 * 3600 * 1000;
  } catch {
    return false;
  }
}

const BUTTON_HOST = 'button';
// Restore from the desktop-app clear marker (pending-clear-<host>.json), shared by SessionStart and
// UserPromptSubmit. $.fs cannot delete, so a used marker is overwritten with {} (read as absent).
async function restoreMarked($: $T, env: Env, sid: string, nowMs: number, via: string, lang: string): Promise<string | null> {
  try {
    const dir = joinPath(env.home, 'handoff');
    // The desktop host's marker; else the Clear button's own (written when there is no host id, e.g. in the terminal).
    let pf = env.host ? pendingClearName(dir, env.host) : '';
    let mk = pf ? await readJson($, pf, null as any) : null;
    if (!mk || !mk.from) {
      pf = pendingClearName(dir, BUTTON_HOST);
      mk = await readJson($, pf, null as any);
      if (!mk || !mk.from || mk.button !== true) return null;
    }
    const key = markerKey(mk);
    if (spentMarkers.has(key)) return null; // already handled by this process (a failed delete must not re-inject)
    const dec = decidePromptReason(mk, sid, nowMs);
    if (dec.action === 'drop' && dec.reason === 'own') {
      // This session is the one that pressed the button: the clear has not happened (yet). The marker stays for the session
      // the clear starts, until it expires (0.6.13); one event per marker records that it was left.
      if (!notClearedLogged.has(key)) {
        notClearedLogged.add(key);
        await appendEvent($, env, { event: 'handoff_drop', session: sid, source: via, reason: 'not_cleared', from_session: mk.from, age_sec: typeof mk.at === 'number' ? Math.round((nowMs - mk.at) / 1000) : null });
      }
      return null;
    }
    if (via === 'clear_start') await loadBand($); // the band reads the marker, which the next line spends
    // Consumed on every attempt, as the Node script's unlink. Written directly (writeText swallows the failure): a
    // write that fails must still mark the marker spent in this process, or every later prompt injects the note again.
    try {
      await $.fs.write(pf, '{}');
    } catch {
      /* spent below all the same */
    }
    spentMarkers.add(key);
    const drop = async (reason: string) => {
      await appendEvent($, env, { event: 'handoff_drop', session: sid, source: via, reason, from_session: mk.from, age_sec: typeof mk.at === 'number' ? Math.round((nowMs - mk.at) / 1000) : null });
      return null;
    };
    if (dec.action !== 'restore') return drop(dec.reason);
    const cf = sessionFileName(dir, mk.from, true);
    const ctext = await readNote($, cf);
    const ct = ctext === null ? null : await mtimeOf($, cf);
    const p = pickClearNote(ct === null ? null : ctext, ct, await readNote($, sessionFileName(dir, mk.from)), mk.at);
    if (!p) return drop('no_note');
    const ev: Record<string, unknown> = { event: 'handoff_restore', session: sid, source: mk.button === true ? 'clear_button' : via, kind: p.kind, from_session: mk.from };
    if (typeof mk.tokens === 'number' && mk.tokens > 0) ev.tokens_at_clear = mk.tokens;
    ev.hinted = await hintedBefore($, env, mk);
    await appendEvent($, env, ev);
    await showRecent($, env, mk.from, lang);
    return clearContext({ ...p, text: withTranscriptLine(p.text, typeof mk.transcript === 'string' && mk.transcript ? tildePath(mk.transcript, env.userHome) : null) });
  } catch {
    return null;
  }
}

// After a clear, draw the old session's last turns on screen ($.ui.log is not sent to the model).
async function showRecent($: $T, env: Env, from: string, lang: string): Promise<void> {
  try {
    const acc = await readJson($, joinPath(env.home, 'handoff', `${safeId(from)}.json`), null as Accumulated | null);
    for (const line of recentLog((acc && acc.recent) || [], lang)) $.ui.log(line);
  } catch {
    /* on-screen replay is best-effort */
  }
}

// The old session's last turns for the band above the prompt, drawn before the first prompt of the cleared
// session. Reads the clear marker without consuming it (the first prompt does that) and applies the same
// freshness and own-session test; null when there is nothing to show.
async function loadRecentBand($: $T): Promise<{ lines: string[]; ko: boolean } | null> {
  try {
    const env = await readEnv($);
    if (!env.host) return null;
    const { cfg } = await loadConfig($, env);
    if (cfg.handoff === false) return null;
    const mk = await readJson($, pendingClearName(joinPath(env.home, 'handoff'), env.host), null as any);
    if (!mk || decidePrompt(mk, safeId(await $.session.id()), Date.now()) !== 'restore') return null;
    const acc = await readJson($, joinPath(env.home, 'handoff', `${safeId(mk.from)}.json`), null as Accumulated | null);
    const lang = cfg.lang || 'en';
    const lines = recentLog((acc && acc.recent) || [], lang);
    return lines.length ? { lines, ko: lang === 'ko' } : null;
  } catch {
    return null;
  }
}

// The Clear button's record (recall.json), when it is fresh: the session it cleared and its context size then.
async function buttonClear($: $T, env: Env, nowMs: number): Promise<{ from: string; tokens: number } | null> {
  const rj = await readJson($, joinPath(env.home, 'recall.json'), null as any);
  if (!rj || !rj.from || typeof rj.at !== 'number' || nowMs - rj.at > 3600 * 1000 || nowMs < rj.at) return null;
  return { from: safeId(rj.from), tokens: typeof rj.tokens === 'number' ? rj.tokens : 0 };
}

// A note file emptied by pruneNotes reads as missing (text and mtime null).
const readNote = async ($: $T, path: string) => noteText(await readText($, path));

async function notePair($: $T, autoFile: string, claudeFile: string): Promise<NotePairFetch> {
  const [autoText, claudeText, autoMtimeMs, claudeMtimeMs] = await Promise.all([
    readNote($, autoFile),
    readNote($, claudeFile),
    mtimeOf($, autoFile),
    mtimeOf($, claudeFile),
  ]);
  return { autoFile, claudeFile, autoText, claudeText, autoMtimeMs: autoText == null ? null : autoMtimeMs, claudeMtimeMs: claudeText == null ? null : claudeMtimeMs };
}

// handoff.js::prune without unlink: note files unchanged for 7 days are emptied, at most once an hour per process.
let prunedAt = 0;
let tmpPruned = false;

// `*.json.<pid>.tmp` files in the data folder: what an interrupted atomic write of the Node versions left. Once per process, those a day
// old are emptied (a mod cannot delete; an emptied one is skipped on every later run).
async function pruneTmp($: $T, env: Env, nowMs: number): Promise<void> {
  if (tmpPruned) return;
  tmpPruned = true;
  try {
    for (const x of await $.fs.list(env.home)) {
      if (x.kind === 'file' && x.size > 0 && /\.json\.\d+\.tmp$/.test(x.name) && nowMs - x.mtimeMs > 86400 * 1000) await writeText($, joinPath(env.home, x.name), '');
    }
  } catch {
    /* no data folder yet */
  }
}

async function pruneNotes($: $T, env: Env, nowMs: number): Promise<void> {
  await pruneTmp($, env, nowMs);
  if (nowMs - prunedAt < 3600 * 1000) return;
  prunedAt = nowMs;
  try {
    const dir = joinPath(env.home, 'handoff');
    for (const n of staleNotes(await $.fs.list(dir), nowMs)) await writeText($, joinPath(dir, n), '');
  } catch {
    /* no handoff folder yet */
  }
}

// Where the main transcript of each session lives, learned from the classic events; tool.call
// carries no transcript_path. Module state: a reload loses it until the next classic event.
const transcripts = new Map<string, string>();
// Which classic events reached this process (0.6.13). A managed plugin ahead of this one can send them past it with
// next.to(e, <deeper tier>); then none of these is ever set, while prompt.submit / turn.complete (non-classic) still run.
let classicCount = 0; // classic events seen
let turnsSeen = 0; // prompt.submit / turn.complete seen: proof this process runs turns
const classicStopSeen = new Set<string>(); // sessions whose classic.Stop ran (it saves the note, so turn.complete need not)
const bypassLogged = new Set<string>();
const seenSessions = new Set<string>(); // every session id this process saw
const ctxSeen = new Set<string>(); // sessions prompt.context has fired for
const restoredVia = new Map<string, number>(); // sid -> when a classic / prompt.submit path injected a restore (prompt.context then skips)
const ctxRestoredAt = new Map<string, number>(); // sid -> when prompt.context injected one (the classic latest-note path then skips)
const notClearedLogged = new Set<string>();
// How the last session of this process ended (session.end: clear, resume, exit ...). After a /clear no session.start fires, but
// session.end does, so the first prompt.context of the next session can tell a /clear from a /resume (0.6.14).
let lastEnd: { sid: string; reason: string; at: number } | null = null;
// clearCheck's own evidence (never consumed, unlike lastEnd): the last session.end with reason clear, and the last
// session prompt.context saw for the first time. Either one after the press means the clear ran.
let lastClearEnd: { sid: string; at: number } | null = null;
let lastNewCtx: { sid: string; at: number } | null = null;
const END_MAX_AGE_MS = 6 * 3600 * 1000;
const RESTORE_DEDUP_MS = 30 * 60 * 1000;
const CTX_COMPACT_GAP_MS = 20 * 60 * 1000; // prompt.context fires once per conversation: a compact restore at most this often per session

function remember(e: { session_id?: string; transcript_path?: string }): void {
  classicCount++;
  if (e.session_id) seenSessions.add(safeId(e.session_id));
  if (e.session_id && e.transcript_path) transcripts.set(e.session_id, e.transcript_path);
}

// The first cwd each session was seen in: Claude Code keeps the transcript under the folder of the cwd the session STARTED in, and a
// long session moves (X, then X/sub, then X again), so the current cwd alone can name a folder that has no such file (0.6.14).
const firstCwd = new Map<string, string>();
const transcriptSearchedAt = new Map<string, number>();
const TRANSCRIPT_RESEARCH_MS = 5 * 60 * 1000;
function noteCwd(sidRaw: string | undefined, cwd: string | undefined): void {
  if (sidRaw && cwd && !firstCwd.has(sidRaw)) firstCwd.set(sidRaw, cwd);
}

// The main transcript of a session without a classic event (0.6.13): the one a classic event named, else the file Claude
// Code keeps at <config>/projects/<encoded cwd>/<session id>.jsonl, when it exists: the cwd the session first had, then the current
// one, then (once, and again after 5 minutes if it was not there yet) a look through projects/*/<session id>.jsonl. Cached.
async function transcriptFor($: $T, env: Env, sidRaw: string | undefined, cwd: string | undefined): Promise<string | undefined> {
  if (!sidRaw) return undefined;
  const known = transcripts.get(sidRaw);
  if (known) return known;
  if (!/^[A-Za-z0-9_-]+$/.test(sidRaw)) return undefined;
  noteCwd(sidRaw, cwd);
  try {
    const projects = joinPath(env.configDir, 'projects');
    const tried = new Set<string>();
    for (const c of [firstCwd.get(sidRaw), cwd]) {
      if (!c) continue;
      const dir = encodeCwd(c);
      if (tried.has(dir)) continue;
      tried.add(dir);
      const path = joinPath(projects, dir, sidRaw + '.jsonl');
      if (await $.fs.exists(path)) {
        transcripts.set(sidRaw, path);
        return path;
      }
    }
    const now = Date.now();
    const last = transcriptSearchedAt.get(sidRaw);
    if (last === undefined || now - last > TRANSCRIPT_RESEARCH_MS) {
      transcriptSearchedAt.set(sidRaw, now);
      for (const d of await $.fs.list(projects)) {
        if (d.kind !== 'dir' || tried.has(d.name)) continue;
        const path = joinPath(projects, d.name, sidRaw + '.jsonl');
        if (await $.fs.exists(path)) {
          transcripts.set(sidRaw, path);
          return path;
        }
      }
    }
  } catch {
    /* no derived path */
  }
  return undefined;
}

// True when turns run here but no classic hook ever did: a managed plugin is sending them past this one.
const classicBypassed = (): boolean => turnsSeen > 0 && classicCount === 0;

async function noteBypass($: $T, env: Env, sid: string): Promise<void> {
  if (bypassLogged.has(sid)) return;
  bypassLogged.add(sid);
  await appendEvent($, env, { event: 'classic_bypassed', session: sid, turns: turnsSeen });
}

// ============================================================================
// classic.SessionStart
// ============================================================================

// Once per install: an old Node status line entry gets one on-screen line pointing to setup.
async function legacyStatusOnce($: $T, env: Env, lang: string, nowMs: number): Promise<void> {
  const mark = joinPath(env.home, 'legacy-statusline.json');
  if (await $.fs.exists(mark)) return;
  const line = legacyStatusNotice(await readText($, joinPath(env.configDir, 'settings.json')), lang);
  if (!line) return;
  $.ui.log(line);
  await writeJson($, mark, { shown_at: new Date(nowMs).toISOString() });
}

async function onSessionStart($: $T, e: any): Promise<string[]> {
  remember(e);
  const env = await readEnv($);
  const { cfg: cfg0, user } = await loadConfig($, env);
  if (shouldSkipHook(env.entrypoint, e.cwd, cfg0.excludeCwd)) return [];
  const nowMs = Date.now();
  const cfg = await withLangFrom($, env, cfg0, null, e.session_id, nowMs);
  const sid = e.session_id || 'unknown';
  const usage = await readUsage($, env, nowMs);
  updateStatus($, usage, cfg, user);
  const out: string[] = [];

  const n = await nudge($, env, cfg, usage.state, sid, 'SessionStart', nowMs);
  if (n) out.push(n);
  out.push(...(await advisorSessionStart($, env, cfg, nowMs, e.source)));
  await oldModelWarn($, env, cfg, e, sid, nowMs);

  if (e.source === 'startup') await legacyStatusOnce($, env, cfg.lang || 'en', nowMs);
  if (cfg.handoff !== false) await pruneNotes($, env, nowMs);

  if (cfg.handoff !== false && (e.source === 'startup' || e.source === 'clear')) {
    const r = await restoreMarked($, env, safeId(sid), nowMs, 'clear_start', cfg.lang || 'en');
    if (r) {
      restoredVia.set(safeId(sid), nowMs);
      return [...out, r]; // handoff.js answered alone (the nudge line already recorded stays)
    }
  }

  if (cfg.handoff !== false && (e.source === 'compact' || e.source === 'clear')) {
    // prompt.context just injected this session's note (it ran first): the second path adds nothing
    const done = ctxRestoredAt.get(safeId(sid));
    if (!(done !== undefined && nowMs - done < RESTORE_DEDUP_MS)) {
      const ctx = await restoreLatest($, env, cfg, safeId(sid), sid, e.cwd, e.source, nowMs);
      if (ctx) {
        out.push(ctx);
        restoredVia.set(safeId(sid), nowMs);
      }
    }
  }
  return out;
}

// The compact / clear restore from the session's own note or the cwd's latest one (handoff.js::runStart), shared by the
// classic SessionStart and prompt.context. Records handoff_restore; returns the text for the model, or null.
async function restoreLatest($: $T, env: Env, cfg: Cfg, sidS: string, sid: string, cwd: string | undefined, source: 'clear' | 'compact', nowMs: number): Promise<string | null> {
  try {
    const dir = joinPath(env.home, 'handoff');
    const own = await notePair($, sessionFileName(dir, sidS), sessionFileName(dir, sidS, true));
    const latest = await notePair($, latestFileName(dir, cwd), latestFileName(dir, cwd, true));
    const fromSide = await readText($, latestFileName(dir, cwd, true) + '.from');
    const p = pickFromData(sidS, source, own, latest, fromSide ? fromSide.trim() : null, nowMs);
    if (!p) return null;
    // A clear the Clear button started is recorded as source clear_button (savings section C counts it as a clear).
    const btn = source === 'clear' && p.from ? await buttonClear($, env, nowMs) : null;
    const viaButton = !!btn && safeId(p.from) === btn.from;
    await appendEvent($, env, {
      event: 'handoff_restore',
      session: sid,
      source: viaButton ? 'clear_button' : source,
      kind: p.kind,
      fallback: p.fallback,
      from_session: source === 'clear' ? p.from || null : undefined,
      tokens_at_clear: viaButton && btn!.tokens > 0 ? btn!.tokens : undefined,
    });
    if (source === 'clear' && p.from) await showRecent($, env, p.from, cfg.lang || 'en');
    return handoffAdditionalContext(p) || null;
  } catch {
    return null; /* restore is best-effort */
  }
}

// prompt.context (0.6.13): the restore that does not depend on a classic hook. Fires once per conversation, and again after a
// /clear or a compaction. Blocks it returns reach the model with the first message. Marker first (the Clear button, a desktop
// clear_session), then, with no marker, the same compact / clear notes the classic SessionStart restores.
async function contextRestore($: $T): Promise<string | null> {
  try {
    const env = await readEnv($);
    const { cfg: cfg0 } = await loadConfig($, env);
    if (cfg0.handoff === false) return null;
    const sidRaw = (await $.session.id()) || undefined;
    if (!sidRaw) return null;
    let cwd: string | undefined;
    try {
      cwd = await $.session.cwd();
    } catch {
      cwd = undefined;
    }
    if (shouldSkipHook(env.entrypoint, cwd, cfg0.excludeCwd)) return null;
    const sid = safeId(sidRaw);
    noteCwd(sidRaw, cwd);
    const nowMs = Date.now();
    const first = !ctxSeen.has(sid);
    const otherBefore = [...seenSessions].some((x) => x !== sid);
    if (first) lastNewCtx = { sid, at: nowMs };
    ctxSeen.add(sid);
    seenSessions.add(sid);
    const via = restoredVia.get(sid);
    if (via !== undefined) {
      restoredVia.delete(sid);
      if (nowMs - via < RESTORE_DEDUP_MS) return null; // a classic hook or prompt.submit already put the note in
    }
    const cfg = await withLangFrom($, env, cfg0, null, sidRaw, nowMs);
    const marked = await restoreMarked($, env, sid, nowMs, 'clear_prompt', cfg.lang || 'en');
    if (marked) {
      ctxRestoredAt.set(sid, nowMs);
      return marked;
    }
    // No marker: a later call for the same session is a compaction (the conversation is read again); a first call in a process
    // that already saw another session is taken for a /clear. A plain startup restores nothing.
    let source: 'clear' | 'compact' | null = null;
    if (!first) {
      const last = ctxRestoredAt.get(sid) ?? 0;
      if (nowMs - last > CTX_COMPACT_GAP_MS) source = 'compact';
    } else if (otherBefore) {
      // session.end said how the session before this one ended: a clear restores, a resume or an exit does not. With no report
      // (the hook did not run) the old guess stays: another session came first, so this is a clear.
      const end = lastEnd && safeId(lastEnd.sid) !== sid && nowMs - lastEnd.at < END_MAX_AGE_MS ? lastEnd : null;
      if (end) {
        lastEnd = null;
        source = end.reason === 'clear' ? 'clear' : null;
      } else source = 'clear';
    }
    if (!source) return null;
    const text = await restoreLatest($, env, cfg, sid, sidRaw, cwd, source, nowMs);
    if (text) ctxRestoredAt.set(sid, nowMs);
    return text;
  } catch {
    return null;
  }
}

// prompt.submit (0.6.13): the second non-classic path for the marker, as the first prompt of a cleared session reaches the model.
async function submitRestore($: $T): Promise<string | null> {
  try {
    const env = await readEnv($);
    const { cfg: cfg0 } = await loadConfig($, env);
    if (cfg0.handoff === false) return null;
    const sidRaw = (await $.session.id()) || undefined;
    if (!sidRaw) return null;
    let cwd: string | undefined;
    try {
      cwd = await $.session.cwd();
    } catch {
      cwd = undefined;
    }
    if (shouldSkipHook(env.entrypoint, cwd, cfg0.excludeCwd)) return null;
    const nowMs = Date.now();
    const cfg = await withLangFrom($, env, cfg0, null, sidRaw, nowMs);
    const r = await restoreMarked($, env, safeId(sidRaw), nowMs, 'clear_prompt', cfg.lang || 'en');
    if (r) restoredVia.set(safeId(sidRaw), nowMs);
    return r;
  } catch {
    return null;
  }
}

// ============================================================================
// classic.UserPromptSubmit
// ============================================================================

// Size of one injected line as the model reads it (with the source tail).
const lineTokens = (line: string, cfg: Cfg): number => estimateTokens(attributed(line, cfg.lang || 'en', cfg._langAuto));

// One prompt is served once. Both the non-classic path (prompt.submit) and the classic UserPromptSubmit may run for it (the classic
// one is the second path); whichever comes second finds the other's claim on the same text and stands down. 0.6.14.
const promptClaims = new Map<string, { text: string; at: number; by: 'classic' | 'submit' }>();
const PROMPT_CLAIM_MS = 10 * 60 * 1000;
const normText = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
function claimPrompt(sid: string, text: unknown, by: 'classic' | 'submit', nowMs: number): boolean {
  const prev = promptClaims.get(sid);
  promptClaims.set(sid, { text: normText(text), at: nowMs, by });
  if (!prev || prev.by === by) return true;
  const age = nowMs - prev.at;
  if (age > PROMPT_CLAIM_MS) return true;
  if (prev.text === normText(text) || age < 5000) {
    promptClaims.delete(sid); // the pair is complete
    return false;
  }
  return true;
}

interface GateIn { sid: string; cwd: string | undefined; prompt: string | null; tp: string | undefined; usage: Usage; nowMs: number }

// topic-gate.js::run: the idle/cwd gate, the context-size hint and the topic check for one prompt, as the one line the model reads
// (null when none speaks). Also keeps topic-gate.json, whose promptAt/prevPromptAt are the prompt times that stand in for the
// timestamps a transcript rebuilt from $.session.messages lacks. Throws on a failure; the callers decide what to keep.
async function topicGateLines($: $T, env: Env, cfg: Cfg, user: Cfg, g: GateIn): Promise<string | null> {
  const { sid, nowMs, usage } = g;
  const app = isDesktopApp({ CLAUDE_CODE_ENTRYPOINT: env.entrypoint });
  const e = { cwd: g.cwd, prompt: g.prompt };
  {
    {
      const t = await readTranscript($, g.tp);
      const entries = tail(t, BOUNDARY_TAIL_BYTES);
      // PLAN §3: the context size comes from $.session.usage(); the transcript's last usage
      // row (what the Node script read) only when the engine has no reading yet.
      const tokens = usage.tokens || boundaryAnalyze(entries).tokens;
      const file = joinPath(env.home, 'topic-gate.json');
      const book = await readJson($, file, {} as Record<string, any>);
      const rec = book[sid];
      const noteFile = sessionFileName(joinPath(env.home, 'handoff'), safeId(sid), true);
      // the path as shown to the model: `~/...` under the user's home (shorter; the tools expand it); the file itself is unchanged
      const noteShown = tildePath(noteFile, env.userHome);
      // no timestamps in a transcript rebuilt from $.session.messages: the last Stop time stands in
      const stopAt = t.raw == null ? (await readJson($, joinPath(env.home, 'handoff', `${safeId(sid)}.json`), {} as Accumulated)).stopAt : undefined;
      const d = topicGateDecide({ tokens, lastAssistantMs: lastActiveMs(entries, stopAt, rec && rec.promptAt), nowMs, cwd: e.cwd }, cfg as TopicGateCfg, user, rec);
      // hintTrigger "gap" needs the idle/cwd gap `d` measured; hintMinEffectTokens drops a hint whose card is too small.
      let h = decideHint(tokens, cfg as TopicGateCfg, user, rec && rec.hintAt, d, rec && rec.hintCount);
      let hintProf: ProfileResult | null = null;
      if (h.hint) {
        hintProf = await buildProfile($, env, cfg, entries, t.raw);
        if (!meetsMinEffect(tokens, 'clear', cfg as any, hintProf)) h = { hint: false, hintAt: rec && typeof rec.hintAt === 'number' ? rec.hintAt : null, hintCount: rec && typeof rec.hintCount === 'number' ? rec.hintCount : rec && typeof rec.hintAt === 'number' ? 1 : 0, first: false };
      }
      let offeredAt = rec && rec.offeredAt;
      if (typeof offeredAt === 'number' && tokens < offeredAt) offeredAt = null;
      if (typeof offeredAt !== 'number' && clearOffered(entries)) offeredAt = tokens;
      const checkedAt = rec && rec.checkedAt;
      const tc = d.gate || h.hint ? { check: false, offeredAt, checkedAt } : decideTopicCheck(tokens, cfg as TopicGateCfg, user, offeredAt, checkedAt);
      book[sid] = {
        cwd: e.cwd || (rec && rec.cwd),
        gatedAt: d.gate ? tokens : rec && rec.gatedAt,
        hintAt: h.hintAt,
        hintCount: h.hintCount,
        offeredAt: typeof tc.offeredAt === 'number' ? tc.offeredAt : null,
        checkedAt: typeof tc.checkedAt === 'number' ? tc.checkedAt : null,
        ...promptStamps(e.prompt, rec, nowMs),
        ts: nowMs,
      };
      trimBook(book);
      await writeJson($, file, book);

      const lines: string[] = [];
      if (d.gate) {
        const line = topicGateMessage(cfg.lang || 'en', tokens, d.idleSec ?? 0, !!d.cwdChanged, noteShown, app);
        await appendEvent($, env, { event: 'topic_gate', session: sid, tokens, idle_sec: Math.round(d.idleSec ?? 0), cwd_changed: d.cwdChanged, line_tokens: lineTokens(line, cfg) });
        lines.push(line);
      }
      if (h.hint) {
        const line = hintMessage(cfg.lang || 'en', tokens, noteShown, cfg as TopicGateCfg, hintProf as any, app, h.first);
        await appendEvent($, env, { event: 'inline_hint', session: sid, tokens, line_tokens: lineTokens(line, cfg) });
        lines.push(line);
      }
      if (tc.check) {
        const line = topicCheckMessage(cfg.lang || 'en', tokens, noteShown, app);
        await appendEvent($, env, { event: 'topic_check', session: sid, tokens, line_tokens: lineTokens(line, cfg) });
        lines.push(line);
      }
      return lines.length ? attributed(lines.join(' '), cfg.lang || 'en', cfg._langAuto) : null;
    }
  }
}

// Only the prompt time, when the whole gate could not run (A2): the same record and format topicGateLines keeps.
async function stampPrompt($: $T, env: Env, sid: string, cwd: string | undefined, prompt: string | null, nowMs: number): Promise<void> {
  const file = joinPath(env.home, 'topic-gate.json');
  const book = await readJson($, file, {} as Record<string, any>);
  const rec = book[sid];
  book[sid] = { ...(rec || {}), cwd: cwd || (rec && rec.cwd), ...promptStamps(prompt, rec, nowMs), ts: nowMs };
  trimBook(book);
  await writeJson($, file, book);
}

async function onUserPromptSubmit($: $T, e: any): Promise<string[]> {
  remember(e);
  const env = await readEnv($);
  const { cfg: cfg0, user } = await loadConfig($, env);
  if (shouldSkipHook(env.entrypoint, e.cwd, cfg0.excludeCwd)) return [];
  const nowMs = Date.now();
  const cfg = await withLangFrom($, env, cfg0, e.prompt ?? null, e.session_id, nowMs);
  const sid = e.session_id || 'unknown';
  const usage = await readUsage($, env, nowMs);
  updateStatus($, usage, cfg, user);
  const out: string[] = [];
  // prompt.submit served this prompt already (it comes first): the hints, the nudge and the model warning are not given twice
  const mine = claimPrompt(sid, e.prompt, 'classic', nowMs);

  // --- topic-gate.js::run ---
  if (e.transcript_path && mine) {
    try {
      const line = await topicGateLines($, env, cfg, user, { sid, cwd: e.cwd, prompt: e.prompt ?? null, tp: e.transcript_path, usage, nowMs });
      if (line) out.push(line);
    } catch {
      /* topic-gate is best-effort */
    }
  }

  // --- handoff.js::runPrompt: the first prompt after the desktop app's clear_session ---
  if (cfg.handoff !== false) {
    const r = await restoreMarked($, env, safeId(sid), nowMs, 'clear_prompt', cfg.lang || 'en');
    if (r) {
      out.push(r);
      restoredVia.set(safeId(sid), nowMs);
    }
  }

  if (!mine) return out;
  const n = await nudge($, env, cfg, usage.state, sid, 'UserPromptSubmit', nowMs);
  if (n) out.push(n);
  await oldModelWarn($, env, cfg, e, sid, nowMs);
  return out;
}

// prompt.submit (0.6.14): the hints and gate lines without a classic hook. What the topic gate, the context-size hint, the topic
// check and the pace nudge said in classic.UserPromptSubmit goes to the model as `context` beside the prompt; the old-model warning
// is a screen line. The inputs come from $.session (id, cwd, usage = the context size) and the transcript file found by
// transcriptFor, or $.session.messages when it is over 4 MiB. A prompt the person did not type (isMeta) or a slash command gets none.
async function submitHints($: $T, e: any): Promise<{ topic: string | null; nudge: string | null }> {
  const none = { topic: null, nudge: null };
  try {
    const env = await readEnv($);
    const { cfg: cfg0, user } = await loadConfig($, env);
    const sidRaw = (await $.session.id()) || undefined;
    if (!sidRaw) return none;
    let cwd: string | undefined;
    try {
      cwd = await $.session.cwd();
    } catch {
      cwd = undefined;
    }
    if (shouldSkipHook(env.entrypoint, cwd, cfg0.excludeCwd)) return none;
    const nowMs = Date.now();
    if (!claimPrompt(sidRaw, e.text, 'submit', nowMs)) return none; // the classic hook served this prompt
    const cfg = await withLangFrom($, env, cfg0, e.text ?? null, sidRaw, nowMs);
    const usage = await readUsage($, env, nowMs);
    updateStatus($, usage, cfg, user);
    const tp = await transcriptFor($, env, sidRaw, cwd);
    let topic: string | null = null;
    try {
      topic = await topicGateLines($, env, cfg, user, { sid: sidRaw, cwd, prompt: e.text ?? null, tp, usage, nowMs });
    } catch {
      // the prompt time still goes into topic-gate.json: a big chat's note reads its prompt times from there
      try {
        await stampPrompt($, env, sidRaw, cwd, e.text ?? null, nowMs);
      } catch {
        /* best-effort */
      }
    }
    const nudgeLine = await nudge($, env, cfg, usage.state, sidRaw, 'UserPromptSubmit', nowMs);
    await oldModelWarn($, env, cfg, { transcript_path: tp || '-', session_id: sidRaw }, sidRaw, nowMs);
    return { topic, nudge: nudgeLine };
  } catch {
    return none;
  }
}

async function submitContext($: $T, e: any): Promise<string[]> {
  if (e.isMeta || e.command) return [];
  const out: string[] = [];
  const hints = await submitHints($, e);
  if (hints.topic) out.push(hints.topic);
  const note = await submitRestore($);
  if (note) out.push(note);
  if (hints.nudge) out.push(hints.nudge);
  return out;
}

// When each session's note was last written (any path: Stop, turn.complete, a button, clear_session) and the turns since. turn.complete
// saves only when the last save is N turns or N minutes old (A6): rebuilding the note reads the whole conversation, which is slow on a big chat.
const lastSave = new Map<string, { turns: number; at: number }>();
function saveDue(sid: string, cfg: Cfg, nowMs: number): boolean {
  const everyTurns = Math.max(1, Math.floor(num(cfg.handoffSaveEveryTurns) ?? 5));
  const everyMs = Math.max(0, num(cfg.handoffSaveEveryMin) ?? 10) * 60000;
  const st = lastSave.get(sid);
  if (!st) return true;
  st.turns++;
  return st.turns >= everyTurns || (everyMs > 0 && nowMs - st.at >= everyMs);
}

// The handoff note of handoff.js::runStop: written by the Stop hook and by the Clear button (same function, same files).
async function saveHandoff($: $T, env: Env, cfg: Cfg, e: any, t: Transcript, usage: Usage, nowMs: number): Promise<void> {
  const sid = safeId(e.session_id);
  if (cfg.handoff !== false) {
    try {
      const dir = joinPath(env.home, 'handoff');
      const entries = tail(t, HANDOFF_TAIL_BYTES);
      const sideFile = joinPath(dir, `${sid}.json`);
      const prevAcc = await readJson($, sideFile, { commits: [], files: [] } as Accumulated);
      const fromFallback = t.raw == null;
      let sc = handoffScan(entries, prevAcc.todos);
      if (fromFallback) {
        // no timestamps in the rows: the prompt times topic-gate.json recorded stand in (read only)
        const book = await readJson($, joinPath(env.home, 'topic-gate.json'), {} as Record<string, any>);
        sc = fallbackPromptTs(sc, book[e.session_id || 'unknown'], prevAcc, nowMs);
      }
      const acc = accumulate(prevAcc, sc);
      if (fromFallback) acc.stopAt = nowMs; // the idle-gap stand-in of the next prompt (topic-gate)
      const cleared = !!env.host && clearedSelf(entries, env.host);
      acc.recent = nextRecent(prevAcc.recent, entries, cleared, cfg.clearRecentTurns ?? 3, fromFallback);
      await writeJson($, sideFile, acc);
      const meta = buildMeta(sid, e.cwd, nowMs, sc, acc);
      if (e.transcript_path) meta.transcript = tildePath(e.transcript_path, env.userHome);
      const md = renderCapped(meta, cfg.handoffMaxTokens || 1500, typeof cfg.handoffPrompts === 'number' ? cfg.handoffPrompts : 3);
      await writeText($, sessionFileName(dir, sid), md);
      await writeText($, latestFileName(dir, e.cwd), md);
      // A Claude-written note newer than the cwd's latest one becomes the latest, with its session.
      const cf = sessionFileName(dir, sid, true);
      const ct = (await readNote($, cf)) === null ? null : await mtimeOf($, cf);
      const lcf = latestFileName(dir, e.cwd, true);
      const lct = (await readNote($, lcf)) === null ? 0 : (await mtimeOf($, lcf)) || 0; // an emptied latest note counts as none
      if (ct !== null && lct < ct) {
        const text = await readNote($, cf);
        if (text != null) {
          await writeText($, lcf, text);
          await writeText($, lcf + '.from', sid);
        }
      }
      lastSave.set(sid, { turns: 0, at: nowMs });
      // Desktop-app clear_session that went through: leave a marker for the new session.
      // (The clear_session tool.call hook, clearMark, may have left the same marker already: it stays.)
      if (cleared) {
        const mkFile = pendingClearName(dir, env.host);
        const ex = await readJson($, mkFile, null as any);
        if (!(ex && ex.from === sid && typeof ex.at === 'number' && nowMs - ex.at < CLEAR_LINK_MAX_SEC * 1000)) {
          await writeJson($, mkFile, { from: sid, host: env.host, cwd: e.cwd, at: nowMs, ...(usage.tokens ? { tokens: usage.tokens } : {}), ...(e.transcript_path ? { transcript: e.transcript_path } : {}) });
        }
      }
    } catch {
      /* handoff save is best-effort */
    }
  }
}

// ============================================================================
// tool.call clear_session: the marker no longer waits for the Stop hook to read the clear out of the
// conversation (0.6.12). When the call went through (no deny, no error) on 'self' or the app session id, the note
// is saved and the marker written here, beside the call. A denied or failed call leaves nothing.
// ============================================================================

async function clearMark($: $T, e: any, next: (e: any) => Promise<any>): Promise<any> {
  const ran = await next(e);
  try {
    if (!ran || ran.deny !== undefined || ran.isError) return ran;
    const env = await readEnv($);
    const arg = e.session_id;
    if (!env.host || !(arg === 'self' || arg === env.host)) return ran;
    const { cfg: cfg0 } = await loadConfig($, env);
    if (cfg0.handoff === false) return ran;
    const sidRaw = await $.session.id();
    if (!sidRaw) return ran;
    const sid = safeId(sidRaw);
    const cwd = await $.session.cwd();
    const nowMs = Date.now();
    const tp = await transcriptFor($, env, sidRaw, cwd);
    const usage = await readUsage($, env, nowMs);
    const dir = joinPath(env.home, 'handoff');
    if (tp) {
      // the same note a Stop writes, from the rows as they stand now
      const t = await readTranscript($, tp);
      await saveHandoff($, env, await withLangFrom($, env, cfg0, null, sidRaw, nowMs), { session_id: sidRaw, cwd, transcript_path: tp }, t, usage, nowMs);
    }
    await writeJson($, pendingClearName(dir, env.host), { from: sid, host: env.host, cwd, at: nowMs, ...(usage.tokens ? { tokens: usage.tokens } : {}), ...(tp ? { transcript: tp } : {}) });
    await appendEvent($, env, { event: 'clear_marker', session: sid, via: 'tool_call' });
  } catch {
    /* the Stop hook's own marker is still there as the second chance */
  }
  return ran;
}

// ============================================================================
// classic.Stop: boundary.js (a notice the person sees; the model never reads it) + handoff save.
// ============================================================================

async function onStop($: $T, e: any): Promise<void> {
  remember(e);
  if (e.session_id) classicStopSeen.add(e.session_id);
  const env = await readEnv($);
  const { cfg: cfg0, user } = await loadConfig($, env);
  if (shouldSkipHook(env.entrypoint, e.cwd, cfg0.excludeCwd)) return;
  const nowMs = Date.now();
  const cfg = await withLangFrom($, env, cfg0, null, e.session_id, nowMs);
  const sid = safeId(e.session_id);
  const usage = await readUsage($, env, nowMs);
  updateStatus($, usage, cfg, user);
  if (!e.transcript_path) return;
  const t = await readTranscript($, e.transcript_path);

  // --- boundary.js::run ---
  try {
    const entries = tail(t, BOUNDARY_TAIL_BYTES);
    const res = boundaryAnalyze(entries);
    if (!res.tokens && usage.tokens) (res as any).tokens = usage.tokens;
    if (!res.endsWithAnswer && typeof e.last_assistant_message === 'string' && e.last_assistant_message.trim()) {
      (res as any).endsWithAnswer = true;
    }
    const file = joinPath(env.home, 'boundary.json');
    const book = await readJson($, file, {} as Record<string, { tokens: number; ts: number }>);
    const d = boundaryDecide(res, cfg as any, user, book[sid]?.tokens);
    const bprof = d.notify ? await buildProfile($, env, cfg, entries, t.raw) : null;
    // hintMinEffectTokens: a notice whose card is too small is not given (and not remembered)
    if (d.notify && meetsMinEffect(res.tokens, (d as any).level === 'new_session' ? 'clear' : 'compact', cfg as any, bprof)) {
      book[sid] = { tokens: res.tokens, ts: nowMs };
      trimBook(book);
      await writeJson($, file, book);
      await appendEvent($, env, { event: 'boundary', session: sid, tokens: res.tokens, kind: (d as any).kind, level: (d as any).level, commits: res.commitCount });
      const text = boundaryMessage(res, cfg.lang || 'en', (d as any).level, cfg as any, bprof as any);
      await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } });
    }
  } catch {
    /* boundary is best-effort */
  }

  // --- handoff.js::runStop ---
  await saveHandoff($, env, cfg, e, t, usage, nowMs);

  // --- board.js::run ---
  await boardRow($, env, cfg, e, t, nowMs);
}

// ============================================================================
// turn.complete (0.6.13): the auto save that does not depend on classic.Stop. A managed plugin can send the classic events
// past this one; turn.complete is a different event. Main loop only. When classic.Stop has run for this session it saves
// the same note, so this stands down; otherwise both may run once, which writes the same content twice (harmless).
// ============================================================================

async function onTurnComplete($: $T, e: any): Promise<void> {
  turnsSeen++;
  if (e.agentId !== undefined) return;
  const env = await readEnv($);
  const sidRaw = (await $.session.id()) || undefined;
  if (!sidRaw) return;
  const sid = safeId(sidRaw);
  seenSessions.add(sid);
  const { cfg: cfg0, user } = await loadConfig($, env);
  let cwd: string | undefined;
  try {
    cwd = await $.session.cwd();
  } catch {
    cwd = undefined;
  }
  noteCwd(sidRaw, cwd);
  if (shouldSkipHook(env.entrypoint, cwd, cfg0.excludeCwd)) return;
  const nowMs = Date.now();
  // turns run and no classic event ever came: record it once per session
  if (classicBypassed()) await noteBypass($, env, sid);
  await pruneTmp($, env, nowMs); // once per process, whichever hook runs first
  if (classicStopSeen.has(sidRaw)) return; // classic.Stop saves the note, writes the board row and the pace sample itself
  const cfg = await withLangFrom($, env, cfg0, null, sidRaw, nowMs);
  const usage = await readUsage($, env, nowMs);
  updateStatus($, usage, cfg, user);
  await recordPaceSample($, env, cfg, usage.state, sid, nowMs);
  // the note: only when the last save is old enough (the Clear / Compact buttons and clear_session always save)
  const saveNow = cfg0.handoff !== false && saveDue(sid, cfg, nowMs);
  const boardOn = cfg.board !== false && typeof cfg.dashboardUrl === 'string' && cfg.dashboardUrl.trim() !== '';
  if (!saveNow && !boardOn) return;
  const tp = await transcriptFor($, env, sidRaw, cwd);
  const t = await readTranscript($, tp);
  const ev = { session_id: sidRaw, cwd, transcript_path: tp };
  if (saveNow) await saveHandoff($, env, cfg, ev, t, usage, nowMs);
  if (boardOn) await boardRow($, env, cfg, ev, t, nowMs);
}

// ============================================================================
// tool.call Agent / start_session: agent-model.js::run.
// ============================================================================

const LEDGER = 'explicit-downgrade.json';

// Subagent meta files of one subagents folder plus subagents/workflows/<wf_*>/ (fleet.js::scanDir).
async function collectMetas($: $T, dir: string, entries: FleetEntry[]): Promise<void> {
  const take = async (d: string) => {
    let list: Awaited<ReturnType<$T['fs']['list']>> = [];
    try {
      list = await $.fs.list(d);
    } catch {
      return;
    }
    const byName = new Map(list.map((x) => [x.name, x]));
    for (const x of list) {
      if (!/^agent-.+\.meta\.json$/.test(x.name)) continue;
      const text = await readText($, joinPath(d, x.name));
      if (text == null) continue;
      const jl = byName.get(x.name.replace(/\.meta\.json$/, '.jsonl'));
      entries.push({ name: x.name, mtime: Math.max(x.mtimeMs, jl ? jl.mtimeMs : 0) / 1000, text });
    }
  };
  await take(dir);
  try {
    for (const w of await $.fs.list(joinPath(dir, 'workflows'))) if (w.kind === 'dir') await take(joinPath(dir, 'workflows', w.name));
  } catch {
    /* no workflows */
  }
}

// Running subagents of this session (fleet.js), from <transcript>/subagents/agent-*.meta.json.
// Interactive-session snapshot (scripts/fleet.js scanSessionsCached): kept fleetSessionsCacheSec (30) s.
const sessionsCache = new Map<string, SessionsCacheEnt>();

async function fleetSnapshot($: $T, env: Env, transcriptPath: string | undefined, cfg: Cfg, nowSec: number) {
  try {
    if (cfg.fleet === false || cfg.fleetShowAt === 0) return null;
    const dir = fleetSessionDir(transcriptPath);
    if (!dir) return null;
    const entries: FleetEntry[] = [];
    await collectMetas($, dir, entries);
    const snap = fleetScanEntries(entries, nowSec, cfg as any);
    if (cfg.fleetSessions === false) return fleetPressure(snap);
    const projects = joinPath(env.configDir, 'projects');
    // keyed by the projects folder and this session's own transcript (it is left out of the count)
    const ss = await fleetCachedSessions(sessionsCache, projects + '|' + (transcriptPath || ''), nowSec * 1000, (typeof cfg.fleetSessionsCacheSec === 'number' ? cfg.fleetSessionsCacheSec : 30) * 1000, () =>
      scanSessionsCmd($, projects, transcriptPath || null, nowSec, cfg));
    return fleetPressure(snap, ss);
  } catch {
    return null;
  }
}

const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent']);

// 0.6.8: agent_model_defer is written once per session (this process remembers which sessions it told).
const deferTold = new Set<string>();

// The merged settings (user, project, local, flag, policy) for the two things the Agent hook looks at: PreToolUse hooks
// that cover Agent/Task, and env.CLAUDE_CODE_SUBAGENT_MODEL. Unreadable settings read as empty.
async function readSettingsForAgent($: $T): Promise<{ hooks: unknown; subagentModelEnv: string | null }> {
  let st: any = {};
  try {
    st = (await $.settings.read()) || {};
  } catch {
    /* unreadable settings: no user hook known, no env default */
  }
  const fromSettings = st && st.env && typeof st.env === 'object' && typeof st.env.CLAUDE_CODE_SUBAGENT_MODEL === 'string' ? st.env.CLAUDE_CODE_SUBAGENT_MODEL : '';
  let fromProcess: string | undefined;
  try {
    fromProcess = await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL');
  } catch {
    /* no env access */
  }
  return { hooks: st ? st.hooks : undefined, subagentModelEnv: (fromProcess || fromSettings || '').trim() || null };
}

async function agentModel($: $T, e: any, next: (e: any) => Promise<any>): Promise<any> {
  const kind = e.tool === 'mcp__ccd_session__start_session' ? 'start_session' : 'Agent';
  const env = await readEnv($);
  const [{ cfg: cfg0 }, sessionId, cwd] = await Promise.all([loadConfig($, env), $.session.id(), $.session.cwd()]);
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const toolInput: Record<string, unknown> = {};
  for (const k of Object.keys(e)) if (!RESERVED.has(k)) toolInput[k] = e[k];
  const input: AgentModelInput & { tool_name: string; tool_use_id?: string } = {
    tool_name: e.tool,
    tool_input: toolInput as any,
    cwd,
    session_id: sessionId,
    tool_use_id: e.tool_use_id,
  };
  const cfgL = await withLangFrom($, env, cfg0, null, sessionId, nowMs);
  if (shouldSkipHook(env.entrypoint, cwd, cfgL.excludeCwd)) return next(e);
  // 0.6.8: subagentMode / sessionMode beat mode (core/agent-model.ts effectiveMode); require is for Agent/Task only.
  const em = effectiveMode(cfgL, kind === 'start_session' ? 'start_session' : 'Agent');
  let cfg: Cfg = Object.assign({}, cfgL, { mode: em });
  let dIn: AgentModelInput = input;
  let d: AgentDecision | null = null;
  if (kind === 'start_session') {
    if (cfgL.sessionModelHook === false) return next(e);
    const ad = adaptSession(input, cfgL);
    if (ad.pass) d = { action: 'pass', reason: ad.pass };
    else if (ad.input) dIn = ad.input;
    if (cfgL.sessionModelInject === false) {
      cfg = Object.assign({}, cfgL, { mode: em === 'off' ? 'off' : 'suggest' });
      const xd = cfgL.explicitDowngrade;
      if (!(xd === undefined || xd === null || xd === false || xd === 'off')) cfg.explicitDowngrade = 'suggest';
    }
  }
  let fl: Awaited<ReturnType<typeof fleetSnapshot>> = null;
  let userHook = false;
  let parentModel: string | null = null;
  let envSubagentModel: string | null = null;
  if (!d && kind === 'Agent' && em !== 'off') {
    const stg = await readSettingsForAgent($);
    envSubagentModel = stg.subagentModelEnv;
    try {
      parentModel = (await $.session.model()) || null;
    } catch {
      /* the main model is unknown: the keep-parent row does not apply */
    }
    // A user PreToolUse hook on Agent/Task runs beneath this module, after an inject rewrites the input, and a hook cannot be
    // tried on the original input first ($.tool.check asks no PreToolUse hook): so inject only suggests then. require changes no input (it only denies), so it stays.
    if (em === 'inject' && cfgL.respectUserAgentHooks !== false && userAgentHook(stg.hooks)) {
      userHook = true;
      cfg = Object.assign({}, cfg, { mode: 'suggest' });
    }
  }
  if (!d) {
    const usage = await readUsage($, env, nowMs);
    fl = await fleetSnapshot($, env, transcripts.get(sessionId), cfg, now);
    const ledger = await readJson($, joinPath(env.home, LEDGER), null as any);
    const st = (dIn.tool_input || {}).subagent_type;
    const defs = new Map<string, string | null>();
    for (const p of definitionPaths(st, cwd, env.userHome)) defs.set(p, await readText($, p));
    d = agentModelDecide(dIn, usage.state, cfg as AgentModelCfg, now, {
      fleet: fl,
      ledger,
      homeDir: env.userHome,
      readText: (p) => defs.get(p) ?? null,
      parentModel,
      envSubagentModel,
    });
  }
  // a deny reason is the error text the model reads: no plugin-note suffix (it must stay within 120 tokens)
  if (d.message && d.action !== 'deny') d.message = attributed(d.message, cfg.lang, cfg._langAuto);
  if (userHook && sessionId && !deferTold.has(sessionId)) {
    deferTold.add(sessionId);
    await appendEvent($, env, { event: 'agent_model_defer', session: sessionId, tool: kind, reason: 'user_hook', mode: em });
  }
  if ((d.reason === 'explicit_downgrade' || d.reason === 'explicit_suggest') && d.desc_hash && sessionId) {
    const file = joinPath(env.home, LEDGER);
    await writeJson($, file, recordLedger(await readJson($, file, null as any), sessionId, kind === 'start_session' ? 'session' : 'agent', d.desc_hash, d.requested_model || null, now));
  }
  await appendEvent($, env, {
    event: 'agent_model',
    session: sessionId,
    tool: kind,
    subagent_type: toolInput.subagent_type,
    tool_use_id: e.tool_use_id || null,
    action: d.action,
    reason: d.reason,
    model: d.model || null,
    grade: d.grade || null,
    requested_model: d.requested_model || null,
    desc_hash: d.desc_hash || null,
    fleet_running: fl ? fl.running : null,
    fleet_sessions: fl && typeof (fl as any).sessions === 'number' ? (fl as any).sessions : null,
  });
  if (d.action === 'deny') return { deny: d.message || 'Token Stamina: set a model for this subagent.' };
  // PreToolUse's updatedInput is the rewrite passed to next; its additionalContext is read by the
  // model after the result here (a tool.call answer's `context`), never instead of the result.
  const msgs: string[] = d.message ? [d.message] : [];
  // subagentWaitAdvice (advisor R4): one sentence per session, on the first Agent call
  try {
    if (kind === 'Agent' && cfgL.subagentWaitAdvice === true) {
      const wf = joinPath(env.home, 'agent-model-advice.json');
      const w = waitAdvice({ session_id: sessionId }, kind, cfgL as AgentModelCfg, await readJson($, wf, null as any), nowMs);
      if (w.text) {
        msgs.push(w.text);
        await writeJson($, wf, w.book);
      }
    }
  } catch {
    /* the advice is best-effort */
  }
  const ran = await next(d.action === 'inject' && d.model ? { ...e, model: d.model } : e);
  if (!msgs.length || !ran || ran.deny !== undefined) return ran;
  return { ...ran, context: [...(ran.context || []), ...msgs] };
}

// ============================================================================
// Slash commands (command.run answers { text }, no model): fleet, savings, report, audit.
// The logic is in core/{fleet,savings,report,audit}.ts; this is the file and settings access.
// ============================================================================

// CmdIO over $.fs. A file over 4 MiB rejects on read: with { slim: true } it is streamed through
// scripts/transcript-slim.js (`node`, 3.5 MiB of slim rows per run, resumed with --from until done); a failed
// or impossible slim read counts as skipped and reads as missing.
const SLIM_BUDGET_MS = 150000;
const ADV_SLIM_BUDGET_MS = 120000; // the advisor scan's big transcripts, per command run (the rest wait for the next run)
async function slimRead($: $T, root: string, p: string, deadline: number, extra: string[] = []): Promise<string | null> {
  const script = joinPath(root, 'scripts', 'transcript-slim.js');
  const parts: string[] = [];
  let from = 0;
  for (let runs = 0; runs < 200; runs++) {
    const left = deadline - Date.now();
    if (left < 2000) return null;
    const r = await $.process.run(['node', script, p, '--from', String(from), ...extra], { timeoutMs: Math.min(60000, left) });
    if (r.exitCode !== 0 || r.isStdoutTruncated) return null;
    const lines = String(r.stdout).split('\n');
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    const last = lines[lines.length - 1];
    let next: number | null = null;
    if (last && last.startsWith('{"_next"')) {
      next = Number(JSON.parse(last)._next);
      lines.pop();
    }
    parts.push(lines.join('\n'));
    if (next === null) return parts.join('\n');
    if (!(next > from)) return null;
    from = next;
  }
  return null;
}

function cmdIO($: $T): CmdIO {
  let skipped = 0;
  let slimDeadline = 0;
  let advDeadline = 0;
  let slimOff = false; // node is not there / not allowed: do not try for every file
  return {
    async read(p, opts) {
      try {
        return await $.fs.read(p);
      } catch {
        try {
          if (await $.fs.exists(p)) {
            if (opts && (opts.slim || opts.adv) && !slimOff) {
              if (opts.adv) {
                if (!advDeadline) advDeadline = Date.now() + ADV_SLIM_BUDGET_MS;
              } else if (!slimDeadline) slimDeadline = Date.now() + SLIM_BUDGET_MS;
              try {
                const t = await slimRead($, $.plugin.root, p, opts.adv ? advDeadline : slimDeadline, opts.adv ? ['--adv'] : []);
                if (t !== null) return t;
              } catch {
                slimOff = true; // no node on the PATH, or process.run refused
              }
            }
            skipped++;
          }
        } catch {
          /* not a readable place */
        }
        return null;
      }
    },
    write: (p, t) => $.fs.write(p, t),
    async exists(p) {
      try {
        return await $.fs.exists(p);
      } catch {
        return false;
      }
    },
    async list(p) {
      try {
        return (await $.fs.list(p)).map((x) => ({ name: x.name, kind: x.kind, size: x.size, mtimeMs: x.mtimeMs }));
      } catch {
        return null;
      }
    },
    async realKey(p) {
      try {
        return (await $.fs.stat(p, { resolve: true })).realPath || p;
      } catch {
        return p;
      }
    },
    skipped: () => skipped,
  };
}

interface CmdCtx { env: Env; cfg: Cfg; user: Cfg; sid: string | undefined; cwd: string; io: CmdIO; nowMs: number }

async function cmdContext($: $T): Promise<CmdCtx> {
  const env = await readEnv($);
  const { cfg: cfg0, user } = await loadConfig($, env);
  let sid: string | undefined;
  let cwd = '';
  try {
    sid = await $.session.id();
  } catch {
    /* no session id */
  }
  try {
    cwd = await $.session.cwd();
  } catch {
    /* no cwd */
  }
  const nowMs = Date.now();
  const cfg = await withLangFrom($, env, cfg0, null, sid, nowMs);
  return { env, cfg, user, sid, cwd, io: cmdIO($), nowMs };
}

const norm = (x: string) => String(x).replace(/\\/g, '/').toLowerCase();

// Sessions line of fleet.js::scanSessions. The Node script reads only the first 64 KB of each
// transcript; $.fs.read is all or nothing, so a transcript over 4 MiB is "unknown" here.
async function scanSessionsCmd($: $T, projects: string, selfPath: string | null, nowSec: number, cfg: Cfg) {
  try {
    const active = typeof cfg.fleetSessionActiveSec === 'number' ? cfg.fleetSessionActiveSec : 1800;
    const max = typeof cfg.fleetSessionsMax === 'number' ? cfg.fleetSessionsMax : 20;
    const slugs = (await $.fs.list(projects)).filter((x) => x.kind === 'dir').map((x) => x.name);
    const cand: { slug: string; id: string; path: string; mtime: number }[] = [];
    let excluded = 0;
    for (const slug of slugs) {
      let files: Awaited<ReturnType<$T['fs']['list']>> = [];
      try {
        files = await $.fs.list(joinPath(projects, slug));
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue;
        const m = f.mtimeMs / 1000;
        if (nowSec - m > active) continue;
        const p = joinPath(projects, slug, f.name);
        if (selfPath && norm(p) === norm(selfPath)) continue;
        if (fleetExcludedBySlug(slug, null, cfg.excludeCwd)) {
          excluded++;
          continue;
        }
        cand.push({ slug, id: f.name.replace(/\.jsonl$/, ''), path: p, mtime: m });
      }
    }
    cand.sort((a, b) => b.mtime - a.mtime);
    const items: SessionItem[] = [];
    for (const c of cand.slice(0, max)) {
      const text = await readText($, c.path);
      const head = text == null ? { entrypoint: null, cwd: null } : fleetParseHead(text, false);
      const info = { slug: c.slug, path: c.path, entrypoint: head.entrypoint, cwd: head.cwd };
      items.push({ slug: c.slug, id: c.id, age: Math.max(0, Math.round(nowSec - c.mtime)), kind: fleetClassifySession(info, c.mtime, nowSec, null, cfg as any) });
    }
    return fleetSessionsSnapshot(items, cand.length > max, cfg as any, excluded);
  } catch {
    return null;
  }
}

async function fleetCommand($: $T, args: string): Promise<string> {
  const c = await cmdContext($);
  const o = splitArgs(args);
  const all = o.includes('--all') || c.cfg.fleetScope === 'all';
  const li = o.indexOf('--lang');
  const lang = li >= 0 && o[li + 1] ? (o[li + 1] as string) : (c.cfg.lang as string);
  const nowSec = Math.floor(c.nowMs / 1000);
  const projects = joinPath(c.env.configDir, 'projects');
  const self = (c.sid && transcripts.get(c.sid)) || (c.sid && c.cwd ? joinPath(projects, encodeCwd(c.cwd), c.sid + '.jsonl') : null);

  const entries: FleetEntry[] = [];
  if (all) {
    for (const slug of (await $.fs.list(projects).catch(() => [])).filter((x) => x.kind === 'dir')) {
      for (const s of (await $.fs.list(joinPath(projects, slug.name)).catch(() => [])).filter((x) => x.kind === 'dir')) {
        await collectMetas($, joinPath(projects, slug.name, s.name, 'subagents'), entries);
      }
    }
  } else {
    const dir = fleetSessionDir(self);
    if (dir) await collectMetas($, dir, entries);
  }
  const snap = entries.length ? fleetScanEntries(entries, nowSec, c.cfg as any) : fleetEmptySnap();

  const usage = await readUsage($, c.env, c.nowMs);
  const budget = statuslineSegment({} as any, usage.state, nowSec, c.cfg as any, c.user) || null;
  const ss = c.cfg.fleetSessions !== false ? await scanSessionsCmd($, projects, self, nowSec, c.cfg) : null;

  const lines = [fleetTable(snap, lang, budget, ss, all)];
  if (ss && ss.unknown) {
    lines.push('', lang === 'ko'
      ? '참고: 미확인 세션은 4 MiB 를 넘는 기록이라 mod 판이 앞부분을 읽지 못한 것이에요(Node 판은 앞 64 KB만 읽어요).'
      : 'Note: unknown sessions are transcripts over 4 MiB, whose head the mod build cannot read (the Node build reads only the first 64 KB).');
  }
  return lines.join('\n');
}

async function savingsCommand($: $T, args: string): Promise<string> {
  const c = await cmdContext($);
  const o = savingsArgs(splitArgs(args), dayAgo(7, c.nowMs));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.since)) return 'savings: --since needs YYYY-MM-DD.';
  const r = await savingsCompute(c.io, { since: o.since, projectsDir: joinPath(c.env.configDir, 'projects'), home: c.env.home }, c.cfg as any);
  const body = o.json ? JSON.stringify(r, null, 2) : savingsRender(r, c.cfg.lang as string);
  const skipped = skippedLine(c.io.skipped(), c.cfg.lang as string);
  return skipped ? body + '\n\n' + skipped : body;
}

async function reportCommand($: $T, args: string): Promise<string> {
  const c = await cmdContext($);
  const o = splitArgs(args);
  const opts = { since: null as string | null, until: null as string | null };
  for (let i = 0; i < o.length; i++) {
    if (o[i] === '--since') opts.since = o[++i] || null;
    else if (o[i] === '--until') opts.until = o[++i] || null;
  }
  for (const d of [opts.since, opts.until]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'report: --since and --until need YYYY-MM-DD.';
  const win = reportDefaultWindow(opts, dayAgo(DEFAULT_REPORT_DAYS, c.nowMs));
  const sinceMs = sinceMsOf(win.opts.since);
  const agg = reportAgg(win.opts);
  for (const f of await walkJsonl(c.io, joinPath(c.env.configDir, 'projects'))) {
    if (f.mtimeMs < sinceMs) continue;
    const text = await c.io.read(f.path);
    if (text == null) continue;
    agg.addFile(text, f.sub);
  }
  const body = reportRender(agg.result(), c.cfg.lang as string) + (win.defaulted ? '\n\n' + reportWindowNote(c.cfg.lang as string) : '');
  const skipped = skippedLine(c.io.skipped(), c.cfg.lang as string);
  const full = skipped ? body + '\n\n' + skipped : body;
  return full + '\n\n' + (await eventsLine($, c.env));
}

// Where the event log is (0.6.14): events.jsonl stopped growing when the log moved to one file per session.
async function eventsLine($: $T, env: Env): Promise<string> {
  let n = 0;
  try {
    n = (await $.fs.list(joinPath(env.home, EVENTS_DIR))).filter((x) => x.kind === 'file' && /^s[0-9a-f]{3}\.jsonl$/.test(x.name)).length;
  } catch {
    n = 0;
  }
  return `events: ${EVENTS_DIR}/s???.jsonl (${n} file${n === 1 ? '' : 's'})`;
}

async function auditCommand($: $T, args: string): Promise<string> {
  const c = await cmdContext($);
  let settings: any = {};
  try {
    settings = (await $.settings.read()) || {};
  } catch {
    /* settings unreadable: no enabledPlugins */
  }
  const opts = auditArgs(splitArgs(args), {
    cwd: c.cwd, homeDir: c.env.userHome, claudeDir: c.env.configDir, projectsDir: null, dataDir: c.env.home, settings,
  });
  const r = await auditBuild(c.io, opts);
  return opts.json ? JSON.stringify(r, null, 2) : auditRender(r, c.cfg.lang as string);
}

// A command never throws into the engine: a failure is its answer.
async function answer(name: string, run: () => Promise<string>): Promise<{ text: string }> {
  try {
    return { text: await run() };
  } catch (err) {
    return { text: name + ': ' + (err instanceof Error ? err.message : String(err)) };
  }
}

// ============================================================================
// Efficiency board (scripts/board.js): the row a Stop / UserPromptSubmit hook writes, and the
// `board` tool the /board command calls (rows, apply, record-apply, record-push, json).
// The pure rules are in core/board.ts and core/decisions.ts; this is the file access.
// $.fs has no delete: an expired row file is overwritten with '' (read as no row).
// ============================================================================

const boardDir = (env: Env) => joinPath(env.home, 'board');
const pushDir = (env: Env) => joinPath(env.home, 'board-push');

// Board folder files (<sid>.json by name) as { name, text }, for the pure readers.
async function boardEntries($: $T, env: Env): Promise<BoardEntry[]> {
  const dir = boardDir(env);
  let list: Awaited<ReturnType<$T['fs']['list']>> = [];
  try {
    list = await $.fs.list(dir);
  } catch {
    return [];
  }
  const out: BoardEntry[] = [];
  for (const x of list) {
    if (x.kind !== 'file' || !x.name.endsWith('.json') || !BOARD_SID_RE.test(x.name.slice(0, -5))) continue;
    const text = await readText($, joinPath(dir, x.name));
    if (text != null) out.push({ name: x.name, text });
  }
  return out;
}

// scripts/board.js writeRow: never overwrite a file that is not a row (a session id "decisions" would clobber the ledger).
// An emptied file (a pruned row) may be written again.
async function writeBoardRow($: $T, env: Env, r: any): Promise<boolean> {
  if (!r || !BOARD_SID_RE.test(String(r.sid))) return false;
  const f = joinPath(boardDir(env), r.sid + '.json');
  if (await $.fs.exists(f)) {
    const t = await readText($, f);
    if (t === null) return false;
    if (t.trim() !== '') {
      let cur: unknown = null;
      try {
        cur = JSON.parse(t);
      } catch {
        /* not json: not a row */
      }
      if (!boardIsRowFile(r.sid + '.json', cur)) return false;
    }
  }
  await $.fs.write(f, JSON.stringify(r));
  return true;
}

// scripts/board.js prune without unlink: expired row files are emptied, at most once an hour per process.
let boardPrunedAt = 0;
async function pruneBoard($: $T, env: Env, now: number, cfg: Cfg): Promise<string[]> {
  if (now * 1000 - boardPrunedAt < 3600 * 1000) return [];
  boardPrunedAt = now * 1000;
  const gone = boardPruneList(await boardEntries($, env), now, cfg);
  for (const n of gone) await writeText($, joinPath(boardDir(env), n), '');
  return gone;
}

// Agents' own transcripts: tokens over the tail read (null when none could be read, never 0 for unknown).
async function boardAgentTokens($: $T, dir: string | null, ids: string[], bytes: number): Promise<number | null> {
  if (!dir) return null;
  let sum = 0;
  let any = false;
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) continue;
    const t = await readText($, joinPath(dir, `agent-${id}.jsonl`));
    if (t == null) continue;
    any = true;
    sum += boardAgentTailTokens(boardTailText(t, bytes));
  }
  return any ? sum : null;
}

// The Stop / UserPromptSubmit row. Only with the dashboard set (cfg.dashboardUrl) and cfg.board on; a transcript
// that $.fs cannot read (over 4 MiB) gives no row. Fails open.
async function boardRow($: $T, env: Env, cfg: Cfg, e: any, t: Transcript, nowMs: number): Promise<void> {
  try {
    if (cfg.board === false) return;
    if (typeof cfg.dashboardUrl !== 'string' || !cfg.dashboardUrl.trim()) return;
    if (typeof e.transcript_path !== 'string' || !BOARD_SID_RE.test(String(e.session_id))) return;
    if (t.raw == null) return;
    const now = Math.floor(nowMs / 1000);
    const c = Object.assign({}, BOARD_DEFAULTS, cfg);
    const m = boardTailMetrics(boardTailText(t.raw, c.boardTailBytes), now, c);
    const dir = fleetSessionDir(e.transcript_path);
    let snap: any = fleetEmptySnap();
    if (dir) {
      const entries: FleetEntry[] = [];
      await collectMetas($, dir, entries);
      if (entries.length) snap = fleetScanEntries(entries, now, c as any);
    }
    snap.doneTokens = await boardAgentTokens($, dir, m.agent_done_ids, c.boardTailBytes);
    snap.liveTokens = await boardAgentTokens($, dir, boardLiveAgentIds(snap, m.agent_done_ids), c.boardTailBytes);
    const r = boardRowOf({ sid: e.session_id, cwd: e.cwd, entrypoint: env.entrypoint || null }, m, snap, now, c);
    await writeBoardRow($, env, r);
    await pruneBoard($, env, now, c);
  } catch {
    /* the board never blocks a turn */
  }
}

// A path to a JSON file, or the JSON itself (scripts/board.js readTitles); an object passes as is. null when unreadable.
async function boardArg($: $T, arg: unknown): Promise<any> {
  if (arg == null || arg === '') return null;
  if (typeof arg === 'object') return arg;
  if (typeof arg !== 'string') return null;
  try {
    if (await $.fs.exists(arg)) return JSON.parse(await $.fs.read(arg));
  } catch {
    return null;
  }
  try {
    return JSON.parse(arg);
  } catch {
    return null;
  }
}

// Existing-doc versions from a map file or from a folder ArtifactData list/get wrote with out_dir (sessions/, account/, summary/).
async function boardVersions($: $T, arg: unknown): Promise<Record<string, number> | null> {
  if (arg == null || arg === '') return null;
  if (typeof arg === 'object') return arg as Record<string, number>;
  if (typeof arg !== 'string') return null;
  let kind = '';
  try {
    kind = (await $.fs.stat(arg)).kind;
  } catch {
    /* maybe a folder the stat cannot name: try it as one below */
  }
  if (kind === 'file') {
    try {
      return JSON.parse(await $.fs.read(arg));
    } catch {
      return null;
    }
  }
  const out: Record<string, number> = {};
  let found = false;
  for (const col of ['sessions', 'account', 'summary']) {
    let names: Awaited<ReturnType<$T['fs']['list']>> = [];
    try {
      names = await $.fs.list(joinPath(arg, col));
    } catch {
      continue;
    }
    found = true;
    for (const n of names) {
      if (!n.name.endsWith('.json')) continue;
      const v = boardDocVersion(await readJson($, joinPath(arg, col, n.name), null as any));
      if (v !== null) out[col + '/' + n.name.slice(0, -5)] = v;
    }
  }
  return found || kind === 'dir' ? out : null;
}

const numArg = (x: unknown): number | undefined => (x === undefined || x === null || x === '' ? undefined : (num(Number(x)) ?? undefined));

async function boardRows($: $T, env: Env, e: any): Promise<any> {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const { cfg } = await loadConfig($, env);
  const entries = await boardEntries($, env);
  const rows = boardReadEntries(entries, now, cfg);
  let active: number | null = null;
  try {
    const projects = joinPath(env.configDir, 'projects');
    const ss = await fleetCachedSessions(sessionsCache, projects + '|', nowMs, (typeof cfg.fleetSessionsCacheSec === 'number' ? cfg.fleetSessionsCacheSec : 30) * 1000, () =>
      scanSessionsCmd($, projects, null, now, cfg));
    active = ss ? ss.sessions : null;
  } catch {
    /* optional */
  }
  // The day's budget: board_push events of the last 24 h from every session's slot file.
  const evs = (await readEvents(cmdIO($), env.home, nowMs - 86400 * 1000)).filter((x) => x && x.event === 'board_push');
  const eventsText = evs.map((x) => JSON.stringify(x)).join('\n');
  const pendArg = numArg(e.pending);
  const ledgerDoc = await readJson($, joinPath(boardDir(env), 'decisions.json'), null as any);
  const usage = await readUsage($, env, nowMs);
  const out = boardRowsPayload({
    now, cfg, state: usage.state, rows, activeSessions: active,
    titles: await boardArg($, e.titles), versions: await boardVersions($, e.versions), eventsText,
    last: await readJson($, joinPath(pushDir(env), 'last.json'), null as any),
    pending: pendArg !== undefined ? pendArg || 0 : boardPending(ledgerDoc),
    manager: await readJson($, joinPath(boardDir(env), 'manager.json'), null as any),
    ledger: boardLedgerOf(ledgerDoc),
    detectedLang: boardLastDetected(await readJson($, joinPath(env.home, 'lang.json'), {} as any)),
  });
  if (out.skip) return out;
  if (out.proposals.length) {
    const next = boardRemember(boardLedgerOf(ledgerDoc), out.proposals, now);
    if (next) await $.fs.write(joinPath(boardDir(env), 'decisions.json'), JSON.stringify(next));
  }
  // The batch as files: one data file per doc + the batch json itself (its entries point at the files, so the caller passes them as is).
  const dir = pushDir(env);
  const df = boardDocFiles(out.writes.concat(out.proposal_writes), dir, joinPath);
  for (const f of df.files) await $.fs.write(f.path, JSON.stringify(f.data));
  const batchFile = joinPath(dir, 'batch.json');
  await $.fs.write(batchFile, JSON.stringify({ writes: df.writes }));
  await $.fs.write(joinPath(dir, 'pending.json'), JSON.stringify({ hash: out.hash, ts: now, rows: out.sessions.length }));
  return { skip: false, hash: out.hash, rows: out.sessions.length, writes_count: df.writes.length, batch_file: batchFile, writes: df.writes,
    account: out.account, summary: out.summary, log: out.log, proposals: out.proposals.length };
}

async function boardApply($: $T, env: Env, e: any, sid: string | undefined): Promise<any> {
  const now = Math.floor(Date.now() / 1000);
  const { cfg } = await loadConfig($, env);
  const cfgFile = joinPath(env.home, 'config.json');
  // A config.json that exists but cannot be read or parsed is never overwritten (nor its backup).
  let userCfg: any = {};
  if (await $.fs.exists(cfgFile)) {
    const text = await readText($, cfgFile);
    try {
      userCfg = JSON.parse(text as string);
    } catch {
      throw new Error('config.json could not be read; nothing was applied');
    }
    if (!userCfg || typeof userCfg !== 'object' || Array.isArray(userCfg)) throw new Error('config.json is not an object; nothing was applied');
  }
  const ledgerFile = joinPath(boardDir(env), 'decisions.json');
  const led = boardLedgerOf(await readJson($, ledgerFile, null as any));
  const rows = boardReadEntries(await boardEntries($, env), now, cfg);
  const usage = await readUsage($, env, now * 1000);
  const r = boardApplyPayload({
    now, cfg, userCfg, state: usage.state, rows, ledger: led,
    decisions: await boardArg($, e.decisions), // a proposals document is not read: proposal content comes from the local ledger
    settings: await boardArg($, e.settings), live: await boardArg($, e.live), selfSid: e.self, host: '',
  });
  if (r.configChanged) {
    await $.fs.write(joinPath(env.home, 'config.prev.json'), JSON.stringify(userCfg));
    await $.fs.write(cfgFile, JSON.stringify(r.newUser));
  }
  const next = boardLedgerAfter(led, r.plan.ledgerRows, now);
  if (next) await $.fs.write(ledgerFile, JSON.stringify(next));
  await appendEvent($, env, { ...boardApplyEvent(r), session: sid });
  return r.out;
}

async function boardRecordApply($: $T, env: Env, e: any, sid: string | undefined): Promise<any> {
  const now = Math.floor(Date.now() / 1000);
  const ledgerFile = joinPath(boardDir(env), 'decisions.json');
  const led = boardLedgerOf(await readJson($, ledgerFile, null as any));
  const rr = boardRecordApplyResult(led, await boardArg($, e.results), now);
  if (rr.ledger) await $.fs.write(ledgerFile, JSON.stringify(rr.ledger));
  await appendEvent($, env, { ...rr.event, session: sid });
  return rr.out;
}

async function boardRecordPush($: $T, env: Env, e: any, sid: string | undefined): Promise<any> {
  const now = Math.floor(Date.now() / 1000);
  const pend = await readJson($, joinPath(pushDir(env), 'pending.json'), null as any);
  const rec = boardPushRecord({ tokens: numArg(e.tokens), rows: numArg(e.rows) }, pend, now);
  await $.fs.write(joinPath(pushDir(env), 'last.json'), JSON.stringify(rec));
  await appendEvent($, env, { event: 'board_push', session: sid, rows: rec.rows, tokens: rec.tokens, hash: rec.hash });
  return { recorded: true, rows: rec.rows, tokens: rec.tokens };
}

// The `board` tool: the same JSON scripts/board.js printed for each flag, as one text block. A failure is the answer
// (the Node script's error shape), never a throw into the engine.
// 0.6.8: a tool registered with $.tool.register answers with a string, never an object: the engine checks the result
// against string | array | undefined ("does not match its output shape (invalid_union ...)" for the old
// { content, isError } object). An error answer is a deny, which the model reads as an error result.
type ToolAnswer = { result: string; deny?: undefined } | { deny: string; result?: undefined };
function toolAnswer(text: string, isError: boolean): ToolAnswer {
  return isError ? { deny: text } : { result: text };
}

async function boardTool($: $T, e: any): Promise<ToolAnswer> {
  const mode = String(e.mode);
  let out: unknown;
  let isError = false;
  try {
    const env = await readEnv($);
    let sid: string | undefined;
    try {
      sid = await $.session.id();
    } catch {
      /* no session id: the event goes to the unknown slot */
    }
    if (mode === 'rows') out = await boardRows($, env, e);
    else if (mode === 'apply') out = await boardApply($, env, e, sid);
    else if (mode === 'record-apply') out = await boardRecordApply($, env, e, sid);
    else if (mode === 'record-push') out = await boardRecordPush($, env, e, sid);
    else if (mode === 'json') {
      const { cfg } = await loadConfig($, env);
      const rows = boardReadEntries(await boardEntries($, env), Math.floor(Date.now() / 1000), cfg);
      out = { count: rows.length, source: 'board-dir', rows };
    } else {
      out = { error: 'unknown mode: ' + mode };
      isError = true;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    isError = true;
    out = mode === 'apply' ? { ops: [], error }
      : mode === 'record-apply' ? { results: [], error }
        : mode === 'record-push' ? { recorded: false, error }
          : mode === 'json' ? { count: 0, error }
            : { skip: true, reason: 'error', error };
  }
  return toolAnswer(JSON.stringify(out), isError);
}

// ============================================================================
// Usage Advisor. The pure logic is core/advisor-*.ts over an AdvisorCtx (CmdIO + config); this is
// the file access, the SessionStart weekly run, the `advisor` tool and /ts-advisor.
// ============================================================================

async function advisorCtxFrom($: $T, env: Env, cfg: Cfg, nowMs: number): Promise<AdvisorCtx> {
  const cfgDefaults = await readJson($, joinPath($.plugin.root, 'config.default.json'), {} as Cfg);
  const st = await readJson($, joinPath(env.home, 'state.json'), {} as any);
  const ra = Number(st && st.seven_day && st.seven_day.resets_at);
  // yieldFn: the background scan hands the turn back every few files so other hooks are not held up behind it.
  return { io: cmdIO($), home: env.home, claudeDir: env.configDir, cfg, cfgDefaults, nowMs, sevenDayResetsAt: Number.isFinite(ra) && ra > 0 ? ra : null, yieldFn: () => $.clock.sleep(1) };
}

const ADV_REVIEW_HINT = 'To review: call the token-stamina advisor tool (mode "review"), show its output as it is and ask per item whether to apply it. Never apply without a yes.';

// A weekly run goes on in the background; the person gets one toast when it ends. Never throws.
function advisorBackgroundRun($: $T, ctx: AdvisorCtx, lang: string): void {
  void (async () => {
    try {
      const res = await advWeekly.run(ctx, { gather: (o: any) => advRun.gather(ctx, o), ifDue: true, budgetSec: advWeekly.BUDGET_MS / 1000, lang, now: ctx.nowMs });
      const line = (res.out || '').trim().split('\n')[0];
      const msg = line || (res.result === 'ok' ? 'Token Stamina advisor: weekly check done, nothing to change.' : '');
      if (msg && res.result !== 'error') $.ui.toast(msg);
    } catch {
      /* the weekly check is best-effort */
    }
  })();
}

// SessionStart: seed the weekly schedule on first sight, start the weekly run when it is due, and show
// the pending card (one line + a request to Claude, once per 7 days).
// The weekly run and the pending card belong to a fresh start or a resume (not clear/compact), and the card is only recorded as
// shown when a person is there to read it (a -p / SDK run has no surface).
async function hasHuman($: $T): Promise<boolean> {
  try {
    return (await $.session.surfaces()).length > 0;
  } catch {
    return false;
  }
}

async function advisorSessionStart($: $T, env: Env, cfg: Cfg, nowMs: number, source?: string): Promise<string[]> {
  try {
    if (cfg.advisor === false) return [];
    if (source !== 'startup' && source !== 'resume') return [];
    const ctx = await advisorCtxFrom($, env, cfg, nowMs);
    const out: string[] = [];
    const lang = cfg.lang || 'en';
    if (!(await advWeekly.readSchedule(ctx)).next_due) await advRun.markNextDue(ctx, nowMs);
    const notice = (await hasHuman($)) ? await advWeekly.pendingNotice(ctx, nowMs) : null;
    if (notice) {
      const card = advisorCardMessage(notice.count, lang);
      out.push(attributed(card + ' ' + ADV_REVIEW_HINT, lang, cfg._langAuto));
      try {
        $.ui.toast(card);
      } catch {
        /* no toast */
      }
    }
    if (await advWeekly.dueToRun(ctx, nowMs)) {
      await advWeekly.writeSchedule(ctx, { checked: nowMs });
      advisorBackgroundRun($, ctx, lang);
    }
    return out;
  } catch {
    return [];
  }
}

// oldModelWarn (advisor R5): one notice per session when the last assistant model is an old generation.
async function oldModelWarn($: $T, env: Env, cfg: Cfg, e: any, sid: string, nowMs: number): Promise<void> {
  try {
    if (cfg.oldModelWarn !== true || !e.session_id) return;
    const file = joinPath(env.home, 'old-model-warn.json');
    const book = await readJson($, file, null as any);
    if (book && typeof book === 'object' && book[sid]) return; // already told this session: skip the transcript read
    const t = await readTranscript($, e.transcript_path);
    const r = oldModelNotice({ ...e, transcript_path: e.transcript_path || '-' }, cfg as any, sid, { entries: tail(t, 64 * 1024), book, priceOf: (m: string) => advPriceOf(m) as any, strip: advStrip, now: nowMs });
    if (!r.text) return;
    await writeJson($, file, r.book);
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: r.text }] } });
  } catch {
    /* best-effort */
  }
}

// Bash | PowerShell inside a subagent: one note per agent when the command may run over 5 minutes
// (subagentLongCmdAdvice). A tool.call hook cannot add context before the call, so the note is the call's
// context line (read by the model right after the result). It never blocks.
// The config read is cached per process: this hook runs on every Bash call of a subagent.
// It is re-read only when config.json changed (mtime and size), so a key switched off mid-session still takes effect.
let subWaitCfg: { env: Env; cfg0: Cfg; key: string } | null = null;

async function subWaitConfigKey($: $T, env: Env): Promise<string> {
  try {
    const st = await $.fs.stat(joinPath(env.home, 'config.json'));
    return st.mtimeMs + ':' + st.size;
  } catch {
    return 'none';
  }
}
let subWaitPruned = false;

// Empties (a mod cannot delete) sub-wait/<session>.json files untouched for 2 days; once per process.
async function pruneSubWait($: $T, env: Env, nowMs: number): Promise<void> {
  if (subWaitPruned) return;
  subWaitPruned = true;
  try {
    const dir = joinPath(env.home, 'sub-wait');
    for (const x of await $.fs.list(dir)) {
      if (x.kind === 'file' && x.size > 0 && nowMs - x.mtimeMs > 2 * 24 * 3600 * 1000) await $.fs.write(joinPath(dir, x.name), '');
    }
  } catch {
    /* nothing to prune */
  }
}

async function subWait($: $T, e: any, next: (e: any) => Promise<any>): Promise<any> {
  const ran = await next(e);
  try {
    if (!e.agentId || !ran || ran.deny !== undefined) return ran;
    const env0 = subWaitCfg ? subWaitCfg.env : await readEnv($);
    const key = await subWaitConfigKey($, env0);
    if (!subWaitCfg || subWaitCfg.key !== key) subWaitCfg = { env: env0, cfg0: (await loadConfig($, env0)).cfg, key };
    const { env, cfg0 } = subWaitCfg;
    if (cfg0.subagentLongCmdAdvice !== true) return ran;
    await pruneSubWait($, env, Date.now());
    const cfg = await withLangFrom($, env, cfg0, null, undefined, Date.now());
    const sid = safeId((await $.session.id()) || 'unknown');
    const file = joinPath(env.home, 'sub-wait', sid + '.json');
    const toolInput: Record<string, unknown> = {};
    for (const k of Object.keys(e)) if (!RESERVED.has(k)) toolInput[k] = e[k];
    const seen = await readJson($, file, null as any);
    const r = subWaitDecide({ agent_id: e.agentId, session_id: sid, tool_input: toolInput }, cfg as any, seen && seen.ids);
    if (!r.text) return ran;
    await writeJson($, file, { ids: r.seenIds });
    return { ...ran, context: [...(ran.context || []), r.text] };
  } catch {
    return ran;
  }
}

const idsArg = (x: unknown): string[] => (Array.isArray(x) ? x : typeof x === 'string' ? x.split(/[\s,]+/) : []).map((v) => String(v).trim()).filter(Boolean);

// The person's own yes, asked here and not taken from the model's text. One question per rule, because a rule's values belong
// together (the compact window is a settings.json value and a config value): the question lists every `file key: before -> after`
// line of the rule, and a yes applies all of them, anything else none. The first option is Skip, so a host that auto-answers
// with the first option declines. No person at a surface (-p / SDK run), a dismissed dialog or any other failure means no.
async function askItems($: $T, items: advApply.PlanItem[], settingsNew: boolean): Promise<advApply.PlanItem[] | null> {
  if (!(await hasHuman($))) return null;
  const yes: advApply.PlanItem[] = [];
  try {
    for (const rule of Array.from(new Set(items.map((i) => i.rule)))) {
      const group = items.filter((i) => i.rule === rule);
      const q = `Token Stamina advisor, rule ${rule}: these changes belong together.\n` + group.map((i) => advApply.itemLine(i, settingsNew)).join('\n') + '\n\nApply all of them?';
      if ((await $.ui.ask(q, { options: ['Skip', 'Apply'], header: 'Apply?' })) === 'Apply') yes.push(...group);
    }
  } catch {
    return null;
  }
  return yes.length ? yes : null;
}

// Keep is the first option for the same reason as Skip above.
async function askRestore($: $T, lines: string[]): Promise<boolean> {
  if (!(await hasHuman($))) return false;
  try {
    return (await $.ui.ask('Token Stamina advisor: restore these settings.json values?\n' + lines.join('\n') + '\n\nRestore them?', { options: ['Keep', 'Restore'], header: 'Restore?' })) === 'Restore';
  } catch {
    return false;
  }
}

// Runs one advisor mode. Text results come back as they are (the command shows them verbatim); the plan/apply/revert
// results are JSON.
async function advisorRun($: $T, a: Record<string, any>): Promise<{ text: string; isError: boolean }> {
  const c = await cmdContext($);
  const ctx = await advisorCtxFrom($, c.env, c.cfg, c.nowMs);
  const base = { days: numArg(a.days) ?? null, brief: !!a.brief, json: !!a.json, lang: typeof a.lang === 'string' ? a.lang : null };
  const mode = String(a.mode || '');
  const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  switch (mode) {
    case 'analyze':
      return { text: await advRun.analyze(ctx, { ...base, firstRun: !!a.first }), isError: false };
    case 'recommend':
      return { text: await advRun.recommend(ctx, base), isError: false };
    case 'review':
      return { text: await advRun.review(ctx, { json: base.json, lang: base.lang }), isError: false };
    case 'check':
      return { text: await advRun.check(ctx, { ...base, id: typeof a.id === 'string' ? a.id : undefined, force: !!a.force }), isError: false };
    case 'reject':
      return { text: await advRun.reject(ctx, typeof a.rule === 'string' ? a.rule : undefined), isError: false };
    case 'plan': {
      const r = await advRun.planChanges(ctx, { ...base, ids: idsArg(a.ids) });
      return { text: asText(r), isError: !!r.error };
    }
    case 'apply': {
      const r = await advRun.applyPlan(ctx, { planId: typeof a.planId === 'string' ? a.planId : undefined, approved: idsArg(a.ids), lang: base.lang, confirm: (items, isNew) => askItems($, items, isNew) });
      return { text: asText(r), isError: !r.ok };
    }
    case 'revert': {
      const r = await advRun.revertApply(ctx, { id: typeof a.id === 'string' ? a.id : undefined, last: !!a.last, lang: base.lang, confirmSettings: (lines) => askRestore($, lines) });
      return { text: asText(r), isError: !r.ok };
    }
    default:
      return { text: 'unknown mode: ' + mode + ' (analyze, recommend, plan, apply, revert, reject, review, check)', isError: true };
  }
}

async function advisorTool($: $T, e: any): Promise<ToolAnswer> {
  let r: { text: string; isError: boolean };
  try {
    r = await advisorRun($, e);
  } catch (err) {
    r = { text: 'advisor: ' + (err instanceof Error ? err.message : String(err)), isError: true };
  }
  return toolAnswer(r.text, r.isError);
}

// /ts-advisor [--json] [--days N] [--brief]: the read-only analysis, no model.
async function advisorCommand($: $T, args: string): Promise<string> {
  const toks = splitArgs(args);
  const a: Record<string, any> = { mode: 'recommend' };
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === '--json') a.json = true;
    else if (toks[i] === '--brief') a.brief = true;
    else if (toks[i] === '--days') a.days = toks[++i];
  }
  return (await advisorRun($, a)).text;
}

// ============================================================================
// Wiring.
// ============================================================================

// The band above the prompt after a desktop clear: the old session's last turns, until the first prompt.
// Written with h() calls, not JSX: this module is a .ts file.
const bandAtom = atom({ plugin: 'token-stamina', key: 'band' } as const, null);
const bandOpen = atom({ plugin: 'token-stamina', key: 'isOpen' } as const, false);
const bandGone = atom({ plugin: 'token-stamina', key: 'isGone' } as const, false);
// "Previous chat" button / /ts-recall: where the just-cleared session's transcript is. `recallGone` holds the key of the
// recall whose button was pressed or ran out (5 prompts); the record itself stays for the command.
const recallAtom = atom({ plugin: 'token-stamina', key: 'recall' } as const, null);
const recallGone = atom({ plugin: 'token-stamina', key: 'recallGone' } as const, '');
// The always-on Clear button: switched by config.clearButton, labelled in the session's language.
const clearBtnAtom = atom({ plugin: 'token-stamina', key: 'clearBtn' } as const, null);
// The Compact button and the usage chip (0.6.9): their switches, the data folder and the pace thresholds the chip reads.
const bandExtraAtom = atom({ plugin: 'token-stamina', key: 'bandExtra' } as const, null);

const RECALL_BUTTON_TURNS = 5;
const RECALL_BIG_BYTES = 4 * 1024 * 1024 - 1024; // $.fs.read rejects above 4 MiB
const RECALL_TAIL_BYTES = 3 * 1024 * 1024; // the last turns are at the end: stream only this much of a big file
const RECALL_SEARCH_TAIL_BYTES = 24 * 1024 * 1024; // a search looks further back

async function langOf($: $T, env: Env, cfg0: Cfg, nowMs: number): Promise<{ cfg: Cfg; ko: boolean }> {
  const cfg = await withLangFrom($, env, cfg0, null, (await $.session.id()) || undefined, nowMs);
  return { cfg, ko: cfg.lang === 'ko' };
}

// The previous session this one was cleared from: the desktop marker (clear_session) or recall.json (the Clear button),
// both fresh (60 minutes) and not this very session; null when neither applies or the transcript path is unknown.
async function findRecall($: $T): Promise<Recall | null> {
  try {
    const env = await readEnv($);
    const { cfg: cfg0 } = await loadConfig($, env);
    if (cfg0.handoff === false) return null;
    const nowMs = Date.now();
    const sid = safeId(await $.session.id());
    const { ko } = await langOf($, env, cfg0, nowMs);
    if (env.host) {
      const mk = await readJson($, pendingClearName(joinPath(env.home, 'handoff'), env.host), null as any);
      if (mk && mk.from && typeof mk.transcript === 'string' && mk.transcript && decidePrompt(mk, sid, nowMs) === 'restore') {
        return { from: String(mk.from), transcript: mk.transcript, ko, key: 'm' + mk.from + ':' + mk.at, left: RECALL_BUTTON_TURNS };
      }
    }
    const rj = await readJson($, joinPath(env.home, 'recall.json'), null as any);
    if (rj && rj.from && typeof rj.transcript === 'string' && rj.transcript && safeId(rj.from) !== sid && typeof rj.at === 'number' && nowMs - rj.at <= 3600 * 1000 && nowMs >= rj.at) {
      return { from: String(rj.from), transcript: rj.transcript, ko, key: 'r' + rj.from + ':' + rj.at, left: RECALL_BUTTON_TURNS };
    }
  } catch {
    /* no recall */
  }
  return null;
}

async function loadRecall($: $T): Promise<void> {
  try {
    if (await read($, recallAtom)) return;
    const r = await findRecall($);
    if (r && (await read($, recallGone)) !== r.key) await update($, recallAtom, () => r);
  } catch {
    /* best-effort */
  }
}

let recallLookedAt = 0;
async function loadButtons($: $T): Promise<void> {
  try {
    const env = await readEnv($);
    const { cfg: cfg0 } = await loadConfig($, env);
    const { ko } = await langOf($, env, cfg0, Date.now());
    await update($, clearBtnAtom, () => ({ on: cfg0.clearButton !== false, ko }));
    await update($, bandExtraAtom, () => ({ compact: cfg0.compactButton !== false, chip: cfg0.usageChip !== false, ko, home: env.home, pace: cfg0 }));
  } catch {
    /* best-effort */
  }
}

async function loadBand($: $T): Promise<void> {
  try {
    await loadButtons($);
    await loadRecall($);
    if (await read($, bandGone)) return;
    const b = await loadRecentBand($);
    if (b) await update($, bandAtom, () => b);
  } catch {
    /* the band is best-effort */
  }
}

// The text rows of a transcript for /ts-recall: whole when $.fs can read it, else streamed by scripts/transcript-slim.js
// (--chat, only the end of the file). null when it cannot be read.
async function readChat($: $T, path: string, wide: boolean): Promise<any[] | null> {
  let size = 0;
  try {
    size = (await $.fs.stat(path)).size;
  } catch {
    return null;
  }
  if (size <= RECALL_BIG_BYTES) {
    const text = await readText($, path);
    return text == null ? null : parseRows(text);
  }
  try {
    const t = await slimRead($, $.plugin.root, path, Date.now() + SLIM_BUDGET_MS, ['--chat', '--tail', String(wide ? RECALL_SEARCH_TAIL_BYTES : RECALL_TAIL_BYTES)]);
    return t == null ? null : parseRows(t);
  } catch {
    return null;
  }
}

// /ts-recall and the button: screen only, nothing reaches the model. The terminal gets $.ui.log rows; another surface (the
// desktop draws no $.ui.log row) gets the same lines in one dialog.
async function recallRun($: $T, query: string, surface?: string): Promise<void> {
  let lang = 'en';
  const show = async (lines: string[]): Promise<void> => {
    if (!surface || surface === 'terminal') {
      for (const l of lines) $.ui.log(l);
      return;
    }
    try {
      await $.ui.ask(lines.join('\n').slice(0, 9000), { options: [lang === 'ko' ? '닫기' : 'Close', lang === 'ko' ? '확인' : 'OK'], header: lang === 'ko' ? '이전 대화' : 'Previous chat' });
    } catch {
      /* dismissed */
    }
  };
  try {
    const env = await readEnv($);
    const { cfg: cfg0 } = await loadConfig($, env);
    lang = (await langOf($, env, cfg0, Date.now())).ko ? 'ko' : 'en';
    const rc = (await read($, recallAtom)) || (await findRecall($));
    if (!rc) return await show([noPreviousLine(lang)]);
    const rows = await readChat($, rc.transcript, !!query.trim());
    if (!rows) return await show([noPreviousLine(lang)]);
    await show(recallLines(chatTurns(rows), lang, query));
  } catch {
    await show([noPreviousLine(lang)]);
  }
}

const CLEAR_CHECK_MS = 4000;
// B15: a few seconds after the button ran /clear, the session id should have changed (session.end reported a clear, or
// $.session.id() answers another id). If not, the clear did not run: say so, with what to do (a toast; the desktop draws no log row).
async function clearCheck($: $T, sidRaw: string | undefined, ko: boolean): Promise<void> {
  try {
    const pressedAt = Date.now();
    await $.clock.sleep(CLEAR_CHECK_MS);
    if (!sidRaw) return; // no id to compare: unknown is not "did not run"
    if (lastClearEnd && lastClearEnd.at >= pressedAt) return; // a session ended with reason clear after the press
    if (lastNewCtx && lastNewCtx.at >= pressedAt && lastNewCtx.sid !== safeId(sidRaw)) return; // a new conversation started
    const now = (await $.session.id()) || undefined;
    if (!now || now !== sidRaw) return; // unknown, or a new id: only the same id still answering is proof
    const msg = ko ? 'Token Stamina: /clear 가 실행되지 않았어요. Enter 를 누르거나 /clear 를 입력하세요' : "Token Stamina: /clear did not run. Press Enter or type /clear";
    try {
      $.ui.toast(msg);
    } catch {
      $.ui.log(msg);
    }
  } catch {
    /* the check is best-effort */
  }
}

// The Clear button: save the handoff note (the Stop hook's function), ask, then clear. Events only on a confirmed press.
async function clearPress($: $T, asked = false): Promise<void> {
  let ko = false;
  try {
    const env = await readEnv($);
    const { cfg: cfg0, user } = await loadConfig($, env);
    const nowMs = Date.now();
    const sidRaw = (await $.session.id()) || undefined;
    const { cfg, ko: k } = await langOf($, env, cfg0, nowMs);
    ko = k;
    if (cfg.clearButton === false) return;
    const sid = safeId(sidRaw);
    const usage = await readUsage($, env, nowMs);
    updateStatus($, usage, cfg, user);
    let cwd: string | undefined;
    try {
      cwd = await $.session.cwd();
    } catch {
      cwd = undefined;
    }
    const tp = await transcriptFor($, env, sidRaw, cwd);
    const noteOn = cfg.handoff !== false;
    if (noteOn) await saveHandoff($, env, cfg, { session_id: sidRaw, cwd, transcript_path: tp }, await readTranscript($, tp), usage, nowMs);
    // Classic hooks are being sent past this plugin (a managed plugin): the restore then runs from prompt.context / prompt.submit.
    // Say so on the question instead of clearing silently (0.6.13); the clear itself goes ahead.
    const bypassed = noteOn && classicBypassed();
    if (bypassed) await noteBypass($, env, sid);
    const q0 = noteOn
      ? ko ? '인계 메모는 저장됐어요. 비울까요?' : 'The handoff note is saved. Clear now?'
      : ko ? '비울까요?' : 'Clear now?';
    const q = bypassed ? q0 + (ko ? ' (관리 플러그인 때문에 일부 기능이 꺼져 있어요. 인계 메모는 새 대화 첫 메시지에 붙어요)' : ' (A managed plugin switches off some features. The handoff note is attached to the first message of the new chat)') : q0;
    const yes = ko ? '비우기' : 'Clear';
    let answer = asked ? yes : '';
    if (!asked) {
      try {
        answer = await $.ui.ask(q, [yes, ko ? '취소' : 'Cancel']); // the first option is the default: the press means clear
      } catch {
        return; // dismissed
      }
    }
    if (answer !== yes) return;
    const ev: Record<string, unknown> = { event: 'clear_button', session: sid };
    if (usage.tokens > 0) ev.tokens_at_clear = usage.tokens;
    await appendEvent($, env, ev);
    // The same marker a desktop /clear leaves (read by SessionStart and the first prompt), flagged as the button's: the
    // auto note is restored once even when no Claude note exists.
    if (noteOn) await writeJson($, pendingClearName(joinPath(env.home, 'handoff'), env.host || BUTTON_HOST), { from: sid, host: env.host || BUTTON_HOST, ...(cwd ? { cwd } : {}), at: nowMs, button: true, ...(usage.tokens > 0 ? { tokens: usage.tokens } : {}), ...(tp ? { transcript: tp } : {}) });
    await writeJson($, joinPath(env.home, 'recall.json'), { from: sid, at: nowMs, ...(tp ? { transcript: tp } : {}), ...(usage.tokens > 0 ? { tokens: usage.tokens } : {}) });
    let ran = false;
    try {
      await $.command.run({ command: 'clear' });
      ran = true;
    } catch {
      /* the built-in clear is not runnable from a plugin here: fill the prompt box instead */
    }
    if (ran) {
      await clearCheck($, sidRaw, ko);
      return;
    }
    try {
      const r = await $.prompt.fill({ text: '/clear' });
      if (r && r.isFilled) {
        $.ui.log(ko ? 'Token Stamina: 입력창에 /clear 를 넣었어요 - Enter 를 누르세요 (인계 메모 저장됨)' : 'Token Stamina: /clear is in the prompt box - press Enter (handoff note saved)');
        return;
      }
    } catch {
      /* no prompt box */
    }
    $.ui.log(ko ? 'Token Stamina: /clear 를 입력하세요 - 인계 메모 저장됨' : 'Token Stamina: type /clear - handoff note saved');
  } catch {
    $.ui.log(ko ? 'Token Stamina: 비우기 버튼을 처리하지 못했어요. /clear 를 입력하세요' : 'Token Stamina: the Clear button failed; type /clear');
  }
}

// The Compact button: save the handoff note, ask, then $.session.compact() (the call /compact makes). The event only on a
// compaction that ran.
async function compactPress($: $T, asked = false): Promise<void> {
  let ko = false;
  try {
    const env = await readEnv($);
    const { cfg: cfg0, user } = await loadConfig($, env);
    const nowMs = Date.now();
    const sidRaw = (await $.session.id()) || undefined;
    const { cfg, ko: k } = await langOf($, env, cfg0, nowMs);
    ko = k;
    if (cfg.compactButton === false) return;
    const sid = safeId(sidRaw);
    const usage = await readUsage($, env, nowMs);
    updateStatus($, usage, cfg, user);
    let cwd: string | undefined;
    try {
      cwd = await $.session.cwd();
    } catch {
      cwd = undefined;
    }
    const tp = await transcriptFor($, env, sidRaw, cwd);
    const noteOn = cfg.handoff !== false;
    if (noteOn) await saveHandoff($, env, cfg, { session_id: sidRaw, cwd, transcript_path: tp }, await readTranscript($, tp), usage, nowMs);
    const q = noteOn
      ? ko ? '인계 메모는 저장됐어요. 지금 압축할까요? 대화가 요약으로 바뀌어요' : 'The handoff note is saved. Compact now? The chat becomes a summary.'
      : ko ? '지금 압축할까요? 대화가 요약으로 바뀌어요' : 'Compact now? The chat becomes a summary.';
    const yes = ko ? '압축' : 'Compact';
    let answer = asked ? yes : '';
    if (!asked) {
      try {
        answer = await $.ui.ask(q, [yes, ko ? '취소' : 'Cancel']); // the first option is the default: the press means compact
      } catch {
        return; // dismissed
      }
    }
    if (answer !== yes) return;
    let r: any;
    try {
      r = await $.session.compact();
    } catch {
      $.ui.log(ko ? 'Token Stamina: 지금은 압축할 수 없어요 (답변이 끝난 뒤 다시 눌러 주세요)' : 'Token Stamina: cannot compact right now (press again when the reply has finished)');
      return;
    }
    if (r && typeof r.skip === 'string') {
      $.ui.log(ko ? `Token Stamina: 압축이 건너뛰어졌어요 (${r.skip})` : `Token Stamina: compact was skipped (${r.skip})`);
      return;
    }
    const ev: Record<string, unknown> = { event: 'compact_button', session: sid };
    if (usage.tokens > 0) ev.tokens_at_compact = usage.tokens;
    await appendEvent($, env, ev);
  } catch {
    $.ui.log(ko ? 'Token Stamina: 압축 버튼을 처리하지 못했어요. /compact 를 입력하세요' : 'Token Stamina: the Compact button failed; type /compact');
  }
}

// The pace state for the chip, read without writing anything: the engine's fresh rate limits, else state.json (assess() drops a
// stale one).
async function peekPace($: $T, home: string, u: any): Promise<PaceState> {
  if (hasNoWindows(u)) return {}; // no weekly window on this plan: state.json's weekly reading is not this session's
  const nowSec = Math.floor(Date.now() / 1000);
  const fresh: Record<string, unknown> = {};
  for (const rl of (u && Array.isArray(u.rateLimits) ? u.rateLimits : []) as any[]) {
    const key = rl && rl.kind === 'seven_day' ? 'seven_day' : rl && rl.kind === 'five_hour' ? 'five_hour' : null;
    const pct = num(rl && rl.percentUsed);
    const resets = rl && rl.resetsAt ? Math.floor(Date.parse(rl.resetsAt) / 1000) : NaN;
    if (key && pct != null && Number.isFinite(resets)) fresh[key] = { pct, resets_at: resets, recorded_at: nowSec };
  }
  const prev = (await readJson($, joinPath(home, 'state.json'), {} as Record<string, any>)) as PaceState;
  return Object.assign({}, prev && typeof prev === 'object' ? prev : {}, fresh, Object.keys(fresh).length ? { recorded_at: nowSec } : {}) as PaceState;
}

// The usage chip's press: a dialog that says what the chip is and the numbers behind it (the desktop draws no $.ui.log
// row), with Compact and Clear as choices (Close first = the default). Nothing reaches the model.
async function chipPress($: $T): Promise<void> {
  try {
    const env = await readEnv($);
    const { cfg: cfg0 } = await loadConfig($, env);
    const { cfg, ko } = await langOf($, env, cfg0, Date.now());
    if (cfg.usageChip === false) return;
    let u: any = null;
    try {
      u = await $.session.usage();
    } catch {
      u = null;
    }
    // Everything below is read from files or computed from numbers already kept (no LLM, no transcript scan): the pace_sample
    // events (per-day trend, today), the fleet metas, the Clear/Compact card (clear-savings). The 7-day model split would
    // need a transcript scan (~18 s here), so the dialog points to /ts-report for it.
    const nowMs = Date.now();
    const pace = await peekPace($, env.home, u);
    const lang = ko ? 'ko' : 'en';
    const noWin = hasNoWindows(u);
    const c0 = noWin ? noWindowChip(num(u.context && u.context.tokens) || 0, num(u.cost && u.cost.usd), lang) : usageChip(pace, Math.floor(nowMs / 1000), cfg as PaceConfig, lang);
    if (!c0) return;
    const extra: ChipExtra = {};
    let evs: any[] = [];
    try {
      evs = await readEvents(cmdIO($), env.home, nowMs - 7 * 86400 * 1000);
    } catch {
      evs = [];
    }
    try {
      extra.daily = dailyUse(evs, nowMs);
      const w = pace.seven_day;
      if (w && typeof w.pct === 'number' && typeof w.resets_at === 'number') extra.today = todayUse(evs, nowMs, w.pct, w.resets_at);
    } catch {
      /* no trend */
    }
    let tp: string | undefined;
    try {
      const sidRaw = (await $.session.id()) || undefined;
      tp = await transcriptFor($, env, sidRaw, await $.session.cwd());
    } catch {
      tp = undefined;
    }
    try {
      const fl = tp ? await fleetSnapshot($, env, tp, { ...cfg, fleetSessions: false }, Math.floor(nowMs / 1000)) : null;
      if (fl && fl.running > 0) extra.fleet = { running: fl.running, models: fl.models };
    } catch {
      /* no fleet line */
    }
    try {
      const tokens = num(u && u.context && u.context.tokens) || 0;
      if (tokens > 0) {
        const t = await readTranscript($, tp);
        const prof = await buildProfile($, env, cfg, tail(t, BOUNDARY_TAIL_BYTES), t.raw);
        extra.ctx = { tokens, clearLine: hintLine(tokens, lang, 'clear', cfg as any, prof), compactLine: hintLine(tokens, lang, 'compact', cfg as any, prof) };
      }
    } catch {
      /* no card */
    }
    const c = noWin ? c0 : usageChip(pace, Math.floor(nowMs / 1000), cfg as PaceConfig, lang, extra);
    if (!c) return;
    const close = ko ? '닫기' : 'Close';
    const now = ko ? '지금 압축' : 'Compact now';
    const clr = ko ? '지금 비우기' : 'Clear now';
    let answer = '';
    try {
      answer = await $.ui.ask(c.dialog, { options: [close, now, clr], header: ko ? '사용량' : 'Usage' });
    } catch {
      return; // dismissed
    }
    if (answer === now) await compactPress($, true);
    else if (answer === clr) await clearPress($, true);
  } catch {
    /* the chip is best-effort */
  }
}

// session.start loads it too: that hook is in register, below, with the commands.
function registerBand(on: any): void {
  // The desktop attaches after the process starts: look again if session.start found nothing.
  on('session.attach', async ($: $T, e: any, next: any) => {
    if (!(await read($, bandAtom)) || !(await read($, clearBtnAtom)) || !(await read($, recallAtom))) await loadBand($);
    return next(e);
  }).catch(($: $T, e: any, next: any) => next(e));

  // Any prompt retires the band for good; classic.UserPromptSubmit consumes the marker on its own.
  // The "previous chat" button lives for 5 prompts.
  on('prompt.submit', async ($: $T, e: any, next: any) => {
    turnsSeen++;
    await update($, bandGone, () => true);
    try {
      const rc = (await read($, recallAtom)) as Recall | null;
      if (rc && (await read($, recallGone)) !== rc.key) {
        if (rc.left <= 1) await update($, recallGone, () => rc.key);
        else await update($, recallAtom, () => ({ ...rc, left: rc.left - 1 }));
      }
    } catch {
      /* best-effort */
    }
    // Without a classic hook (0.6.14): the hints and gate lines, and the handoff after a clear, go beside the prompt as context.
    let extra: string[] = [];
    try {
      extra = await submitContext($, e);
    } catch {
      extra = [];
    }
    return next(extra.length ? { ...e, context: [...(e.context || []), ...extra] } : e);
  }).catch(($: $T, e: any, next: any) => next(e));

  // How a session ended (clear, resume, exit): contextRestore reads it to tell a /clear from a /resume; clearCheck reads it too.
  on('session.end', async ($: $T, e: any, next: any) => {
    try {
      if (e && e.sessionId) {
        lastEnd = { sid: String(e.sessionId), reason: String(e.reason || ''), at: Date.now() };
        if (lastEnd.reason === 'clear') lastClearEnd = { sid: lastEnd.sid, at: lastEnd.at };
      }
    } catch {
      /* observe only */
    }
    return next(e);
  }).catch(($: $T, e: any, next: any) => next(e));

  on('ui.render', { component: 'AbovePrompt' }, async ($: $T, e: any, next: any) => {
    if (e.props.hasSurvey) return next(e);
    // Buttons only where the prompt has a band you can press: desktop and terminal (mobile gets none).
    const pressable = e.surface === 'terminal' || e.surface === 'desktop';
    const b = (await read($, bandAtom)) as RecentBand | null;
    const showBand = !!b && !(await read($, bandGone));
    const btn = pressable ? await read($, clearBtnAtom) : null;
    let rc: Recall | null = pressable ? ((await read($, recallAtom)) as Recall | null) : null;
    if (pressable && !rc && Date.now() - recallLookedAt > 5000) {
      // a /clear in this process starts a new session: look for the Clear button's record now and then
      recallLookedAt = Date.now();
      await loadRecall($);
      rc = (await read($, recallAtom)) as Recall | null;
    }
    if (rc && (await read($, recallGone)) === rc.key) rc = null;
    const showClear = !!(btn && btn.on);
    const ex: any = pressable ? await read($, bandExtraAtom) : null;
    const showCompact = !!(ex && ex.compact);
    let u: any = null;
    if (showClear || showCompact || (ex && ex.chip)) {
      try {
        u = await $.session.usage();
      } catch {
        u = null;
      }
    }
    // The chip: only with a fresh weekly reading.
    const chip = ex && ex.chip
      ? hasNoWindows(u)
        ? noWindowChip(num(u.context && u.context.tokens) || 0, num(u.cost && u.cost.usd), ex.ko ? 'ko' : 'en')
        : usageChip(await peekPace($, ex.home, u), Math.floor(Date.now() / 1000), ex.pace as PaceConfig, ex.ko ? 'ko' : 'en')
      : null;
    if (!showBand && !showClear && !showCompact && !chip && !rc) return next(e);
    const inner = await next(e);
    const open = await read($, bandOpen);
    const { Box, Text, Button } = $.ui.resolve(e) as any;
    const ko = b ? b.ko : rc ? rc.ko : btn ? !!btn.ko : !!(ex && ex.ko);
    const row: any[] = [];
    const add = (el: any) => {
      if (row.length) row.push(h(Text, { key: 'sp' + row.length }, ' '));
      row.push(el);
    };
    if (showBand) {
      add(h(Button, { key: 'toggle', label: open ? (b!.ko ? '접기' : 'Collapse') : b!.ko ? '펼치기' : 'Expand', onPress: () => update($, bandOpen, (v: boolean) => !v) }));
      add(h(Button, { key: 'close', label: b!.ko ? '닫기' : 'Close', onPress: () => update($, bandGone, () => true) }));
    }
    if (chip) {
      add(h(Button, { key: 'usage', label: chip.label, onPress: () => { void chipPress($); } }, h(Text, { color: chipColor(chip.grade) }, chip.label)));
    }
    if (showCompact) {
      add(h(Button, { key: 'compact', label: ex.ko ? '압축' : 'Compact', onPress: () => { void compactPress($); } }));
    }
    if (showClear) {
      const tokens = num(u && u.context && u.context.tokens) || 0;
      const word = btn!.ko ? '비우기' : 'Clear';
      add(h(Button, { key: 'clear', label: tokens > 0 ? `${word} (${tokLabel(tokens, btn!.ko ? 'ko' : 'en')})` : word, onPress: () => { void clearPress($); } }));
    }
    if (rc) {
      const keyOf = rc.key;
      add(h(Button, { key: 'recall', label: ko ? '이전 대화' : 'Previous chat', onPress: (p: any) => {
        void (async () => {
          await update($, recallGone, () => keyOf);
          await recallRun($, '', p && p.surface);
        })();
      } }));
    }
    const children: any[] = [];
    if (inner) children.push(inner);
    if (showBand) (open ? b!.lines : b!.lines.slice(0, 1)).forEach((l, i) => children.push(h(Text, { key: 'l' + i, dimColor: true }, l)));
    children.push(h(Box, null, ...row));
    return h(Box, { flexDirection: 'column' }, ...children);
  });
}

export const register: Register = (on) => {
  registerBand(on);
  on('classic.SessionStart', async ($, e, next) => {
    const add = await onSessionStart($, e);
    const r = await next(e);
    return add.length ? { ...r, additionalContext: [...(r.additionalContext || []), ...add] } : r;
  }).catch(($, e, next) => next(e));

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const add = await onUserPromptSubmit($, e);
    const r = await next(e);
    return add.length ? { ...r, additionalContext: [...(r.additionalContext || []), ...add] } : r;
  }).catch(($, e, next) => next(e));

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e);
    await onStop($, e);
    return r;
  }).catch(($, e, next) => next(e));

  // Not classic: still reached when a managed plugin sends the classic events past this plugin (0.6.13).
  on('prompt.context', async ($, e, next) => {
    const text = await contextRestore($);
    return next(text ? { ...e, blocks: [...e.blocks, { name: 'tokenStaminaHandoff', text }] } : e);
  }).catch(($, e, next) => next(e));

  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    try {
      await onTurnComplete($, e);
    } catch {
      /* the auto save is best-effort */
    }
    return r;
  }).catch(($, e, next) => next(e));

  on('tool.call', { tool: 'Agent' }, ($, e, next) => agentModel($, e, next)).catch(($, e, next) => next(e));
  on('tool.call', { tool: 'mcp__ccd_session__start_session' }, ($, e, next) => agentModel($, e, next)).catch(($, e, next) => next(e));
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__clear_session' }, ($, e, next) => clearMark($, e, next)).catch(($, e, next) => next(e));
  on('tool.call', { tool: 'Bash' }, ($, e, next) => subWait($, e, next)).catch(($, e, next) => next(e));
  on('tool.call', { tool: 'PowerShell' }, ($, e, next) => subWait($, e, next)).catch(($, e, next) => next(e));

  // The four commands that only print a table. Each is registered by a literal name (the validator
  // reads the names off the source) and in its own try, so one refused name leaves the others. The
  // run hooks answer their own command: they never read `next`.
  on('session.start', async ($, e, next) => {
    try {
      // the cwd a session starts in names its transcript folder (A1); the id is read from the engine, not from the event
      noteCwd((await $.session.id()) || undefined, (e as any).cwd);
    } catch {
      /* no session id yet */
    }
    await loadBand($);
    try {
      await $.command.register({ name: 'ts-fleet', description: 'Show how many subagents are running now and on which models (read-only, no LLM)', argumentHint: '[--all]' });
    } catch {
      /* name taken */
    }
    try {
      await $.command.register({ name: 'ts-savings', description: 'Estimate tokens saved by Token Stamina (downgrades, compacts and clears after hints) - an estimate, not billing', argumentHint: '[--since YYYY-MM-DD]' });
    } catch {
      /* name taken */
    }
    try {
      await $.command.register({ name: 'ts-report', description: 'Summarize local token usage by model, subagent share and unspecified Agent calls', argumentHint: '[--since YYYY-MM-DD] [--until YYYY-MM-DD]' });
    } catch {
      /* name taken */
    }
    try {
      await $.command.register({ name: 'ts-recall', description: 'Show the last turns of the chat you just cleared (on screen only, not sent to the model); add words to search it', argumentHint: '[search words]' });
    } catch {
      /* name taken */
    }
    try {
      await $.command.register({ name: 'ts-audit', description: 'Audit fixed token costs: always-loaded files, plugins, MCP/skill usage, turn-off candidates (changes nothing)', argumentHint: '[--cwd <path>] [--days 30] [--json]' });
    } catch {
      /* name taken */
    }
    // The board tool (mcp__token-stamina__board), served by the tool.call hook below; /board calls it.
    try {
      await $.tool.register({
        name: 'board',
        isDeferred: true, // only /board uses it: no schema in every session's prompt
        description: 'Token Stamina efficiency board: rows builds the dashboard push (batch file), apply runs approved decisions, record-apply and record-push log the results, json lists the board rows. Used by the /board command.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['rows', 'apply', 'record-apply', 'record-push', 'json'] },
            titles: { type: 'string', description: 'rows: path of the saved list_sessions result (or its JSON)' },
            versions: { type: 'string', description: 'rows: path of a {"sessions/<sid>": n} file or of the folder ArtifactData list wrote with out_dir' },
            pending: { type: 'number', description: 'rows: approved decisions waiting (default: counted from the local ledger)' },
            decisions: { type: 'string', description: 'apply: path of the merged decisions JSON' },
            settings: { type: 'string', description: 'apply: path of the settings/requested JSON' },
            live: { type: 'string', description: 'apply: path of the saved list_sessions result (live models)' },
            self: { type: 'string', description: 'apply: this session id (transcript file name)' },
            results: { type: 'string', description: 'record-apply: path of the [{pid, ok, reason?}] JSON' },
            tokens: { type: 'number', description: 'record-push: tokens this push cost' },
            rows: { type: 'number', description: 'record-push: rows pushed' },
          },
          required: ['mode'],
        },
      });
    } catch {
      /* name taken or the engine has no tool.register */
    }
    try {
      await $.command.register({ name: 'ts-advisor', description: 'Usage Advisor: find the settings that cost the most and what to change (read-only, no LLM; to apply, use /token-stamina:advisor)', argumentHint: '[--json] [--days N] [--brief]' });
    } catch {
      /* name taken */
    }
    // The advisor tool (mcp__token-stamina__advisor), served by the tool.call hook below; /token-stamina:advisor calls it.
    try {
      await $.tool.register({
        name: 'advisor',
        isDeferred: true, // only /token-stamina:advisor and setup use it
        description: 'Token Stamina Usage Advisor: analyze / recommend / review / check / reject are read-only (reject only remembers a refusal); plan returns a planId (valid 10 minutes) and a before -> after preview and writes nothing but the plan; apply takes only that planId and ids that were in it; revert undoes an apply when the current value still equals what apply wrote.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['analyze', 'recommend', 'plan', 'apply', 'revert', 'reject', 'review', 'check'] },
            days: { type: 'number', description: 'analyze/recommend/plan: look-back days' },
            brief: { type: 'boolean' },
            json: { type: 'boolean' },
            first: { type: 'boolean', description: 'analyze: the first-step screen of setup' },
            ids: { type: 'array', items: { type: 'string' }, description: 'plan: recommendation ids (R1, R2 ...); apply: the ids of the plan the person said yes to' },
            planId: { type: 'string', description: 'apply: the planId plan returned' },
            id: { type: 'string', description: 'revert/check: an apply id' },
            last: { type: 'boolean', description: 'revert: the most recent apply' },
            rule: { type: 'string', description: 'reject: the rule id (R1 ...)' },
            force: { type: 'boolean', description: 'check: judge again' },
          },
          required: ['mode'],
        },
      });
    } catch {
      /* name taken or the engine has no tool.register */
    }
    return next(e);
  }).catch(($, e, next) => next(e));

  on('tool.call', { tool: 'mcp__token-stamina__advisor' }, ($, e) => advisorTool($, e));
  on('tool.call', { tool: 'mcp__token-stamina__board' }, ($, e) => boardTool($, e));

  on('command.run', { command: 'ts-fleet' }, ($, e) => answer('ts-fleet', () => fleetCommand($, e.args)));
  on('command.run', { command: 'ts-savings' }, ($, e) => answer('ts-savings', () => savingsCommand($, e.args)));
  on('command.run', { command: 'ts-report' }, ($, e) => answer('ts-report', () => reportCommand($, e.args)));
  on('command.run', { command: 'ts-audit' }, ($, e) => answer('ts-audit', () => auditCommand($, e.args)));
  on('command.run', { command: 'ts-recall' }, async ($, e) => {
    let surface: string | undefined;
    try {
      const all = await $.session.surfaces();
      surface = all.includes('terminal') ? 'terminal' : all[0];
    } catch {
      surface = undefined;
    }
    await recallRun($, String(e.args || ''), surface);
    return {};
  });
  on('command.run', { command: 'ts-advisor' }, ($, e) => answer('ts-advisor', () => advisorCommand($, e.args)));
};
