// hooks/register.ts — mods entry point. Wires events to the pure logic in hooks/core/*.ts.
//
// ============================================================================
// READ THIS FIRST — what is PLAN-confirmed vs. guessed in this file
// ============================================================================
// This PC's terminal CLI (2.1.201) rejected a modules-only hooks.json ("hooks: expected
// record"). CLI 2.1.309 runs the hooks.json command records; whether any runtime here
// runs this module is unverified, and `claude plugin validate` rejects this file's
// node: imports (HEAD too) — so NOTHING in this file has been run by a real mods runtime. The only source of truth available on this PC is the prose
// in PLAN-0.5-mods.md (no network, no SDK type defs, no node_modules anywhere in the
// repo). That document confirms, verbatim:
//
//   CONFIRMED (§1, §3):
//   - `import './lib'`-style relative imports between mod files work.
//   - `classic.SessionStart` / `classic.UserPromptSubmit` / `classic.Stop` exist and
//     receive hooks whose *payload and output shape* match the old classic-hook JSON
//     (same field names as scripts/*.js's `JSON.parse(raw)` input, same
//     `{hookSpecificOutput:{hookEventName, additionalContext, ...}}` / `{systemMessage}`
//     output shape). What is NOT confirmed is *how a handler is registered* against
//     `classic.X` (is it a call like `classic.SessionStart(fn)`? a namespace object
//     passed into an exported `activate()`? something else?) — PLAN only says these
//     names "exist", not the registration syntax.
//   - `tool.call {tool:'Agent'} -> next({...e, model})` is the pattern for the old
//     PreToolUse(matcher Agent) replacement. The exact registration call
//     (`tool.call({tool:'Agent'}, handler)`? a filter object?) is NOT given verbatim.
//   - `$.session.usage()` exposes `.rateLimits` and `.context` (top-level names only —
//     sub-field names of each are NOT given).
//   - `$.ui.status` is the status-line display surface; PLAN §7 explicitly lists "does
//     it render in the desktop app" as unknown, i.e. UNVERIFIED by design.
//   - `$.fs.read`: whole-file only, 4 MiB cap, no partial/offset reads. `$.fs.write` is
//     not mentioned in PLAN at all — inferred to exist by symmetry, unconfirmed.
//   - events.jsonl keeps its format; each new line gets a `v: 5` field to separate it
//     from 0.4 records (§2).
//
//   NOT CONFIRMED ANYWHERE (flagged inline below, each with its own comment):
//   - The literal registration syntax for `classic.*` and `tool.call` (guessed below as
//     a plain function call on a global namespace object — see "WIRING" section at the
//     bottom of this file). This is the single biggest unknown in this entire port.
//   - Sub-field names of `$.session.usage().rateLimits` / `.context` (guessed with a
//     defensive multi-shape adapter, `usageToPaceState`/`usageContextTokens` below).
//   - Whether `$.ui.status` is a settable property, a `.set()` method, or a callable.
//   - Whether `node:fs`/`node:os`/`node:path` are reachable at all from inside a mods
//     hook sandbox (vs. only `$.fs`). Kept as the primary code path here (same choice
//     already made in hooks/core/agent-model.ts and hooks/core/setup-nudge.ts, for
//     local Node-native verification on this PC), with a `$.fs` fallback attempt.
//   - Whether `$.fs` (or node:fs) can list a directory (`readdir`). Needed for
//     handoff's note-pruning and clear-savings's cross-session history scan. Both are
//     treated as stage-1 simplifications below (pruning best-effort via node:fs,
//     history scan skipped entirely — see comments at each call site).
//
// Everything that is a *decision* (what text to show, when to fire, what to persist)
// lives in hooks/core/*.ts and is unit-testable right now with plain Node. Everything
// below this line is *wiring*: fetch inputs the mods way (or the best available
// approximation), call the pure function, persist/emit the result the mods way.
// Every block that touches an unconfirmed API is wrapped in try/catch so a wrong
// guess degrades to a silent no-op instead of breaking the hook chain (matches the
// "never block the user" invariant every original scripts/*.js already had).

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync, cpSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLang, withLang, type LangBook } from './core/lang.ts';
import { laneOrAll } from './core/lane.ts';
import { decide as nudgeDecide, type NudgeCfg } from './core/nudge.ts';
import { decide as agentModelDecide, attributed, type AgentModelCfg } from './core/agent-model.ts';
import { sessionDir as fleetSessionDir, scanEntries as fleetScanEntries, pressure as fleetPressure, type FleetEntry } from './core/fleet.ts';
import { shouldSkipHook, type PaceState } from './core/pacer.ts';
import {
  decide as topicGateDecide,
  decideHint,
  decideTopicCheck,
  isDesktopApp,
  message as topicGateMessage,
  hintMessage,
  topicCheckMessage,
  lastAssistantTs,
  clearOffered,
  type TopicGateCfg,
} from './core/topic-gate.ts';
import { parseTailLines, analyze as boundaryAnalyze, decide as boundaryDecide, message as boundaryMessage } from './core/boundary.ts';
import {
  scan as handoffScan,
  renderCapped,
  accumulate,
  buildMeta,
  pickFromData,
  additionalContext as handoffAdditionalContext,
  safeId,
  sessionFileName,
  latestFileName,
  type Accumulated,
  type NotePairFetch,
  KEEP_SEC,
  TAIL_BYTES as HANDOFF_TAIL_BYTES,
} from './core/handoff.ts';
import { classifyText, message as setupNudgeMessage, decide as setupNudgeDecide } from './core/setup-nudge.ts';
import { computeProfile, cacheIsFresh, firstCallTokensFromText, type ComputeProfileInput, type ProfileResult } from './core/clear-savings.ts';
import { segment as statuslineSegment } from './core/statusline.ts';

