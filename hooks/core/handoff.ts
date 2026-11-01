// Handoff notes without an LLM. Ported from scripts/handoff.js.
//  - Stop hook: writes <home>/handoff/<session>.md (+ latest-<cwdhash>.md) from the transcript tail.
//  - SessionStart hook (matcher compact|clear): injects that note as additionalContext into the
//    fresh conversation. A Claude-written <session>.claude.md that is newer than the last user
//    prompt wins over the auto note.
//
// The original mixed pure decision logic with inline `fs.readFileSync`/`fs.statSync` calls in two
// places:
//   - `dirOf()` -> `pace.home()` (impure) built every path; the port takes `dir` as an explicit
//     parameter in `sessionFileName`/`latestFileName` instead.
//   - `pick()` read the four candidate note files (and the `.from` sidecar) itself. The port
//     splits that into `pickFromData(...)`, a pure function that takes the already-read
//     text/mtime of each candidate (register.ts fetches them via `$.fs`, which -- per
//     PLAN-0.5-mods.md §1 -- caps reads at 4 MiB; these notes are capped well under that by
//     `handoffMaxTokens`, so a whole-file read is fine here, unlike boundary.ts's transcript tail).
//
// `runStop`'s side-file accumulation (merging this call's commits/files into the running session
// total) is split out as the pure `accumulate(acc, sc)`, and the note's data model as the pure
// `buildMeta(...)`, so register.ts only has to do the raw fs read/write/mkdir/copy/prune
// (file-system side effects) around these.

import { estimateTokens } from './text.ts';
import { isRealPrompt, commitSubject } from './boundary.ts';

export const TAIL_BYTES = 512 * 1024;
export const KEEP_SEC = 7 * 86400;
export const FALLBACK_MAX_AGE_SEC = 86400;
export const CLEAR_MAX_AGE_SEC = 3600;
export const CLEAR_LINK_MAX_SEC = 3600; // desktop-app clear: the new session must start within this of the marker
export const HEADER = 'Token Stamina handoff (auto-saved before compact/clear)';
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
export const GIT_COMMIT = /\bgit(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+commit\b/;

// The hooks module has no node:crypto: sha1Hex (text.ts) is a pure SHA-1 that gives the same
// hex as the Node scripts' createHash('sha1'), so latest-<hash>.md names stay shared.
import { sha1Hex } from './text.ts';

export function cwdHash(cwd: unknown): string {
  return sha1Hex(String(cwd || '').toLowerCase()).slice(0, 12);
}

export function safeId(s: unknown): string {
  return String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
}

// Pure path builders: the original called `dirOf()` (-> `pace.home()`, impure) internally.
// register.ts resolves `dir` once (via `$.fs`/the mods home-dir equivalent) and passes it in.
export function sessionFileName(dir: string, sid: unknown, claude?: boolean): string {
  return joinPath(dir, safeId(sid) + (claude ? '.claude.md' : '.md'));
}
export function latestFileName(dir: string, cwd: unknown, claude?: boolean): string {
  return joinPath(dir, 'latest-' + cwdHash(cwd) + (claude ? '.claude.md' : '.md'));
}
// Minimal path.join substitute (POSIX- and Windows-separator tolerant) so this file needs no
// `node:path` import beyond what's already pulled in transitively; avoids pulling in platform-
// specific separator behavior differences for a one-line join.
function joinPath(dir: string, name: string): string {
  const d = String(dir || '').replace(/[\\/]+$/, '');
  return d + '/' + name;
}

export function promptText(o: any): string {
  const c = o.message.content;
  let t = '';
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c))
    t = c
      .filter((b: any) => b && b.type === 'text')
      .map((b: any) => b.text)
      .join(' ');
  return t.replace(/\s+/g, ' ').trim();
}

// What the person typed: the desktop app puts <system-reminder> blocks in front of the prompt (in the
// same string or as separate text blocks), so they are cut off first. '' for prompts no one typed.
export function promptBody(t: string): string {
  const b = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').replace(/\s+/g, ' ').trim();
  return /^<(system-reminder|local-command|command-|cross-session-message|task-notification|side-sessions-event|ci-monitor-event)/.test(b) ? '' : b;
}

export interface ScanCommit { id: string | null; s: string }
export interface ScanResult {
  prompts: string[];
  commits: ScanCommit[];
  files: string[];
  todos: any[] | null;
  lastPromptTs: string | null;
  prevPromptTs: string | null;
}

