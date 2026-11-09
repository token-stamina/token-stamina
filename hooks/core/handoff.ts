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

// $.fs has no delete: a note file unchanged for KEEP_SEC is emptied instead (the Node build unlinked it).
// The names of the entries to empty: files with content whose last write is older than KEEP_SEC.
export function staleNotes(entries: { name: string; kind: string; size: number; mtimeMs: number }[], nowMs: number): string[] {
  return entries.filter((e) => e.kind === 'file' && e.size > 0 && nowMs - e.mtimeMs > KEEP_SEC * 1000).map((e) => e.name);
}

// An emptied note (blank text) reads as no note.
export const noteText = (t: string | null): string | null => (t != null && t.trim() ? t : null);
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
  if (/^<(system-reminder|local-command|command-|cross-session-message|task-notification|side-sessions-event|ci-monitor-event)/.test(b)) return '';
  // Text the app or a tool puts in the user role (0.6.13): a tool-search result line, a notification, a peer session's message.
  if (/^(Tool loaded\.|\[SYSTEM NOTIFICATION|Another Claude session sent a message)/.test(b)) return '';
  if (/<(cross-session-message[\s>]|task-notification>)/.test(b)) return '';
  return b;
}

export interface ScanCommit { id: string | null; s: string }
export interface ScanResult {
  // Display form (`~/...`) of the session's transcript file; the line is left out when the hook input had no path.
  transcript?: string;
  prompts: string[];
  commits: ScanCommit[];
  files: string[];
  todos: any[] | null;
  lastPromptTs: string | null;
  prevPromptTs: string | null;
  // Work started and not finished when the rows end (see waitingOn); optional for callers that build a ScanResult by hand.
  waiting?: string[];
}

export const WAITING_MAX = 5;
export const SESSIONS_MAX = 8; // sessions opened with start_session (a coordinator can run 5 to 10)
const START_SESSION = /(?:^|__)start_session$/;
const END_SESSION = /(?:^|__)(?:stop_session|archive_session|delete_session)$/;
const WAIT_CLIP = 80;
const TASK_DONE = /^(completed|failed|killed|stopped|cancelled|canceled)$/i;

function resultText(b: any): string {
  const c = b && b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x: any) => (x && typeof x.text === 'string' ? x.text : '')).join(' ');
  return '';
}

// What the next session should know is still running: a Bash/PowerShell started with run_in_background whose
// <task-notification> (completed/failed/killed) has not come, and an Agent call that has no tool_result yet.
// Newest last, at most WAITING_MAX. Pure; reads transcript-shaped rows (also the ones apiRows builds).
export function waitingOn(entries: any[]): string[] {
  const bg = new Map<string, string>(); // tool_use_id -> description
  const taskOf = new Map<string, string>(); // tool_use_id -> task id
  const agents = new Map<string, string>(); // tool_use_id -> description
  const resolved = new Set<string>();
  const doneTasks = new Set<string>();
  const sess = new Map<string, { title: string; id: string }>(); // tool_use_id -> a session start_session opened
  const endedSessions = new Set<string>();
  for (const o of entries) {
    if (!o || o.isSidechain || !o.message) continue;
    const c = o.message.content;
    if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (!b || b.type !== 'tool_use' || !b.id) continue;
        const inp = b.input || {};
        const desc = String(inp.description || inp.command || inp.prompt || b.name || '').replace(/\s+/g, ' ').trim();
        if (SHELL_TOOLS.has(b.name) && inp.run_in_background === true) bg.set(b.id, clip(desc, WAIT_CLIP));
        else if (b.name === 'Agent' || b.name === 'Task') agents.set(b.id, clip(desc, WAIT_CLIP));
        else if (b.name === 'TaskStop' && inp.task_id) doneTasks.add(String(inp.task_id));
        else if (START_SESSION.test(String(b.name || ''))) {
          const title = String(inp.title || inp.name || inp.prompt || '').replace(/\s+/g, ' ').trim();
          sess.set(b.id, { title: clip(title, WAIT_CLIP), id: '' });
        } else if (END_SESSION.test(String(b.name || '')) && inp.session_id) endedSessions.add(String(inp.session_id));
      }
    } else if (o.type === 'user') {
      let text = typeof c === 'string' ? c : '';
      if (Array.isArray(c))
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'tool_result') {
            resolved.add(b.tool_use_id);
            const m = bg.has(b.tool_use_id) ? /\bID:\s*([A-Za-z0-9_-]+)/.exec(resultText(b)) : null;
            if (m) taskOf.set(b.tool_use_id, m[1]);
            const ss = sess.get(b.tool_use_id);
            if (ss) {
              // as much as the result gives: an id (session_id / a local_... token) and a name
              const rt = resultText(b);
              const idm = /"?session_?id"?\s*[:=]\s*"?([A-Za-z0-9_-]{4,})|\b(local_[A-Za-z0-9_-]+)/i.exec(rt);
              if (idm) ss.id = idm[1] || idm[2] || '';
              const nm = /"?(?:title|name)"?\s*[:=]\s*"([^"\n]{1,80})"/i.exec(rt);
              if (nm && !ss.title) ss.title = nm[1];
            }
          } else if (b.type === 'text') text += ' ' + b.text;
        }
      for (const m of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
        const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(m[0]);
        const st = /<status>\s*([^<\s]+)\s*<\/status>/.exec(m[0]);
        if (id && st && TASK_DONE.test(st[1])) doneTasks.add(id[1]);
      }
    }
  }
  const out: string[] = [];
  for (const [id, d] of bg) {
    const task = taskOf.get(id);
    if (task && doneTasks.has(task)) continue;
    out.push(`background ${task ? 'task ' + task : 'command'}: ${d}`);
  }
  for (const [id, d] of agents) if (!resolved.has(id)) out.push(`agent: ${d}`);
  const sessions: string[] = [];
  for (const [, ss] of sess) {
    if (ss.id && endedSessions.has(ss.id)) continue;
    sessions.push(`session${ss.id ? ' ' + ss.id : ''}: ${ss.title || '(untitled)'}`);
  }
  return [...out.slice(-WAITING_MAX), ...sessions.slice(-SESSIONS_MAX)];
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
  return { prompts, commits, files, todos, lastPromptTs, prevPromptTs, waiting: waitingOn(entries) };
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
  waiting?: string[];
}
export interface RenderParams { promptLen: number; nCommits: number; nFiles: number; nTodos: number; nPrompts?: number }