// ============================================================================
// Shared I/O helpers — replicate scripts/pace.js's contract (home dir, config
// merge, atomic JSON read/write, event append) without pace.js itself (it is
// not ported; register.ts is the only caller of this logic under mods).
// ============================================================================

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url)); // .../hooks
const PLUGIN_ROOT = join(HOOKS_DIR, '..');

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

// Mirrors scripts/pace.js::home() exactly, including the one-time 0.4-name migration.
function home(): string {
  const envHome = process.env.TOKEN_STAMINA_HOME || process.env.TOKEN_PACER_HOME;
  if (envHome) return envHome;
  const dir = join(homedir(), '.claude', 'token-stamina');
  try {
    if (!existsSync(dir)) {
      const old = join(homedir(), '.claude', 'token-pacer');
      if (existsSync(old)) {
        mkdirSync(dir, { recursive: true });
        cpSync(old, dir, { recursive: true });
      }
    }
  } catch (e) {
    /* best-effort migration, never block */
  }
  return dir;
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (e) {
    return fallback;
  }
}

// Atomic write, mirrors scripts/pace.js::writeJson (tmp file + rename).
function writeJsonFile(file: string, obj: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, file);
  } catch (e) {
    /* best-effort, never block */
  }
}

// Mirrors scripts/pace.js::appendEvent, plus the PLAN §2 `v: 5` line marker that
// distinguishes 0.5/mods records from 0.4/Node records in the same events.jsonl.
function appendEvent(ev: Record<string, unknown>): void {
  try {
    const dir = home();
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(Object.assign({ v: 5, ts: new Date().toISOString() }, ev)) + '\n';
    appendFileSync(join(dir, 'events.jsonl'), line);
  } catch (e) {
    /* best-effort, never block */
  }
}

// Raw (not merged-with-defaults) user config.json content. Several core/*.ts functions
// (pacer.ts's `thresholds`, and everything built on it: boundary.ts's `decide`,
// topic-gate.ts's `decide`/`decideHint`/`decideTopicCheck`, statusline.ts's `segment`)
// deliberately take this as a separate `user` argument instead of the merged `cfg` --
// see pacer.ts's header comment for why that split exists. Kept as its own function
// (rather than folded into loadConfig) so every call site that needs `user` reads the
// same small file instead of loadConfig threading two return values around.
function loadUserConfigRaw(): Record<string, any> {
  return readJsonFile<Record<string, any>>(join(home(), 'config.json'), {});
}

// Mirrors scripts/pace.js::loadConfig (config.default.json bundled with the plugin,
// merged with the user's override file in home()).
function loadConfig(): Record<string, any> {
  let def: Record<string, any> = {};
  try {
    def = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config.default.json'), 'utf8'));
  } catch (e) {
    /* missing/unreadable default config -> treat as empty, never block */
  }
  return Object.assign({}, def, loadUserConfigRaw());
}

// Replicates the ORIGINAL (impure) scripts/lang.js::withLang(cfg, input) contract --
// read lang.json, resolve, write back if changed, merge the resolved lang into cfg --
// using the deliberately-split pure core (resolveLang + withLang) in hooks/core/lang.ts.
// See that file's header: the split is intentional, this is just the glue the original
// did inline that core/lang.ts no longer does.
function withLangFromInput(cfg: Record<string, any>, prompt: string | null | undefined, sid: string | undefined, nowMs: number): Record<string, any> {
  const bookFile = join(home(), 'lang.json');
  const book = readJsonFile<LangBook>(bookFile, {});
  const r = resolveLang(cfg as any, prompt ?? null, sid, book, nowMs);
  if (r.nextBook) writeJsonFile(bookFile, r.nextBook);
  return withLang(cfg, r.lang);
}

// ============================================================================
// Transcript access. $.fs.read (PLAN-confirmed) has NO partial/offset read and a
// 4 MiB cap -- so "read the tail of a huge file cheaply" (what scripts/boundary.js's
// readTail / scripts/handoff.js's readText did via fs.openSync+fs.readSync at a byte
// offset) is NOT available the mods way for files over 4 MiB. The approach here:
// read the WHOLE file (capped at 4 MiB in practice, same cap $.fs would impose), then
// take the tail of the in-memory buffer with the already-pure `parseTailLines`
// (hooks/core/boundary.ts) that was designed to take a Buffer, not a file handle --
// exactly so this adaptation would be a one-line call, not a rewrite. Files bigger
// than the cap fail closed (treated as "no transcript data", never throws upward).
// ============================================================================

