'use strict';
// Handoff notes without an LLM.
//  - Stop hook: writes <home>/handoff/<session>.md (+ latest-<cwdhash>.md) from the transcript tail.
//  - SessionStart hook (matcher compact|clear): injects that note as additionalContext into the fresh conversation.
// A Claude-written <session>.claude.md that is newer than the last user prompt wins over the auto note.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pace = require('./pace');
const boundary = require('./boundary');
const { estimateTokens } = require('./audit');

const TAIL_BYTES = 512 * 1024;
const KEEP_SEC = 7 * 86400;
const FALLBACK_MAX_AGE_SEC = 86400;
const CLEAR_MAX_AGE_SEC = 3600;
const HEADER = 'Token Stamina handoff (auto-saved before compact/clear)';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const GIT_COMMIT = /\bgit(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+commit\b/;

const dirOf = () => path.join(pace.home(), 'handoff');
const cwdHash = (cwd) => crypto.createHash('sha1').update(String(cwd || '').toLowerCase()).digest('hex').slice(0, 12);
const safeId = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
const sessionFile = (sid, claude) => path.join(dirOf(), safeId(sid) + (claude ? '.claude.md' : '.md'));
const latestFile = (cwd, claude) => path.join(dirOf(), 'latest-' + cwdHash(cwd) + (claude ? '.claude.md' : '.md'));

function promptText(o) {
  const c = o.message.content;
  let t = '';
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) t = c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
  return t.replace(/\s+/g, ' ').trim();
}

// Pure: extract what the note needs from parsed transcript lines.
function scan(entries) {
  const prompts = [], calls = [], failed = new Set();
  let todos = null, lastPromptTs = null;
  for (const o of entries) {
    if (!o || o.isSidechain || !o.message) continue;
    const c = o.message.content;
    if (o.type === 'user') {
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result' && b.is_error) failed.add(b.tool_use_id);
      if (!o.isMeta && boundary.isRealPrompt(o)) {
        const t = promptText(o);
        if (t && !/^<(system-reminder|local-command|command-)/.test(t)) { prompts.push(t); lastPromptTs = o.timestamp || lastPromptTs; }
      }
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (!b || b.type !== 'tool_use') continue;
        calls.push(b);
        if (b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) todos = b.input.todos;
      }
    }
  }
  const commits = [], files = [], seen = new Set();
  for (const b of calls) {
    if (b.id) { if (seen.has(b.id)) continue; seen.add(b.id); }
    const inp = b.input || {};
    if (EDIT_TOOLS.has(b.name)) {
      const f = inp.file_path || inp.notebook_path;
      if (typeof f === 'string') { const i = files.indexOf(f); if (i >= 0) files.splice(i, 1); files.push(f); }
    } else if (SHELL_TOOLS.has(b.name) && typeof inp.command === 'string' && GIT_COMMIT.test(inp.command) && !failed.has(b.id)) {
      const s = boundary.commitSubject(inp.command) || inp.command.replace(/\s+/g, ' ').slice(0, 60);
      commits.push({ id: b.id || null, s });
    }
  }
  return { prompts, commits, files, todos, lastPromptTs };
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

function render(m, p) {
  const out = [];
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
function renderCapped(m, maxTokens) {
  const p = { promptLen: 200, nCommits: 20, nFiles: 15, nTodos: 20 };
  const steps = [() => { p.nTodos = 10; p.nCommits = 10; }, () => { p.nFiles = 8; }, () => { p.promptLen = 120; p.nCommits = 5; p.nTodos = 6; },
    () => { p.nFiles = 3; p.nCommits = 3; p.nTodos = 3; p.promptLen = 80; }];
  let md = render(m, p);
  for (const s of steps) { if (estimateTokens(md) <= maxTokens) break; s(); md = render(m, p); }
  if (estimateTokens(md) > maxTokens) md = md.slice(0, Math.floor(maxTokens * 3)) + '\n...(truncated)\n';
  return md;
}

function parseMeta(md) {
  const m = /<!-- token-(?:stamina|pacer)-handoff session=(\S*) lastPromptTs=(\S*) saved=(\S*) -->/.exec(md || '');
  return m ? { session: m[1], lastPromptTs: m[2] ? Date.parse(m[2]) : null, saved: Date.parse(m[3]) } : null;
}
const stripMeta = (md) => md.replace(/<!--[\s\S]*?-->\s*/, '').trim();

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch (e) { return null; } }

function prune(dir, now) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  let n = 0;
  for (const f of names) {
    const p = path.join(dir, f);
    const t = mtime(p);
    if (t !== null && now - t > KEEP_SEC * 1000) { try { fs.unlinkSync(p); n++; } catch (e) { /* ignore */ } }
  }
  return n;
}