// Pure: extract what the note needs from parsed transcript lines.
export function scan(entries: any[]): ScanResult {
  const prompts: string[] = [];
  const calls: any[] = [];
  const failed = new Set<string>();
  let todos: any[] | null = null;
  let lastPromptTs: string | null = null;
  let prevPromptTs: string | null = null;
  for (const o of entries) {
    if (!o || o.isSidechain || !o.message) continue;
    const c = o.message.content;
    if (o.type === 'user') {
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result' && b.is_error) failed.add(b.tool_use_id);
      if (!o.isMeta && isRealPrompt(o)) {
        const t = promptBody(promptText(o));
        if (t) {
          prompts.push(t);
          if (o.timestamp) {
            prevPromptTs = lastPromptTs;
            lastPromptTs = o.timestamp;
          }
        }
      }
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (!b || b.type !== 'tool_use') continue;
        calls.push(b);
        if (b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) todos = b.input.todos;
      }
    }
  }
  const commits: ScanCommit[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  for (const b of calls) {
    if (b.id) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
    }
    const inp = b.input || {};
    if (EDIT_TOOLS.has(b.name)) {
      const f = inp.file_path || inp.notebook_path;
      if (typeof f === 'string') {
        const i = files.indexOf(f);
        if (i >= 0) files.splice(i, 1);
        files.push(f);
      }
    } else if (SHELL_TOOLS.has(b.name) && typeof inp.command === 'string' && GIT_COMMIT.test(inp.command) && !failed.has(b.id)) {
      const s = commitSubject(inp.command) || inp.command.replace(/\s+/g, ' ').slice(0, 60);
      commits.push({ id: b.id || null, s });
    }
  }
  return { prompts, commits, files, todos, lastPromptTs, prevPromptTs };
}

export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 3) + '...' : s);

export interface RenderMeta {
  session: string;
  cwd?: string;
  saved: string;
  lastPromptTs?: string | null;
  prevPromptTs?: string | null;
  prompts: string[];
  commits: ScanCommit[];
  files: string[];
  todos: any[] | null;
}
export interface RenderParams { promptLen: number; nCommits: number; nFiles: number; nTodos: number }

export function render(m: RenderMeta, p: RenderParams): string {
  const out: string[] = [];
  out.push(`<!-- token-stamina-handoff session=${m.session} lastPromptTs=${m.lastPromptTs || ''} saved=${m.saved} -->`);
  // Separate comment so older parsers still match the first line.
  if (m.prevPromptTs) out.push(`<!-- token-stamina-handoff-prev prevPromptTs=${m.prevPromptTs} -->`);
  out.push(`# Handoff note (auto, no LLM)`);
  out.push(`- cwd: ${m.cwd || '?'}`);
  out.push(`- saved: ${m.saved}`);
  if (m.prompts.length) {
    out.push('', '## Last user requests (oldest first)');
    for (const t of m.prompts.slice(-3)) out.push(`- ${clip(t, p.promptLen)}`);
  }
  if (m.commits.length) {
    out.push('', '## Commits this session');
    for (const c of m.commits.slice(-p.nCommits)) out.push(`- ${clip(c.s, 100)}`);
  }
  if (m.files.length) {
    out.push('', '## Files edited (most recent last)');
    for (const f of m.files.slice(-p.nFiles)) out.push(`- ${f}`);
  }
  if (m.todos && m.todos.length) {
    out.push('', '## Latest todo list');
    for (const t of m.todos.slice(0, p.nTodos)) out.push(`- [${t.status || '?'}] ${clip(String(t.content || t.subject || ''), 120)}`);
  }
  return out.join('\n') + '\n';
}

// Shrink step by step until under the token cap, then hard-cut.
export function renderCapped(m: RenderMeta, maxTokens: number): string {
  const p: RenderParams = { promptLen: 200, nCommits: 20, nFiles: 15, nTodos: 20 };
  const steps = [
    () => {
      p.nTodos = 10;
      p.nCommits = 10;
    },
    () => {
      p.nFiles = 8;
    },
    () => {
      p.promptLen = 120;
      p.nCommits = 5;
      p.nTodos = 6;
    },
    () => {
      p.nFiles = 3;
      p.nCommits = 3;
      p.nTodos = 3;
      p.promptLen = 80;
    },
  ];
  let md = render(m, p);
  for (const s of steps) {
    if (estimateTokens(md) <= maxTokens) break;
    s();
    md = render(m, p);
  }
  if (estimateTokens(md) > maxTokens) md = md.slice(0, Math.floor(maxTokens * 3)) + '\n...(truncated)\n';
  return md;
}

export interface ParsedMeta { session: string; lastPromptTs: number | null; prevPromptTs: number | null; saved: number }