function readWholeFileSafe(path: string | undefined | null): string | null {
  if (!path) return null;
  // Primary path: node:fs, consistent with the same unconfirmed-but-best-effort choice
  // already made in core/agent-model.ts and core/setup-nudge.ts (local verification on
  // this PC needs it; whether the mods sandbox permits it on desktop is unconfirmed).
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    // Fallback: the PLAN-confirmed `$.fs.read` name, unconfirmed exact call signature
    // (sync? async? throws on >4MiB, or returns null/undefined?). `$` is the mods
    // global injected by the runtime; no type defs exist anywhere on this PC.
    try {
      // @ts-ignore -- mods global, not declared anywhere on this PC
      const g: any = typeof globalThis !== 'undefined' ? (globalThis as any).$ : undefined;
      if (g && g.fs && typeof g.fs.read === 'function') return g.fs.read(path);
    } catch (e2) {
      /* give up, never block */
    }
    return null;
  }
}

function tailEntries(transcriptPath: string | undefined, bytes: number): any[] {
  const raw = readWholeFileSafe(transcriptPath);
  if (raw == null) return [];
  try {
    return parseTailLines(Buffer.from(raw, 'utf8'), bytes);
  } catch (e) {
    return [];
  }
}

// ============================================================================
// $.session.usage() adapter. UNCONFIRMED SHAPE -- see file header. Tries several
// plausible field-name spellings (camelCase mod-style and snake_case classic-hook
// style) defensively; returns a PaceState-shaped object (hooks/core/pacer.ts) that
// every decide()/assess() call in this file consumes identically regardless of
// which guess matched. This is the ONLY place that needs correcting if the real
// shape turns out different after one logged desktop run of
// `console.log(JSON.stringify($.session.usage()))`.
// ============================================================================

function safeUsage(): any {
  try {
    // @ts-ignore -- mods global, not declared anywhere on this PC
    const g: any = typeof globalThis !== 'undefined' ? (globalThis as any).$ : undefined;
    return g && g.session && typeof g.session.usage === 'function' ? g.session.usage() : null;
  } catch (e) {
    return null;
  }
}

function usageToPaceState(usage: any, nowMs: number): PaceState {
  const state: Record<string, unknown> = {};
  try {
    const rl = (usage && (usage.rateLimits || usage.rate_limits)) || {};
    const d7 = rl.sevenDay ?? rl.seven_day ?? rl.weekly ?? null;
    const h5 = rl.fiveHour ?? rl.five_hour ?? null;
    if (d7) {
      const pct = num(d7.usedPercentage ?? d7.used_percentage ?? d7.pct);
      const resets = num(d7.resetsAt ?? d7.resets_at ?? d7.reset_at);
      if (pct != null && resets != null) state.seven_day = { pct, resets_at: resets };
    }
    if (h5) {
      const pct = num(h5.usedPercentage ?? h5.used_percentage ?? h5.pct);
      const resets = num(h5.resetsAt ?? h5.resets_at ?? h5.reset_at);
      if (pct != null && resets != null) state.five_hour = { pct, resets_at: resets };
    }
  } catch (e) {
    /* malformed/absent usage -> empty state, assess() already handles that gracefully */
  }
  state.recorded_at = nowMs;
  return state as PaceState;
}

function usageContextTokens(usage: any): number {
  try {
    const ctx = usage && (usage.context ?? usage.context_window ?? usage.contextWindow);
    if (ctx == null) return 0;
    if (typeof ctx === 'number') return ctx;
    const cu = ctx.current_usage || ctx.currentUsage;
    if (cu) {
      const n = (cu.input_tokens ?? cu.inputTokens ?? 0) + (cu.cache_read_input_tokens ?? cu.cacheReadInputTokens ?? 0) + (cu.cache_creation_input_tokens ?? cu.cacheCreationInputTokens ?? 0);
      if (n > 0) return n;
    }
    return num(ctx.totalInputTokens ?? ctx.total_input_tokens) || 0;
  } catch (e) {
    return 0;
  }
}

// ============================================================================
// $.ui.status adapter. UNCONFIRMED -- PLAN §7 lists "does it render on desktop" as an
// open question, and the exact call shape (settable property? `.set()`? callable?) is
// not given at all. Tries three plausible shapes; no-ops silently if none work.
// register.ts calls this opportunistically from every handler below that has fresh
// usage data, since there is no dedicated "redraw the status line" event confirmed.
// ============================================================================

function tryUpdateStatusLine(text: string): void {
  if (!text) return;
  try {
    // @ts-ignore -- mods global, not declared anywhere on this PC
    const g: any = typeof globalThis !== 'undefined' ? (globalThis as any).$ : undefined;
    const ui = g && g.ui;
    if (!ui || !ui.status) return;
    if (typeof ui.status.set === 'function') { ui.status.set(text); return; }
    if (typeof ui.status === 'function') { ui.status(text); return; }
    ui.status = text;
  } catch (e) {
    /* desktop-only, unverified -- never block on this */
  }
}

// ============================================================================
// clear-savings profile (for boundary's/topic-gate's "(estimate) ... saved" suffix).
// STAGE-1 SIMPLIFICATION (reaffirmed in the pre-compaction summary): the
// cross-session history scan (scripts/clear-savings.js's historyThreshold, which
// lists up to 40 recent transcripts across ~/.claude/projects) needs directory
// listing that is unconfirmed under $.fs and is skipped here -- only the lightweight
// single-file cache (`compact-point.json`, already written by a *previous* history
// scan under 0.4) is consulted, and only if still fresh. `prof.fixed`/`prof.threshold`
// being null just makes hintLine() in core/clear-savings.ts return '' (confirmed
// graceful degradation, see that file's header) -- so this never breaks the surrounding
// message, it just silently omits the cost estimate until stage 2 ports the history
// scan too (PLAN §5 stage 2).
// ============================================================================

