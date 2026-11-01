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
//   tool.call Agent / mcp__ccd_session__start_session   agent-model.js
//   every hook above          statusline.js, as $.ui.status from $.session.usage()
//   command.run fleet / savings / report / audit   scripts/{fleet,savings,report,audit}.js, answered as { text }
//                             (registered in session.start; setup and autocompact are mod/commands/*.md)
// Not ported here (stage 2 or no longer needed): first-run/setup-nudge (the status line needs no
// setup in a mod), board.js, the desktop usage-sync hint, note pruning ($.fs has no delete).

import type { Register, EngineInterface } from 'claude-code';

import { resolveLang, withLang, type LangBook } from './core/lang.ts';
import { decide as nudgeDecide, type NudgeCfg } from './core/nudge.ts';
import {
  decide as agentModelDecide,
  attributed,
  adaptSession,
  definitionPaths,
  recordLedger,
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
import { shouldSkipHook, type PaceState } from './core/pacer.ts';
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
import { parseTailLines, analyze as boundaryAnalyze, decide as boundaryDecide, message as boundaryMessage } from './core/boundary.ts';
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
  decidePrompt,
  clearContext,
  pickClearNote,
  pendingClearName,
  recentLog,
} from './core/handoff.ts';
import { computeProfile, cacheIsFresh, firstCallTokensFromText, type ProfileResult } from './core/clear-savings.ts';
import { segment as statuslineSegment, legacyStatusNotice } from './core/statusline.ts';
import { joinPath, estimateTokens, encodeCwd } from './core/text.ts';
import { splitArgs, dayAgo, skippedLine, walkJsonl, type CmdIO } from './core/cmd-io.ts';
import { createAgg as reportAgg, render as reportRender, sinceMsOf, defaultWindow as reportDefaultWindow, defaultWindowNote as reportWindowNote, DEFAULT_REPORT_DAYS } from './core/report.ts';
import { compute as savingsCompute, renderText as savingsRender, parseArgs as savingsArgs } from './core/savings.ts';
import { buildReport as auditBuild, render as auditRender, parseArgs as auditArgs } from './core/audit.ts';

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