// One line pointing at the session's own conversation file, so a model asked "what was that earlier?" can search it.
export const transcriptLine = (shown: string): string => `- transcript: ${shown}`;
// A restored note gets the line when it has none (a Claude-written note never has it). No path: the note stays as is.
export function withTranscriptLine(text: string, shown: string | null | undefined): string {
  if (!shown || /^- transcript:/m.test(text)) return text;
  return text.replace(/\n*$/, '\n') + transcriptLine(shown) + '\n';
}

export function render(m: RenderMeta, p: RenderParams): string {
  const out: string[] = [];
  out.push(`<!-- token-stamina-handoff session=${m.session} lastPromptTs=${m.lastPromptTs || ''} saved=${m.saved} -->`);
  // Separate comment so older parsers still match the first line.
  if (m.prevPromptTs) out.push(`<!-- token-stamina-handoff-prev prevPromptTs=${m.prevPromptTs} -->`);
  out.push(`# Handoff note (auto, no LLM)`);
  out.push(`- cwd: ${m.cwd || '?'}`);
  if (m.transcript) out.push(transcriptLine(m.transcript));
  out.push(`- saved: ${m.saved}`);
  if (m.prompts.length) {
    out.push('', '## Last user requests (oldest first)');
    for (const t of m.prompts.slice(-(p.nPrompts || 3))) out.push(`- ${clip(t, p.promptLen)}`);
  }
  if (m.waiting && m.waiting.length) {
    out.push('', '## Waiting on (started, no result yet when this note was saved)');
    for (const w of m.waiting.slice(-(WAITING_MAX + SESSIONS_MAX))) out.push(`- ${clip(w, p.promptLen + 40)}`);
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
export function renderCapped(m: RenderMeta, maxTokens: number, requests = 3): string {
  const want = Math.max(1, Math.min(20, Math.floor(Number(requests)) || 3));
  const p: RenderParams = { promptLen: 200, nCommits: 20, nFiles: 15, nTodos: 20, nPrompts: want };
  // Files, commits and todos shrink first; the requests and the sessions/tasks waiting on go last (0.6.13).
  const steps = [
    () => {
      p.nTodos = 10;
      p.nCommits = 10;
    },
    () => {
      p.nFiles = 8;
    },
    () => {
      p.nFiles = 3;
      p.nCommits = 5;
      p.nTodos = 6;
    },
    () => {
      p.nCommits = 3;
      p.nTodos = 3;
      p.promptLen = 120;
    },
    () => {
      p.promptLen = 80;
    },
    () => {
      p.nPrompts = Math.min(want, 3);
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
    ...(sc.waiting ? { waiting: sc.waiting } : {}),
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
export interface PendingClear { from: string; host: string; cwd?: string; at: number; tokens?: number; transcript?: string }

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
export type PromptDecision = { action: 'restore' } | { action: 'drop'; reason: 'invalid' | 'expired' | 'own' };
export function decidePromptReason(mk: any, sid: string, nowMs: number): PromptDecision {
  if (!mk || typeof mk.from !== 'string' || typeof mk.at !== 'number') return { action: 'drop', reason: 'invalid' };
  if (nowMs - mk.at > CLEAR_LINK_MAX_SEC * 1000) return { action: 'drop', reason: 'expired' };
  if (safeId(mk.from) === safeId(sid)) return { action: 'drop', reason: 'own' };
  return { action: 'restore' };
}
export function decidePrompt(mk: any, sid: string, nowMs: number): 'drop' | 'restore' {
  return decidePromptReason(mk, sid, nowMs).action;
}

// Key of one marker for the in-process "already injected" set (a failed marker delete must not re-inject the note).
export const markerKey = (mk: { from: string; at: number }): string => safeId(mk.from) + ':' + mk.at;

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