function buildProfileInput(cfg: Record<string, any>, entries: any[], rawTranscript: string | null): ComputeProfileInput {
  const cache = readJsonFile<{ ts: number; threshold: number | null } | null>(join(home(), 'compact-point.json'), null);
  const cachedThreshold = cache ? cacheIsFresh(cache, Date.now()) : undefined;
  return {
    cfgFixedTokens: num(cfg.fixedTokens),
    firstCallTokensValue: rawTranscript ? firstCallTokensFromText(rawTranscript) : null,
    cfgCompactAtTokens: num(cfg.compactAtTokens),
    entries,
    envWindow: num(Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)) || null,
    cfgCompactWindowTokens: num(cfg.compactWindowTokens),
    envPct: num(Number(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)) || null,
    historyThresholdValue: cachedThreshold ?? null,
  };
}

// `computeProfile()` turns the raw ComputeProfileInput into the ProfileResult shape
// boundary.ts's `message()` / topic-gate.ts's `hintMessage()` actually expect as their
// `prof` parameter -- passing the raw input object directly (an earlier draft of this
// file did that) silently produces a blank cost-estimate suffix instead of the real one.
function buildProfile(cfg: Record<string, any>, entries: any[], rawTranscript: string | null): ProfileResult {
  return computeProfile(buildProfileInput(cfg, entries, rawTranscript));
}

// ============================================================================
// 50-entry LRU-trim book helper, used identically by nudge/boundary/topic-gate's
// per-session book files (nudge.json / boundary.json / topic-gate.json).
// ============================================================================

function trimBook(book: Record<string, { ts: number }>, max = 50): void {
  const keys = Object.keys(book);
  if (keys.length <= max) return;
  keys
    .sort((x, y) => book[x].ts - book[y].ts)
    .slice(0, keys.length - max)
    .forEach((k) => delete book[k]);
}

// ============================================================================
// classic.Stop — boundary (systemMessage) + handoff save (no output).
// Faithful port of scripts/boundary.js::run + scripts/handoff.js::runStop.
// ============================================================================