// events.jsonl, one JSON line per event with `v: 5` (PLAN §2). $.fs has no append, so the file is
// read and written whole; writes from this module are chained so two hooks never interleave. A
// file that exists but cannot be read (over 4 MiB) is never overwritten: the line goes to
// events-mod.jsonl instead. Past 3 MiB the log is moved aside to events-<time>.jsonl.
const ROTATE_AT = 3 * 1024 * 1024;
let eventChain: Promise<void> = Promise.resolve();
function appendEvent($: $T, env: Env, ev: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify(Object.assign({ v: 5, ts: new Date().toISOString() }, ev)) + '\n';
  eventChain = eventChain.then(async () => {
    try {
      let file = joinPath(env.home, 'events.jsonl');
      let prev = '';
      if (await $.fs.exists(file)) {
        const t = await readText($, file);
        if (t == null) {
          file = joinPath(env.home, 'events-mod.jsonl');
          prev = (await readText($, file)) || '';
        } else prev = t;
      }
      if (prev.length > ROTATE_AT) {
        await $.fs.write(file.replace(/\.jsonl$/, '-' + Date.now() + '.jsonl'), prev);
        prev = '';
      }
      await $.fs.write(file, prev + line);
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
  const c = await readJson<Cfg | null>($, joinPath(env.home, 'config.json'), {});
  return c && typeof c === 'object' ? c : {};
}

async function loadConfig($: $T, env: Env): Promise<{ cfg: Cfg; user: Cfg }> {
  const def = await readJson<Cfg>($, joinPath($.plugin.root, 'config.default.json'), {});
  const user = await loadUserConfigRaw($, env);
  return { cfg: Object.assign({}, def, user), user };
}

async function withLangFrom($: $T, env: Env, cfg: Cfg, prompt: string | null, sid: string | undefined, nowMs: number): Promise<Cfg> {
  const bookFile = joinPath(env.home, 'lang.json');
  const book = await readJson<LangBook>($, bookFile, {});
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
    const rows = msgs.map((m: any) => ({ type: m.role, isSidechain: false, message: { role: m.role, content: m.content } }));
    return { raw: null, bytes: null, fallback: rows };
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

interface Usage { state: PaceState; tokens: number; window: number | null }

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
  const prev = await readJson<Record<string, any>>($, stateFile, {});
  let state: PaceState = prev && typeof prev === 'object' ? (prev as PaceState) : {};
  if (Object.keys(fresh).length) {
    state = Object.assign({}, prev, fresh, { recorded_at: nowSec, source: 'mod' }) as PaceState;
    await writeJson($, stateFile, state);
  }
  const ctx = u && u.context;
  return { state, tokens: num(ctx && ctx.tokens) || 0, window: num(ctx && ctx.window) };
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
  const cache = await readJson<{ ts: number; threshold: number | null } | null>($, joinPath(env.home, 'compact-point.json'), null);
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
function trimBook(book: Record<string, { ts: number }>, max = 50): void {
  const keys = Object.keys(book);
  if (keys.length <= max) return;
  keys
    .sort((x, y) => (book[x]?.ts ?? 0) - (book[y]?.ts ?? 0))
    .slice(0, keys.length - max)
    .forEach((k) => delete book[k]);
}

// nudge.js::run: one line when the pace grade changes for this session.
async function nudge($: $T, env: Env, cfg: Cfg, state: PaceState, sid: string, event: string, nowMs: number): Promise<string | null> {
  try {
    const file = joinPath(env.home, 'nudge.json');
    const book = await readJson<Record<string, { grade: string; ts: number }>>($, file, {});
    const last = book[sid]?.grade;
    const d = nudgeDecide({ hook_event_name: event }, state, cfg as NudgeCfg, Math.floor(nowMs / 1000), last);
    if (d.grade && d.grade !== last) {
      book[sid] = { grade: d.grade, ts: nowMs };
      trimBook(book);
      await writeJson($, file, book);
    }
    if (!d.text) return null;
    await appendEvent($, env, { event: 'nudge', session: sid, hook: event, grade: d.grade, worst: d.worst });
    return attributed(d.text, cfg.lang, cfg._langAuto);
  } catch {
    return null;
  }
}

// Restore from the desktop-app clear marker (pending-clear-<host>.json), shared by SessionStart and
// UserPromptSubmit. $.fs cannot delete, so a used marker is overwritten with {} (read as absent).
async function restoreMarked($: $T, env: Env, sid: string, nowMs: number, via: string, lang: string): Promise<string | null> {
  try {
    if (!env.host) return null;
    const dir = joinPath(env.home, 'handoff');
    const pf = pendingClearName(dir, env.host);
    const mk = await readJson<any>($, pf, null);
    if (!mk || !mk.from) return null;
    await $.fs.write(pf, '{}'); // consumed on every attempt, as the Node script's unlink
    if (decidePrompt(mk, sid, nowMs) !== 'restore') return null;
    const cf = sessionFileName(dir, mk.from, true);
    const ct = await mtimeOf($, cf);
    const p = pickClearNote(ct === null ? null : await readText($, cf), ct, await readText($, sessionFileName(dir, mk.from)), mk.at);
    if (!p) return null;
    await appendEvent($, env, { event: 'handoff_restore', session: sid, source: via, kind: p.kind, from_session: mk.from });
    await showRecent($, env, mk.from, lang);
    return clearContext(p);
  } catch {
    return null;
  }
}

// After a clear, draw the old session's last turns on screen ($.ui.log is not sent to the model).
async function showRecent($: $T, env: Env, from: string, lang: string): Promise<void> {
  try {
    const acc = await readJson<Accumulated | null>($, joinPath(env.home, 'handoff', `${safeId(from)}.json`), null);
    for (const line of recentLog((acc && acc.recent) || [], lang)) $.ui.log(line);
  } catch {
    /* on-screen replay is best-effort */
  }
}

async function notePair($: $T, autoFile: string, claudeFile: string): Promise<NotePairFetch> {
  const [autoText, claudeText, autoMtimeMs, claudeMtimeMs] = await Promise.all([
    readText($, autoFile),
    readText($, claudeFile),
    mtimeOf($, autoFile),
    mtimeOf($, claudeFile),
  ]);
  return { autoFile, claudeFile, autoText, claudeText, autoMtimeMs, claudeMtimeMs };
}

// Where the main transcript of each session lives, learned from the classic events; tool.call
// carries no transcript_path. Module state: a reload loses it until the next classic event.
const transcripts = new Map<string, string>();
function remember(e: { session_id?: string; transcript_path?: string }): void {
  if (e.session_id && e.transcript_path) transcripts.set(e.session_id, e.transcript_path);
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

  if (e.source === 'startup') await legacyStatusOnce($, env, cfg.lang || 'en', nowMs);

  if (cfg.handoff !== false && (e.source === 'startup' || e.source === 'clear')) {
    const r = await restoreMarked($, env, safeId(sid), nowMs, 'clear_start', cfg.lang || 'en');
    if (r) return [...out, r]; // handoff.js answered alone (the nudge line already recorded stays)
  }

  if (cfg.handoff !== false && (e.source === 'compact' || e.source === 'clear')) {
    try {
      const dir = joinPath(env.home, 'handoff');
      const sidS = safeId(sid);
      const own = await notePair($, sessionFileName(dir, sidS), sessionFileName(dir, sidS, true));
      const latest = await notePair($, latestFileName(dir, e.cwd), latestFileName(dir, e.cwd, true));
      const fromSide = await readText($, latestFileName(dir, e.cwd, true) + '.from');
      const p = pickFromData(sidS, e.source, own, latest, fromSide ? fromSide.trim() : null, nowMs);
      if (p) {
        await appendEvent($, env, {
          event: 'handoff_restore',
          session: sid,
          source: e.source,
          kind: p.kind,
          fallback: p.fallback,
          from_session: e.source === 'clear' ? p.from || null : undefined,
        });
        const ctx = handoffAdditionalContext(p);
        if (ctx) out.push(ctx);
        if (e.source === 'clear' && p.from) await showRecent($, env, p.from, cfg.lang || 'en');
      }
    } catch {
      /* restore is best-effort */
    }
  }
  return out;
}

// ============================================================================
// classic.UserPromptSubmit
// ============================================================================

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
  const app = isDesktopApp({ CLAUDE_CODE_ENTRYPOINT: env.entrypoint });

  // --- topic-gate.js::run ---
  if (e.transcript_path) {
    try {
      const t = await readTranscript($, e.transcript_path);
      const entries = tail(t, BOUNDARY_TAIL_BYTES);
      // PLAN §3: the context size comes from $.session.usage(); the transcript's last usage
      // row (what the Node script read) only when the engine has no reading yet.
      const tokens = usage.tokens || boundaryAnalyze(entries).tokens;
      const file = joinPath(env.home, 'topic-gate.json');
      const book = await readJson<Record<string, any>>($, file, {});
      const rec = book[sid];
      const noteFile = sessionFileName(joinPath(env.home, 'handoff'), safeId(sid), true);
      const h = decideHint(tokens, cfg as TopicGateCfg, user, rec && rec.hintAt);
      // no timestamps in a transcript rebuilt from $.session.messages: the last Stop time stands in
      const stopAt = t.raw == null ? (await readJson<Accumulated>($, joinPath(env.home, 'handoff', `${safeId(sid)}.json`), {} as Accumulated)).stopAt : undefined;
      const d = topicGateDecide({ tokens, lastAssistantMs: lastActiveMs(entries, stopAt, rec && rec.promptAt), nowMs, cwd: e.cwd }, cfg as TopicGateCfg, user, rec);
      let offeredAt = rec && rec.offeredAt;
      if (typeof offeredAt === 'number' && tokens < offeredAt) offeredAt = null;
      if (typeof offeredAt !== 'number' && clearOffered(entries)) offeredAt = tokens;
      const checkedAt = rec && rec.checkedAt;
      const tc = d.gate || h.hint ? { check: false, offeredAt, checkedAt } : decideTopicCheck(tokens, cfg as TopicGateCfg, user, offeredAt, checkedAt);
      book[sid] = {
        cwd: e.cwd || (rec && rec.cwd),
        gatedAt: d.gate ? tokens : rec && rec.gatedAt,
        hintAt: h.hintAt,
        offeredAt: typeof tc.offeredAt === 'number' ? tc.offeredAt : null,
        checkedAt: typeof tc.checkedAt === 'number' ? tc.checkedAt : null,
        ...promptStamps(e.prompt, rec, nowMs),
        ts: nowMs,
      };
      trimBook(book);
      await writeJson($, file, book);

      const lines: string[] = [];
      if (d.gate) {
        await appendEvent($, env, { event: 'topic_gate', session: sid, tokens, idle_sec: Math.round(d.idleSec ?? 0), cwd_changed: d.cwdChanged });
        lines.push(topicGateMessage(cfg.lang || 'en', tokens, d.idleSec ?? 0, !!d.cwdChanged, noteFile, app));
      }
      if (h.hint) {
        await appendEvent($, env, { event: 'inline_hint', session: sid, tokens });
        const prof = await buildProfile($, env, cfg, entries, t.raw);
        lines.push(hintMessage(cfg.lang || 'en', tokens, noteFile, cfg as TopicGateCfg, prof as any, app));
      }
      if (tc.check) {
        const line = topicCheckMessage(cfg.lang || 'en', tokens, noteFile, app);
        await appendEvent($, env, { event: 'topic_check', session: sid, tokens, line_tokens: estimateTokens(attributed(line, cfg.lang || 'en', cfg._langAuto)) });
        lines.push(line);
      }
      if (lines.length) out.push(attributed(lines.join(' '), cfg.lang || 'en', cfg._langAuto));
    } catch {
      /* topic-gate is best-effort */
    }
  }

  // --- handoff.js::runPrompt: the first prompt after the desktop app's clear_session ---
  if (cfg.handoff !== false) {
    const r = await restoreMarked($, env, safeId(sid), nowMs, 'clear_prompt', cfg.lang || 'en');
    if (r) out.push(r);
  }

  const n = await nudge($, env, cfg, usage.state, sid, 'UserPromptSubmit', nowMs);
  if (n) out.push(n);
  return out;
}

// ============================================================================
// classic.Stop: boundary.js (a notice the person sees; the model never reads it) + handoff save.
// ============================================================================

async function onStop($: $T, e: any): Promise<void> {
  remember(e);
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
    const book = await readJson<Record<string, { tokens: number; ts: number }>>($, file, {});
    const d = boundaryDecide(res, cfg as any, user, book[sid]?.tokens);
    if (d.notify) {
      book[sid] = { tokens: res.tokens, ts: nowMs };
      trimBook(book);
      await writeJson($, file, book);
      await appendEvent($, env, { event: 'boundary', session: sid, tokens: res.tokens, kind: (d as any).kind, level: (d as any).level, commits: res.commitCount });
      const prof = await buildProfile($, env, cfg, entries, t.raw);
      const text = boundaryMessage(res, cfg.lang || 'en', (d as any).level, cfg as any, prof as any);
      await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } });
    }
  } catch {
    /* boundary is best-effort */
  }

  // --- handoff.js::runStop ---
  if (cfg.handoff !== false) {
    try {
      const dir = joinPath(env.home, 'handoff');
      const entries = tail(t, HANDOFF_TAIL_BYTES);
      const sideFile = joinPath(dir, `${sid}.json`);
      const prevAcc = await readJson<Accumulated>($, sideFile, { commits: [], files: [] });
      const fromFallback = t.raw == null;
      let sc = handoffScan(entries);
      if (fromFallback) {
        // no timestamps in the rows: the prompt times topic-gate.json recorded stand in (read only)
        const book = await readJson<Record<string, any>>($, joinPath(env.home, 'topic-gate.json'), {});
        sc = fallbackPromptTs(sc, book[e.session_id || 'unknown'], prevAcc, nowMs);
      }
      const acc = accumulate(prevAcc, sc);
      if (fromFallback) acc.stopAt = nowMs; // the idle-gap stand-in of the next prompt (topic-gate)
      const cleared = !!env.host && clearedSelf(entries, env.host);
      acc.recent = nextRecent(prevAcc.recent, entries, cleared, cfg.clearRecentTurns ?? 3, fromFallback);
      await writeJson($, sideFile, acc);
      const md = renderCapped(buildMeta(sid, e.cwd, nowMs, sc, acc), cfg.handoffMaxTokens || 1500);
      await writeText($, sessionFileName(dir, sid), md);
      await writeText($, latestFileName(dir, e.cwd), md);
      // A Claude-written note newer than the cwd's latest one becomes the latest, with its session.
      const cf = sessionFileName(dir, sid, true);
      const ct = await mtimeOf($, cf);
      const lcf = latestFileName(dir, e.cwd, true);
      if (ct !== null && ((await mtimeOf($, lcf)) || 0) < ct) {
        const text = await readText($, cf);
        if (text != null) {
          await writeText($, lcf, text);
          await writeText($, lcf + '.from', sid);
        }
      }
      // Desktop-app clear_session that went through: leave a marker for the new session.
      if (cleared) await writeJson($, pendingClearName(dir, env.host), { from: sid, host: env.host, cwd: e.cwd, at: nowMs });
    } catch {
      /* handoff save is best-effort */
    }
  }
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
  let cfg: Cfg = cfgL;
  let dIn: AgentModelInput = input;
  let d: AgentDecision | null = null;
  if (kind === 'start_session') {
    if (cfgL.sessionModelHook === false) return next(e);
    const ad = adaptSession(input, cfgL);
    if (ad.pass) d = { action: 'pass', reason: ad.pass };
    else if (ad.input) dIn = ad.input;
    if (cfgL.sessionModelInject === false) {
      cfg = Object.assign({}, cfgL, { mode: cfgL.mode === 'off' ? 'off' : 'suggest' });
      const xd = cfgL.explicitDowngrade;
      if (!(xd === undefined || xd === null || xd === false || xd === 'off')) cfg.explicitDowngrade = 'suggest';
    }
  }
  let fl: Awaited<ReturnType<typeof fleetSnapshot>> = null;
  if (!d) {
    const usage = await readUsage($, env, nowMs);
    fl = await fleetSnapshot($, env, transcripts.get(sessionId), cfg, now);
    const ledger = await readJson<any>($, joinPath(env.home, LEDGER), null);
    const st = (dIn.tool_input || {}).subagent_type;
    const defs = new Map<string, string | null>();
    for (const p of definitionPaths(st, cwd, env.userHome)) defs.set(p, await readText($, p));
    d = agentModelDecide(dIn, usage.state, cfg as AgentModelCfg, now, {
      fleet: fl,
      ledger,
      homeDir: env.userHome,
      readText: (p) => defs.get(p) ?? null,
    });
  }
  if (d.message) d.message = attributed(d.message, cfg.lang, cfg._langAuto);
  if ((d.reason === 'explicit_downgrade' || d.reason === 'explicit_suggest') && d.desc_hash && sessionId) {
    const file = joinPath(env.home, LEDGER);
    await writeJson($, file, recordLedger(await readJson<any>($, file, null), sessionId, kind === 'start_session' ? 'session' : 'agent', d.desc_hash, d.requested_model || null, now));
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
  // PreToolUse's updatedInput is the rewrite passed to next; its additionalContext is read by the
  // model after the result here (a tool.call answer's `context`), never instead of the result.
  const ran = await next(d.action === 'inject' && d.model ? { ...e, model: d.model } : e);
  if (!d.message || !ran || ran.deny !== undefined) return ran;
  return { ...ran, context: [...(ran.context || []), d.message] };
}