export function parseMeta(md: string | null | undefined): ParsedMeta | null {
  const m = /<!-- token-(?:stamina|pacer)-handoff session=(\S*) lastPromptTs=(\S*) saved=(\S*) -->/.exec(md || '');
  if (!m) return null;
  const pv = /<!-- token-stamina-handoff-prev prevPromptTs=(\S+) -->/.exec(md || '');
  return { session: m[1], lastPromptTs: m[2] ? Date.parse(m[2]) : null, prevPromptTs: pv ? Date.parse(pv[1]) : null, saved: Date.parse(m[3]) };
}

export const stripMeta = (md: string): string => md.replace(/^(?:\s*<!--[\s\S]*?-->)+\s*/, '').trim();

// Pure replacement for runStop's side-file accumulation (the tail only covers the end of long
// sessions, so commits/files are merged into a running per-session total across calls).
export interface Accumulated { commits: ScanCommit[]; files: string[]; lastPromptTs?: string | null; prevPromptTs?: string | null; recent?: RecentTurn[]; stopAt?: number }
export function accumulate(acc: Accumulated, sc: ScanResult): Accumulated {
  const ids = new Set(acc.commits.map((c) => c.id).filter(Boolean));
  const commits = acc.commits.slice();
  for (const c of sc.commits) if (!c.id || !ids.has(c.id)) commits.push(c);
  const files = acc.files.filter((f) => !sc.files.includes(f)).concat(sc.files).slice(-40);
  const out: Accumulated = { commits: commits.slice(-40), files };
  // The tail can hold only the last prompt after big tool output, so the prompt before it is carried here.
  if (sc.lastPromptTs && sc.lastPromptTs !== acc.lastPromptTs) {
    out.lastPromptTs = sc.lastPromptTs;
    out.prevPromptTs = sc.prevPromptTs || acc.lastPromptTs || null;
  } else if (acc.lastPromptTs !== undefined) {
    out.lastPromptTs = acc.lastPromptTs;
    out.prevPromptTs = acc.prevPromptTs ?? null;
  }
  return out;
}

// The last few exchanges, kept beside the note so a clear can show them again on screen
// ($.ui.log: drawn in the transcript, never sent to the model). One per real prompt: the
// prompt and the last text the assistant wrote before the next one (tool-only turns keep '').
export interface RecentTurn { ts: string; user: string; claude: string }
export const RECENT_CLIP = 140;

