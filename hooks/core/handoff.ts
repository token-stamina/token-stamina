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
export const HEADER = 'Token Stamina handoff (auto-saved before compact/clear)';
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
export const GIT_COMMIT = /\bgit(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+commit\b/;

// sha1 is a Node builtin (node:crypto) -- no network, available in every Node runtime including
// the one this file is tested under. Whether the mods `$.fs`/runtime environment also exposes
// node:crypto to register.ts is unconfirmed (desktop-only question, not stage 1 scope).
import { createHash } from 'node:crypto';

export function cwdHash(cwd: unknown): string {
  return createHash('sha1')
    .update(String(cwd || '').toLowerCase())
    .digest('hex')
    .slice(0, 12);
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

export interface ScanCommit { id: string | null; s: string }
export interface ScanResult {
  prompts: string[];
  commits: ScanCommit[];
  files: string[];
  todos: any[] | null;
  lastPromptTs: string | null;
}

// Pure: extract what the note needs from parsed transcript lines.
export function scan(entries: any[]): ScanResult {
  const prompts: string[] = [];
  const calls: any[] = [];
  const failed = new Set<string>();
  let todos: any[] | null = null;
  let lastPromptTs: string | null = null;
  for (const o of entries) {
    if (!o || o.isSidechain || !o.message) continue;
    const c = o.message.content;
    if (o.type === 'user') {
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result' && b.is_error) failed.add(b.tool_use_id);
      if (!o.isMeta && isRealPrompt(o)) {
        const t = promptText(o);
        if (t && !/^<(system-reminder|local-command|command-)/.test(t)) {
          prompts.push(t);
          lastPromptTs = o.timestamp || lastPromptTs;
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
  return { prompts, commits, files, todos, lastPromptTs };
}

export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 3) + '...' : s);

export interface RenderMeta {
  session: string;
  cwd?: string;
  saved: string;
  lastPromptTs?: string | null;
  prompts: string[];
  commits: ScanCommit[];
  files: string[];
  todos: any[] | null;
}
export interface RenderParams { promptLen: number; nCommits: number; nFiles: number; nTodos: number }

export function render(m: RenderMeta, p: RenderParams): string {
  const out: string[] = [];
  out.push(`<!-- token-stamina-handoff session=${m.session} lastPromptTs=${m.lastPromptTs || ''} saved=${m.saved} -->`);
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

export interface ParsedMeta { session: string; lastPromptTs: number | null; saved: number }

export function parseMeta(md: string | null | undefined): ParsedMeta | null {
  const m = /<!-- token-(?:stamina|pacer)-handoff session=(\S*) lastPromptTs=(\S*) saved=(\S*) -->/.exec(md || '');
  return m ? { session: m[1], lastPromptTs: m[2] ? Date.parse(m[2]) : null, saved: Date.parse(m[3]) } : null;
}

export const stripMeta = (md: string): string => md.replace(/<!--[\s\S]*?-->\s*/, '').trim();

// Pure replacement for runStop's side-file accumulation (the tail only covers the end of long
// sessions, so commits/files are merged into a running per-session total across calls).
export interface Accumulated { commits: ScanCommit[]; files: string[] }
export function accumulate(acc: Accumulated, sc: ScanResult): Accumulated {
  const ids = new Set(acc.commits.map((c) => c.id).filter(Boolean));
  const commits = acc.commits.slice();
  for (const c of sc.commits) if (!c.id || !ids.has(c.id)) commits.push(c);
  const files = acc.files.filter((f) => !sc.files.includes(f)).concat(sc.files).slice(-40);
  return { commits: commits.slice(-40), files };
}

// Pure replacement for the meta-object construction inline in runStop.
export function buildMeta(sid: string, cwd: string | undefined, nowMs: number, sc: ScanResult, acc: Accumulated): RenderMeta {
  return {
    session: sid,
    cwd,
    saved: new Date(nowMs).toISOString(),
    lastPromptTs: sc.lastPromptTs,
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
    if (!meta || meta.lastPromptTs === null || (ct as any) >= meta.lastPromptTs) {
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

// NOTE: the original module's impure `prune(dir, now)` (fs.readdirSync + fs.statSync + fs.unlinkSync),
// `runStop`/`runStart`/`run` orchestration (fs.readFileSync/writeFileSync/mkdirSync/copyFileSync,
// pace.readJson/writeJson/appendEvent/loadConfig) are NOT ported here -- that is register.ts's
// job (desktop-only, unverified on this PC). Everything above is the pure core register.ts calls
// with data it fetched via `$.fs` / `$.session`.