// ONE LANE PER FEATURE (W7 #3). hooks.json command records are the lane known to run: the terminal CLI (2.1.309,
// checked) runs them. Whether a runtime also runs this module is not established here (`claude plugin validate`
// rejects this file's node: imports, at HEAD too; see DESIGN-v2-integrated.md "0.5 릴리스 전 남은 일"). Every feature
// that has a command record is skipped here, so on a runtime that runs both lanes nothing fires twice. Read once at
// load. FAIL-CLOSED: if hooks.json cannot be read or parsed, every feature counts as the command lane's (laneOrAll),
// so this module skips them all rather than doubling them.
const LANE: Set<string> = laneOrAll(() => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hooks.json'), 'utf8'));
const inLane = (feature: string) => LANE.has(feature);

export async function onStop(input: any): Promise<any> {
  try {
    if (input && input.hook_event_name && input.hook_event_name !== 'Stop') return null;
    const cfg0 = loadConfig();
    if (shouldSkipHook(process.env.CLAUDE_CODE_ENTRYPOINT, input?.cwd, cfg0.excludeCwd)) return null;
    const nowMs = Date.now();
    const cfg = withLangFromInput(cfg0, null, input?.session_id, nowMs);
    const user = loadUserConfigRaw();
    const sid = safeId(input?.session_id);

    let output: any = null;
    // Single whole-file read, reused below for both boundary's (256KB) and handoff's
    // (512KB) tail windows -- an earlier draft read the transcript twice (once per
    // block), doubling cost against the 4MiB-per-read $.fs cap for no reason.
    const rawTranscript = input?.transcript_path ? readWholeFileSafe(input.transcript_path) : null;

    // --- boundary.js::run -------------------------------------------------
    if (!inLane('Stop:boundary.js') && input?.transcript_path) {
      const entries = rawTranscript ? parseTailLines(Buffer.from(rawTranscript, 'utf8'), 256 * 1024) : [];
      const res = boundaryAnalyze(entries);
      if (!res.endsWithAnswer && typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()) {
        (res as any).endsWithAnswer = true;
      }
      const file = join(home(), 'boundary.json');
      const book = readJsonFile<Record<string, { tokens: number; ts: number }>>(file, {});
      // decide(res, cfg, user, last) -- `user` is the raw user config.json object,
      // required as its own 3rd parameter (see loadUserConfigRaw's header comment).
      const d = boundaryDecide(res, cfg as any, user, book[sid] && book[sid].tokens);
      if (d.notify) {
        book[sid] = { tokens: res.tokens, ts: nowMs };
        trimBook(book);
        writeJsonFile(file, book);
        appendEvent({ event: 'boundary', session: sid, tokens: res.tokens, kind: (d as any).kind, level: (d as any).level, commits: res.commitCount });
        const prof = buildProfile(cfg, entries, rawTranscript);
        const text = boundaryMessage(res, cfg.lang || 'en', (d as any).level, cfg as any, prof as any);
        output = { systemMessage: text };
      }
    }

    // --- handoff.js::runStop (always runs, independent of boundary's notify) ---
    if (!inLane('Stop:handoff.js') && cfg.handoff !== false && input?.transcript_path) {
      try {
        const dir = join(home(), 'handoff');
        mkdirSync(dir, { recursive: true });
        const entries = rawTranscript ? parseTailLines(Buffer.from(rawTranscript, 'utf8'), HANDOFF_TAIL_BYTES) : [];
        const sc = handoffScan(entries);
        const sideFile = join(dir, `${sid}.json`);
        const prevAcc = readJsonFile<Accumulated>(sideFile, { commits: [], files: [] });
        const acc = accumulate(prevAcc, sc);
        writeJsonFile(sideFile, acc);
        const meta = buildMeta(sid, input.cwd, nowMs, sc, acc);
        const md = renderCapped(meta, cfg.handoffMaxTokens || 1500);
        writeFileSync(sessionFileName(dir, sid), md);
        writeFileSync(latestFileName(dir, input.cwd), md);
        // Best-effort prune of old handoff notes (node:fs readdir -- directory listing
        // under $.fs is unconfirmed; this whole block is allowed to fail silently).
        try {
          for (const name of readdirSync(dir)) {
            const f = join(dir, name);
            const st = statSync(f);
            if (nowMs - st.mtimeMs > KEEP_SEC * 1000) unlinkSync(f);
          }
        } catch (e) {
          /* directory listing unavailable or failed -- never block */
        }
      } catch (e) {
        /* handoff save is best-effort, never blocks Stop */
      }
    }

    // --- status line opportunistic refresh --------------------------------
    try {
      const usage = safeUsage();
      const state = usageToPaceState(usage, nowMs);
      tryUpdateStatusLine(statuslineSegmentFromUsage(usage, state, cfg));
    } catch (e) {
      /* desktop-only, never block */
    }

    return output;
  } catch (e) {
    return null; // never block Stop
  }
}

// ============================================================================
// classic.SessionStart — nudge (red repeat) + handoff restore + setup-nudge.
// Faithful port of scripts/nudge.js::run(SessionStart branch) +
// scripts/handoff.js::runStart + scripts/setup-nudge.js::run (not read verbatim
// in this session, but fully specified by hooks/core/setup-nudge.ts's own header
// comment, which this follows).
// ============================================================================

export async function onSessionStart(input: any): Promise<any> {
  try {
    if (input && input.hook_event_name && input.hook_event_name !== 'SessionStart') return null;
    const cfg0 = loadConfig();
    if (shouldSkipHook(process.env.CLAUDE_CODE_ENTRYPOINT, input?.cwd, cfg0.excludeCwd)) return null;
    const nowMs = Date.now();
    const cfg = withLangFromInput(cfg0, null, input?.session_id, nowMs);
    const sid = input?.session_id || 'unknown';
    const lines: string[] = [];

    // --- nudge.js::run (SessionStart branch: only a red repeat, never changes grade silently to non-red) ---
    if (!inLane('SessionStart:nudge.js')) try {
      const nudgeFile = join(home(), 'nudge.json');
      const nudgeBook = readJsonFile<Record<string, { grade: string; ts: number }>>(nudgeFile, {});
      const last = nudgeBook[sid] && nudgeBook[sid].grade;
      const usage = safeUsage();
      const state = usageToPaceState(usage, nowMs);
      const d = nudgeDecide({ hook_event_name: 'SessionStart' }, state, cfg as NudgeCfg, Math.floor(nowMs / 1000), last);
      if (d.grade && d.grade !== last) {
        nudgeBook[sid] = { grade: d.grade, ts: nowMs };
        trimBook(nudgeBook);
        writeJsonFile(nudgeFile, nudgeBook);
      }
      if (d.text) {
        appendEvent({ event: 'nudge', session: sid, hook: 'SessionStart', grade: d.grade, worst: (d as any).worst });
        lines.push(attributed(d.text, cfg.lang, cfg._langAuto));
      }
    } catch (e) {
      /* nudge is best-effort */
    }

    // --- handoff.js::runStart (only on /compact or /clear restore) ---------
    if (!inLane('SessionStart:handoff.js') && cfg.handoff !== false && (input?.source === 'compact' || input?.source === 'clear')) {
      try {
        const dir = join(home(), 'handoff');
        const sidS = safeId(sid);
        const ownFile = sessionFileName(dir, sidS);
        const latestFile = latestFileName(dir, input.cwd);
        const ownClaudeFile = sessionFileName(dir, sidS, true);
        const latestClaudeFile = latestFileName(dir, input.cwd, true);
        const readText = (p: string): string | null => {
          try {
            return readFileSync(p, 'utf8');
          } catch (e) {
            return null;
          }
        };
        const mtimeOf = (p: string): number | null => {
          try {
            return statSync(p).mtimeMs;
          } catch (e) {
            return null;
          }
        };
        // NotePairFetch = {autoFile, claudeFile, autoText, claudeText, autoMtimeMs, claudeMtimeMs}
        // (confirmed via hooks/core/handoff.ts) -- an earlier draft used the wrong field
        // names ({text, mtime, claudeText, claudeMtime}) and omitted the two *File paths
        // entirely, which pickFromData()/tryPairPure() depend on.
        const own: NotePairFetch = {
          autoFile: ownFile,
          claudeFile: ownClaudeFile,
          autoText: readText(ownFile),
          claudeText: readText(ownClaudeFile),
          autoMtimeMs: mtimeOf(ownFile),
          claudeMtimeMs: mtimeOf(ownClaudeFile),
        };
        const latest: NotePairFetch = {
          autoFile: latestFile,
          claudeFile: latestClaudeFile,
          autoText: readText(latestFile),
          claudeText: readText(latestClaudeFile),
          autoMtimeMs: mtimeOf(latestFile),
          claudeMtimeMs: mtimeOf(latestClaudeFile),
        };
        // Simplification: the `.from` sidecar lookup for a fallback claude-kind latest
        // note is not separately fetched here (it only affects *attribution* of which
        // session a fallback note came from, never whether a note is offered at all) --
        // passing null degrades to `from: null` in that one fallback+claude combination.
        const p = pickFromData(sidS, input.source, own, latest, null, nowMs);
        if (p) {
          appendEvent({
            event: 'handoff_restore',
            session: sid,
            source: input.source,
            kind: (p as any).kind,
            fallback: (p as any).fallback,
            from_session: input.source === 'clear' ? (p as any).from || null : undefined,
          });
          const ctx = handoffAdditionalContext(p as any);
          if (ctx) {
            return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } };
          }
        }
      } catch (e) {
        /* handoff restore is best-effort, falls through to setup-nudge/nudge output below */
      }
    }

    // --- setup-nudge.js::run (ask once, ever) ------------------------------
    if (!inLane('SessionStart:first-run.js')) try {
      if (cfg.setupNudge !== false) {
        const flagFile = join(home(), 'setup-nudge.json');
        const flag = readJsonFile<{ shown?: boolean }>(flagFile, {});
        const settingsPath = join(homedir(), '.claude', 'settings.json');
        let raw: string | null = null;
        let code: string | null = null;
        try {
          raw = readFileSync(settingsPath, 'utf8');
        } catch (e) {
          code = (e as NodeJS.ErrnoException)?.code || null;
        }
        const cls = classifyText(raw, code);
        const d = setupNudgeDecide(cls, !!flag.shown);
        if (d.show) {
          writeJsonFile(flagFile, { shown: true, ts: nowMs });
          appendEvent({ event: 'setup_nudge', session: sid, reason: d.reason });
          lines.push(attributed(setupNudgeMessage(cfg.lang), cfg.lang, cfg._langAuto));
        }
      }
    } catch (e) {
      /* setup-nudge is best-effort */
    }

    // --- status line opportunistic refresh --------------------------------
    try {
      const usage = safeUsage();
      const state = usageToPaceState(usage, nowMs);
      tryUpdateStatusLine(statuslineSegmentFromUsage(usage, state, cfg));
    } catch (e) {
      /* desktop-only, never block */
    }

    if (!lines.length) return null;
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } };
  } catch (e) {
    return null; // never block SessionStart
  }
}