export function recentTurns(entries: any[], dropLast: boolean): RecentTurn[] {
  const out: RecentTurn[] = [];
  let cur: RecentTurn | null = null;
  for (const o of entries) {
    if (!o || o.isSidechain || !o.message) continue;
    if (o.type === 'user' && !o.isMeta && isRealPrompt(o)) {
      const t = promptBody(promptText(o));
      if (!t) continue;
      cur = { ts: String(o.timestamp || ''), user: t, claude: '' };
      out.push(cur);
    } else if (cur && o.type === 'assistant' && Array.isArray(o.message.content)) {
      const t = o.message.content
        .filter((b: any) => b && b.type === 'text')
        .map((b: any) => b.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (t) cur.claude = t;
    }
  }
  // The turn that asked for the clear (the button click, then the clear_session call) is not worth replaying.
  if (dropLast) out.pop();
  return out;
}

// Merge this tail's turns into the ones kept so far (the tail can hold only the end of a long turn), by timestamp.
export function mergeRecent(prev: RecentTurn[] | undefined, next: RecentTurn[], n: number): RecentTurn[] {
  const byTs = new Map<string, RecentTurn>();
  for (const r of [...(prev || []), ...next]) byTs.set(r.ts + '\n' + r.user, r);
  const all = [...byTs.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return n > 0 ? all.slice(-n).map((r) => ({ ts: r.ts, user: clip(r.user, RECENT_CLIP), claude: clip(r.claude, RECENT_CLIP) })) : [];
}

// The prompt times UserPromptSubmit keeps in topic-gate.json. Only a prompt the person typed moves them:
// a <task-notification> or <side-sessions-event> turn keeps the last typed prompt's times.
export function promptStamps(prompt: unknown, rec: { promptAt?: unknown; prevPromptAt?: unknown } | null | undefined, nowMs: number): { promptAt: unknown; prevPromptAt: unknown } {
  if (typeof prompt === 'string' && !promptBody(prompt.replace(/\s+/g, ' ').trim())) return { promptAt: rec && rec.promptAt, prevPromptAt: rec && rec.prevPromptAt };
  return { promptAt: nowMs, prevPromptAt: rec && rec.promptAt };
}

// Rows rebuilt from $.session.messages (a transcript over 4 MiB) carry no timestamps, so scan() finds none.
// The prompt times topic-gate.json recorded at each UserPromptSubmit (promptAt/prevPromptAt, ms) stand in;
// without them the side file's carried values stay, never an empty lastPromptTs (an empty one lets an
// hours-old Claude-written note beat the fresh auto note in pickFromData).
// A prompt recorded after stopMs belongs to the next turn (its UserPromptSubmit ran while this Stop was
// reading): this turn's prompt is then that record's prevPromptAt, and the one before it is not known.
export function fallbackPromptTs(sc: ScanResult, rec: { promptAt?: unknown; prevPromptAt?: unknown } | null | undefined, prev: Accumulated, stopMs?: number): ScanResult {
  const iso = (x: unknown) => (typeof x === 'number' && isFinite(x) ? new Date(x).toISOString() : null);
  if (rec && typeof stopMs === 'number' && typeof rec.promptAt === 'number' && rec.promptAt > stopMs) rec = { promptAt: rec.prevPromptAt };
  const last = iso(rec && rec.promptAt) || prev.lastPromptTs || null;
  // without a prevPromptAt: a new last prompt pushes the carried one back (accumulate's rule), else the carried prev stays
  const before = iso(rec && rec.prevPromptAt) || (last !== (prev.lastPromptTs || null) ? prev.lastPromptTs : prev.prevPromptTs) || null;
  return { ...sc, lastPromptTs: last, prevPromptTs: before };
}

// The turns kept beside the note after a Stop. Rows rebuilt from $.session.messages have no timestamps
// (ts ''), which would sort first in mergeRecent and corrupt the order: keep what was kept before.
export function nextRecent(prev: RecentTurn[] | undefined, entries: any[], dropLast: boolean, n: number, fromFallback: boolean): RecentTurn[] | undefined {
  if (fromFallback) return prev;
  return mergeRecent(prev, recentTurns(entries, dropLast), n);
}

// The lines $.ui.log draws after a clear, oldest first.
export function recentLog(turns: RecentTurn[], lang: string): string[] {
  if (!turns.length) return [];
  const ko = lang === 'ko';
  const lines = [ko ? `Token Stamina: 비우기 전 마지막 ${turns.length}턴 (화면에만, 모델은 안 읽음)` : `Token Stamina: last ${turns.length} turns before the clear (on screen only, not sent to the model)`];
  for (const r of turns) {
    lines.push('> ' + r.user);
    if (r.claude) lines.push('  ' + r.claude);
  }
  return lines;
}

// Pure replacement for the meta-object construction inline in runStop.
export function buildMeta(sid: string, cwd: string | undefined, nowMs: number, sc: ScanResult, acc: Accumulated): RenderMeta {
  return {
    session: sid,
    cwd,
    saved: new Date(nowMs).toISOString(),
    lastPromptTs: sc.lastPromptTs,
    prevPromptTs: acc.prevPromptTs || sc.prevPromptTs,
    prompts: sc.prompts,
    commits: acc.commits,
    files: acc.files,
    todos: sc.todos,
  };
}

export interface NotePairFetch {
  autoFile: string;
  claudeFile: string;
  autoText: string | null;
  claudeText: string | null;
  autoMtimeMs: number | null;
  claudeMtimeMs: number | null;
}
export interface PickResult { file: string; kind: 'claude' | 'auto'; text: string; fallback: boolean; from: string | null }

// Pure core of a single tryPair() call from the original pick(): given the already-read text and
// mtime of both candidate files in a pair, decide which (if either) wins.
function tryPairPure(p: NotePairFetch, maxAgeSec: number, clearOnly: boolean, nowMs: number): Omit<PickResult, 'fallback' | 'from'> | null {
  const meta = parseMeta(p.autoText);
  if (p.claudeText !== null) {
    const ct = p.claudeMtimeMs;
    // A clear is asked for by the last prompt itself (the card's button), after the note was written,
    // so for a clear the note only has to be newer than the prompt before that one.
    const since = meta ? (clearOnly && meta.prevPromptTs !== null ? meta.prevPromptTs : meta.lastPromptTs) : null;
    if (since === null || (ct as any) >= since) {
      const age = clearOnly ? CLEAR_MAX_AGE_SEC : maxAgeSec;
      if (!age || nowMs - (ct as any) <= age * 1000) return { file: p.claudeFile, kind: 'claude', text: p.claudeText };
    }
  }
  if (p.autoText !== null && !clearOnly) {
    if (!maxAgeSec || nowMs - (p.autoMtimeMs as any) <= maxAgeSec * 1000) return { file: p.autoFile, kind: 'auto', text: p.autoText };
  }
  return null;
}

// Pure replacement for scripts/handoff.js `pick(sid, cwd, nowMs, source)`. register.ts fetches
// the four candidate files (own session .md/.claude.md, latest-<cwdhash> .md/.claude.md) plus the
// `.from` sidecar text for the latest .claude.md, and passes everything in as already-read data.
export function pickFromData(
  sid: string,
  source: string | undefined,
  own: NotePairFetch,
  latest: NotePairFetch,
  latestClaudeFromText: string | null,
  nowMs: number,
): PickResult | null {
  const clearOnly = source === 'clear';
  const ownHit = tryPairPure(own, 0, clearOnly, nowMs);
  if (ownHit) return Object.assign(ownHit, { fallback: false, from: safeId(sid) });
  const lat = tryPairPure(latest, FALLBACK_MAX_AGE_SEC, clearOnly, nowMs);
  if (!lat) return null;
  // Session the note belongs to: auto note carries it in its meta, a Claude note in the .from sidecar written by runStop.
  const meta = lat.kind === 'auto' ? parseMeta(lat.text) : null;
  const side = lat.kind === 'claude' ? (latestClaudeFromText || '').trim() : '';
  return Object.assign(lat, { fallback: true, from: (meta && meta.session) || side || null });
}

export function additionalContext(p: { text: string }): string {
  return HEADER + '\n' + stripMeta(p.text);
}

// Desktop-app clear_session starts a new CLI session without running SessionStart for a clear, so the clearing turn leaves a
// marker keyed by the app session id (CLAUDE_CODE_HOST_SESSION_ID, unchanged across the clear); the new CLI session restores
// from it on its first SessionStart or UserPromptSubmit, whichever runs first. Pure parts below.
export interface PendingClear { from: string; host: string; cwd?: string; at: number }

export function pendingClearName(dir: string, host: unknown): string {
  return joinPath(dir, 'pending-clear-' + safeId(host) + '.json');
}

// Did the turn after the last real prompt call clear_session on itself ('self' or the app session id `host`)?
export function clearedSelf(entries: any[], host?: string): boolean {
  let i = entries.length - 1;
  while (i >= 0 && !isRealPrompt(entries[i])) i--;
  // Only a call that went through counts: a denied or failed call (is_error result, or no result yet) leaves no marker.
  const calls: string[] = [], ok = new Set<string>();
  for (const o of entries.slice(i + 1)) {
    if (!o || o.isSidechain || !o.message || !Array.isArray(o.message.content)) continue;
    for (const b of o.message.content) {
      if (!b) continue;
      if (o.type === 'assistant' && b.type === 'tool_use' && /clear_session$/.test(String(b.name || '')) && b.input
        && (b.input.session_id === 'self' || (!!host && b.input.session_id === host))) calls.push(b.id);
      else if (o.type === 'user' && b.type === 'tool_result' && !b.is_error) ok.add(b.tool_use_id);
    }
  }
  return calls.some((id) => ok.has(id));
}

// 'restore' = inject the note; 'drop' = marker is spent (invalid, expired or the current session's own). Both delete it.
export function decidePrompt(mk: any, sid: string, nowMs: number): 'drop' | 'restore' {
  if (!mk || typeof mk.from !== 'string' || typeof mk.at !== 'number') return 'drop';
  if (nowMs - mk.at > CLEAR_LINK_MAX_SEC * 1000 || safeId(mk.from) === safeId(sid)) return 'drop';
  return 'restore';
}

export function clearContext(p: { kind: string; text: string }): string {
  return HEADER + ' [' + p.kind + ' note]\n' + stripMeta(p.text);
}

// Which note to inject: the old session's Claude note if written within an hour before the marker, else its auto note.
export function pickClearNote(
  claudeText: string | null, claudeMtimeMs: number | null, autoText: string | null, markerAt: number,
): { kind: 'claude' | 'auto'; text: string } | null {
  if (claudeText !== null && claudeMtimeMs !== null && claudeMtimeMs >= markerAt - CLEAR_MAX_AGE_SEC * 1000) return { kind: 'claude', text: claudeText };
  if (autoText !== null) return { kind: 'auto', text: autoText };
  return null;
}

// NOTE: the original module's impure `prune(dir, now)` (fs.readdirSync + fs.statSync + fs.unlinkSync),
// `runStop`/`runStart`/`run` orchestration (fs.readFileSync/writeFileSync/mkdirSync/copyFileSync,
// pace.readJson/writeJson/appendEvent/loadConfig) are NOT ported here -- that is register.ts's
// job (desktop-only, unverified on this PC). Everything above is the pure core register.ts calls
// with data it fetched via `$.fs` / `$.session`.