// ============================================================================
// Slash commands (command.run answers { text }, no model): fleet, savings, report, audit.
// The logic is in core/{fleet,savings,report,audit}.ts; this is the file and settings access.
// ============================================================================

// CmdIO over $.fs. A file over 4 MiB rejects on read: it is counted (skipped) and reads as missing.
function cmdIO($: $T): CmdIO {
  let skipped = 0;
  return {
    async read(p) {
      try {
        return await $.fs.read(p);
      } catch {
        try {
          if (await $.fs.exists(p)) skipped++;
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
  return skipped ? body + '\n\n' + skipped : body;
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
// Wiring.
// ============================================================================

export const register: Register = (on) => {
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

  on('tool.call', { tool: 'Agent' }, ($, e, next) => agentModel($, e, next)).catch(($, e, next) => next(e));
  on('tool.call', { tool: 'mcp__ccd_session__start_session' }, ($, e, next) => agentModel($, e, next)).catch(($, e, next) => next(e));

  // The four commands that only print a table. Each is registered by a literal name (the validator
  // reads the names off the source) and in its own try, so one refused name leaves the others. The
  // run hooks answer their own command: they never read `next`.
  on('session.start', async ($, e, next) => {
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
      await $.command.register({ name: 'ts-audit', description: 'Audit fixed token costs: always-loaded files, plugins, MCP/skill usage, turn-off candidates (changes nothing)', argumentHint: '[--cwd <path>] [--days 30] [--json]' });
    } catch {
      /* name taken */
    }
    return next(e);
  }).catch(($, e, next) => next(e));

  on('command.run', { command: 'ts-fleet' }, ($, e) => answer('ts-fleet', () => fleetCommand($, e.args)));
  on('command.run', { command: 'ts-savings' }, ($, e) => answer('ts-savings', () => savingsCommand($, e.args)));
  on('command.run', { command: 'ts-report' }, ($, e) => answer('ts-report', () => reportCommand($, e.args)));
  on('command.run', { command: 'ts-audit' }, ($, e) => answer('ts-audit', () => auditCommand($, e.args)));
};