// ============================================================================
// classic.UserPromptSubmit — topic-gate (3-event) + nudge (grade change).
// Faithful port of scripts/topic-gate.js::run + scripts/nudge.js::run
// (UserPromptSubmit branch).
// ============================================================================

export async function onUserPromptSubmit(input: any): Promise<any> {
  try {
    if (input && input.hook_event_name && input.hook_event_name !== 'UserPromptSubmit') return null;
    const cfg0 = loadConfig();
    if (shouldSkipHook(process.env.CLAUDE_CODE_ENTRYPOINT, input?.cwd, cfg0.excludeCwd)) return null;
    const nowMs = Date.now();
    const cfg = withLangFromInput(cfg0, input?.prompt ?? null, input?.session_id, nowMs);
    const user = loadUserConfigRaw();
    const sid = input?.session_id || 'unknown';
    const lines: string[] = [];

    // --- topic-gate.js::run -------------------------------------------------
    if (!inLane('UserPromptSubmit:topic-gate.js') && input?.transcript_path) {
      const entries = tailEntries(input.transcript_path, 256 * 1024);
      // PLAN §3: token count now comes directly from $.session.usage().context instead
      // of re-deriving it from the transcript tail. Fall back to the transcript-derived
      // estimate (boundaryAnalyze) only if usage() is unavailable/zero, so this still
      // works (degraded) before the real shape of $.session.usage() is confirmed.
      const usage = safeUsage();
      let tokens = usageContextTokens(usage);
      if (!tokens) tokens = boundaryAnalyze(entries).tokens;

      const file = join(home(), 'topic-gate.json');
      const book = readJsonFile<Record<string, any>>(file, {});
      const rec = book[sid];
      // decideHint/decide/decideTopicCheck all take `user` (raw user config.json) as an
      // explicit 3rd parameter, separate from the merged `cfg` -- same split as boundary.ts.
      const h = decideHint(tokens, cfg as TopicGateCfg, user, rec && rec.hintAt);
      const d = topicGateDecide({ tokens, lastAssistantMs: lastAssistantTs(entries), nowMs, cwd: input.cwd }, cfg as TopicGateCfg, user, rec);
      let offeredAt = rec && rec.offeredAt;
      if (typeof offeredAt !== 'number' && clearOffered(entries)) offeredAt = tokens;
      const checkedAt = rec && rec.checkedAt;
      const tc = d.gate || h.hint ? { check: false, offeredAt, checkedAt } : decideTopicCheck(tokens, cfg as TopicGateCfg, user, offeredAt, checkedAt);

      const next = {
        cwd: input.cwd,
        gatedAt: d.gate ? tokens : rec && rec.gatedAt,
        hintAt: h.hintAt,
        offeredAt: typeof tc.offeredAt === 'number' ? tc.offeredAt : null,
        checkedAt: typeof tc.checkedAt === 'number' ? tc.checkedAt : null,
        ts: nowMs,
      };
      book[sid] = next;
      trimBook(book);
      writeJsonFile(file, book);

      if (d.gate) {
        appendEvent({ event: 'topic_gate', session: sid, tokens, idle_sec: Math.round((d as any).idleSec), cwd_changed: (d as any).cwdChanged });
        lines.push(topicGateMessage(cfg.lang, tokens, (d as any).idleSec, (d as any).cwdChanged, input.cwd, isDesktopApp()));
      }
      if (h.hint) {
        appendEvent({ event: 'inline_hint', session: sid, tokens });
        const rawTranscript = readWholeFileSafe(input.transcript_path);
        const prof = buildProfile(cfg, entries, rawTranscript);
        lines.push(hintMessage(cfg.lang, tokens, input.cwd, cfg as TopicGateCfg, prof as any, isDesktopApp()));
      }
      if (tc.check) {
        const line = topicCheckMessage(cfg.lang, tokens, input.cwd, isDesktopApp());
        appendEvent({ event: 'topic_check', session: sid, tokens, line_tokens: 0 });
        lines.push(line);
      }
    }

    // --- nudge.js::run (UserPromptSubmit branch) ---------------------------
    if (!inLane('UserPromptSubmit:nudge.js')) try {
      const nudgeFile = join(home(), 'nudge.json');
      const nudgeBook = readJsonFile<Record<string, { grade: string; ts: number }>>(nudgeFile, {});
      const last = nudgeBook[sid] && nudgeBook[sid].grade;
      const usage = safeUsage();
      const state = usageToPaceState(usage, nowMs);
      const d = nudgeDecide({ hook_event_name: 'UserPromptSubmit' }, state, cfg as NudgeCfg, Math.floor(nowMs / 1000), last);
      if (d.grade && d.grade !== last) {
        nudgeBook[sid] = { grade: d.grade, ts: nowMs };
        trimBook(nudgeBook);
        writeJsonFile(nudgeFile, nudgeBook);
      }
      if (d.text) {
        appendEvent({ event: 'nudge', session: sid, hook: 'UserPromptSubmit', grade: d.grade, worst: (d as any).worst });
        lines.push(attributed(d.text, cfg.lang, cfg._langAuto));
      }
    } catch (e) {
      /* nudge is best-effort */
    }

    // --- status line opportunistic refresh --------------------------------
    try {
      const usage = safeUsage();
      const state = usageToPaceState(usage, nowMs);
      tryUpdateStatusLine(statuslineSegmentFromUsage(usage, state, cfg));
    } catch (e) {
      /* desktop-only, never block */
    }

    if (!lines.length) return null;
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: attributed(lines.join(' '), cfg.lang || 'en', cfg._langAuto) } };
  } catch (e) {
    return null; // never block UserPromptSubmit
  }
}