function runStop(input, nowMs) {
  const cfg = pace.loadConfig();
  if (cfg.handoff === false || !input.transcript_path) return null;
  nowMs = nowMs || Date.now();
  const sid = safeId(input.session_id);
  const sc = scan(boundary.readTail(input.transcript_path, TAIL_BYTES));
  const dir = dirOf();
  fs.mkdirSync(dir, { recursive: true });
  // Session-long accumulation (the tail only covers the end of long sessions).
  const side = path.join(dir, sid + '.json');
  const acc = pace.readJson(side, { commits: [], files: [] });
  const ids = new Set(acc.commits.map((c) => c.id).filter(Boolean));
  for (const c of sc.commits) if (!c.id || !ids.has(c.id)) acc.commits.push(c);
  acc.commits = acc.commits.slice(-40);
  acc.files = acc.files.filter((f) => !sc.files.includes(f)).concat(sc.files).slice(-40);
  pace.writeJson(side, acc);
  const meta = { session: sid, cwd: input.cwd, saved: new Date(nowMs).toISOString(), lastPromptTs: sc.lastPromptTs,
    prompts: sc.prompts, commits: acc.commits, files: acc.files, todos: sc.todos };
  const md = renderCapped(meta, cfg.handoffMaxTokens || 1500);
  fs.writeFileSync(sessionFile(sid), md);
  fs.writeFileSync(latestFile(input.cwd), md);
  const cf = sessionFile(sid, true);
  const ct = mtime(cf);
  if (ct !== null && (mtime(latestFile(input.cwd, true)) || 0) < ct) {
    fs.copyFileSync(cf, latestFile(input.cwd, true));
    fs.writeFileSync(latestFile(input.cwd, true) + '.from', sid); // which session wrote the copied note (read by pick for from_session)
  }
  prune(dir, nowMs);
  return { file: sessionFile(sid), tokens: estimateTokens(md) };
}

// Pick which note to inject. Returns {file, kind: 'claude'|'auto', fallback} or null.
// After /clear only a fresh Claude-written note counts: the user cleared on purpose,
// so replaying the auto note would drag the old topic back in.
function pick(sid, cwd, nowMs, source) {
  const clearOnly = source === 'clear';
  const tryPair = (autoF, claudeF, maxAgeSec) => {
    const auto = readText(autoF);
    const cl = readText(claudeF);
    const meta = parseMeta(auto);
    if (cl !== null) {
      const ct = mtime(claudeF);
      if (!meta || meta.lastPromptTs === null || ct >= meta.lastPromptTs) {
        const age = clearOnly ? CLEAR_MAX_AGE_SEC : maxAgeSec;
        if (!age || nowMs - ct <= age * 1000) return { file: claudeF, kind: 'claude', text: cl };
      }
    }
    if (auto !== null && !clearOnly) {
      if (!maxAgeSec || nowMs - mtime(autoF) <= maxAgeSec * 1000) return { file: autoF, kind: 'auto', text: auto };
    }
    return null;
  };
  const own = tryPair(sessionFile(sid), sessionFile(sid, true), 0);
  if (own) return Object.assign(own, { fallback: false, from: safeId(sid) });
  const lat = tryPair(latestFile(cwd), latestFile(cwd, true), FALLBACK_MAX_AGE_SEC);
  if (!lat) return null;
  // Session the note belongs to: auto note carries it in its meta, a Claude note in the .from sidecar written by runStop.
  const meta = lat.kind === 'auto' ? parseMeta(lat.text) : null;
  const side = lat.kind === 'claude' ? (readText(lat.file + '.from') || '').trim() : '';
  return Object.assign(lat, { fallback: true, from: (meta && meta.session) || side || null });
}

function additionalContext(p) {
  return HEADER + '\n' + stripMeta(p.text);
}

function runStart(input, nowMs) {
  const cfg = pace.loadConfig();
  if (cfg.handoff === false) return '';
  if (input.source !== 'compact' && input.source !== 'clear') return '';
  const p = pick(safeId(input.session_id), input.cwd, nowMs || Date.now(), input.source);
  if (!p) return '';
  pace.appendEvent({ event: 'handoff_restore', session: input.session_id, source: input.source, kind: p.kind, fallback: p.fallback,
    from_session: input.source === 'clear' ? (p.from || null) : undefined });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: additionalContext(p) } });
}

function run(raw) {
  const input = JSON.parse(raw);
  if (input.hook_event_name === 'Stop') { runStop(input); return ''; }
  if (input.hook_event_name === 'SessionStart') return runStart(input);
  return '';
}

module.exports = { scan, render, renderCapped, parseMeta, pick, additionalContext, runStop, runStart, run, sessionFile, latestFile, dirOf, cwdHash, safeId, prune, HEADER };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try { if (!pace.skipHook(JSON.parse(raw), pace.loadConfig())) { const o = run(raw); if (o) process.stdout.write(o); } } catch (e) { /* silent */ }
    process.exit(0);
  });
}