// ============================================================================
// tool.call {tool:'Agent'} — agent-model downgrade. Faithful port of
// scripts/agent-model.js::run, adapted to the `next(e)` continuation pattern
// instead of a PreToolUse hookSpecificOutput return value.
//
// UNCONFIRMED: the exact shape of `e` (does it have `e.input`/`e.tool_input`? a
// `cwd`? a `session_id`?) and whether `next({...e, model})` is how the model field
// is actually threaded through (PLAN's literal example) vs. needing to live inside
// `e.input.model` (the classic PreToolUse shape agent-model.ts's decide()/output()
// were ported from). Both are attempted below: `next()` is called with the model
// placed in both locations so whichever the real runtime reads will see it.
// ============================================================================

// Fleet snapshot for onAgentToolCall (speculative wiring, like the rest of this handler): needs e.transcript_path,
// which is UNCONFIRMED for tool.call events. Any failure => null (pre-fleet decision). Read-only.
function safeFleet(e: any, cfg: Record<string, any>, nowSec: number): { running: number; models: Record<string, number>; truncated: boolean } | null {
  try {
    if (cfg.fleet === false || cfg.fleetShowAt === 0) return null;
    const dir = fleetSessionDir(e?.transcript_path);
    if (!dir) return null;
    const entries: FleetEntry[] = [];
    const take = (d: string) => {
      let names: string[] = [];
      try { names = readdirSync(d).filter((n) => /^agent-.+\.meta\.json$/.test(n)); } catch { return; }
      for (const n of names) {
        try {
          let t = statSync(join(d, n)).mtimeMs / 1000;
          try { t = Math.max(t, statSync(join(d, n.replace(/\.meta\.json$/, '.jsonl'))).mtimeMs / 1000); } catch { /* no transcript */ }
          entries.push({ name: n, mtime: t, text: readFileSync(join(d, n), 'utf8') });
        } catch { /* vanished */ }
      }
    };
    take(dir);
    try {
      for (const ent of readdirSync(join(dir, 'workflows'), { withFileTypes: true })) if (ent.isDirectory()) take(join(dir, 'workflows', ent.name));
    } catch { /* no workflows */ }
    return fleetPressure(fleetScanEntries(entries, nowSec, cfg as any));
  } catch { return null; }
}

export async function onAgentToolCall(e: any, next: (e: any) => Promise<any>): Promise<any> {
  // The PreToolUse command record runs agent-model.js; deciding here too would decide (and log) the same call twice.
  if (inLane('PreToolUse:agent-model.js')) return next(e);
  try {
    const cfg0 = loadConfig();
    const toolInput = e?.input ?? e?.tool_input ?? {};
    const pseudoInput = { tool_input: toolInput, cwd: e?.cwd ?? process.cwd(), session_id: e?.session_id };
    const cfg = withLangFromInput(cfg0, null, e?.session_id, Date.now()) as AgentModelCfg;
    const usage = safeUsage();
    const state = usageToPaceState(usage, Date.now());
    const nowSec = Math.floor(Date.now() / 1000);
    const fl = safeFleet(e, cfg as any, nowSec);
    const d = agentModelDecide(pseudoInput, state, cfg, nowSec, { fleet: fl } as any);
    appendEvent({
      event: 'agent_model',
      session: e?.session_id ?? null,
      subagent_type: toolInput?.subagent_type ?? null,
      tool_use_id: e?.tool_use_id ?? e?.id ?? null,
      action: d.action,
      reason: d.reason,
      model: d.model || null,
      grade: d.grade || null,
      fleet_running: fl ? fl.running : null,
    });
    if (d.action === 'inject' && d.model) {
      const updatedInput = Object.assign({}, toolInput, { model: d.model });
      // PLAN's literal pattern (`next({...e, model})`) alongside the classic
      // hookSpecificOutput-equivalent nested shape -- see comment above.
      return next(Object.assign({}, e, { model: d.model, input: updatedInput, tool_input: updatedInput }));
    }
    // 'suggest'/'pass': no confirmed way to surface additionalContext from a
    // tool.call handler (that was PreToolUse's job under classic hooks). Forward
    // the message into the event log only (already appended above) and pass the
    // call through unchanged -- never block a subagent launch over a text nudge.
    return next(e);
  } catch (err) {
    try {
      return next(e);
    } catch (err2) {
      return undefined; // if even the fallback next() throws, there is nothing left to do
    }
  }
}

// ============================================================================
// statusline.ts adapter. $.ui.status visibility on desktop is explicitly an open
// PLAN §7 question -- this just computes the text; tryUpdateStatusLine() (above)
// is the speculative part. cfg.wrap (spawning a child process to prepend external
// status text) is NOT re-implemented here: PLAN's own header for statusline.ts
// flags child-process reachability from a mods hook as unconfirmed and out of
// scope for stage 1.
// ============================================================================

function statuslineSegmentFromUsage(usage: any, state: PaceState, cfg: Record<string, any>): string {
  try {
    // NOTE: this file uses ESM `import` throughout (type-stripped by Node v24 natively);
    // `require()` is NOT available in this module scope. An earlier draft called
    // `require('./core/statusline.ts')` here, which would throw `ReferenceError:
    // require is not defined` every time (silently swallowed by this try/catch, so the
    // status line never actually updated) -- fixed to use the static top-level
    // `import { segment as statuslineSegment } from './core/statusline.ts'` instead.
    const nowSec = Math.floor(Date.now() / 1000);
    const legacyInput = {
      rate_limits: {
        seven_day: (state as any).seven_day ? { used_percentage: (state as any).seven_day.pct, resets_at: (state as any).seven_day.resets_at } : undefined,
        five_hour: (state as any).five_hour ? { used_percentage: (state as any).five_hour.pct, resets_at: (state as any).five_hour.resets_at } : undefined,
      },
      context_window: { total_input_tokens: usageContextTokens(usage) },
    };
    return statuslineSegment(legacyInput, state, nowSec, cfg as any, loadUserConfigRaw());
  } catch (e) {
    return '';
  }
}

// ============================================================================
// WIRING — the part that is almost entirely a guess. PLAN names `classic.X` and
// `tool.call {tool:'Agent'}` as existing, but never shows how a mod file hands a
// function to them. Every branch below is a different plausible convention; each
// is wrapped so an exception from a wrong guess just skips that branch instead of
// crashing module load (which would silently disable every feature in this file).
// Named exports (onSessionStart/onUserPromptSubmit/onStop/onAgentToolCall) are kept
// regardless, so whatever the correct wiring turns out to be on desktop, it can
// call these directly without touching any of the logic above.
// ============================================================================

try {
  // @ts-ignore -- guessed global namespace object, not declared anywhere on this PC
  const classicNs: any = typeof globalThis !== 'undefined' ? (globalThis as any).classic : undefined;
  if (classicNs) {
    if (typeof classicNs.SessionStart === 'function') classicNs.SessionStart(onSessionStart);
    if (typeof classicNs.UserPromptSubmit === 'function') classicNs.UserPromptSubmit(onUserPromptSubmit);
    if (typeof classicNs.Stop === 'function') classicNs.Stop(onStop);
  }
} catch (e) {
  /* wrong guess -- named exports below remain callable directly */
}

try {
  // @ts-ignore -- guessed global, not declared anywhere on this PC
  const toolNs: any = typeof globalThis !== 'undefined' ? (globalThis as any).tool : undefined;
  if (toolNs && typeof toolNs.call === 'function') {
    toolNs.call({ tool: 'Agent' }, onAgentToolCall);
  }
} catch (e) {
  /* wrong guess -- named export below remains callable directly */
}

export default { onSessionStart, onUserPromptSubmit, onStop, onAgentToolCall };
