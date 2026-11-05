'use strict';
// Streams a Claude Code transcript (JSONL) of any size and prints a slim copy: only the fields /ts-savings reads
// (usage, ids, timestamps, compact boundaries, Agent tool results). One chunk and one line are in memory at a time,
// so memory stays flat whatever the file size; the work is a single pass.
//
//   node transcript-slim.js <file> [--from <byte>] [--max <bytes>] [--since <epochMs>] [--chat] [--adv] [--tail <bytes>]
//
// --adv prints what the Usage Advisor's scan reads (0.6.8): per call usage, ids, model, timestamps, session id, request id,
// compact boundaries, Agent/Task tool_use (model, description, prompt head) and the first user message (head), so a main
// transcript over 4 MiB is scanned instead of skipped.
//
// --chat prints the conversation instead (only the text of human prompts and assistant answers, for /ts-recall);
// --tail <bytes> starts that far from the end of the file (at the next line start) when --from is not given.
//
// Output is capped (default 3.5 MiB: the mods engine returns at most 4 MiB of stdout). When the cap is reached the last
// line is {"_next":<byte>}: call again with --from <byte> to continue. --since skips assistant rows older than that time.
// Also required by scripts/savings.js (slimLines) so the Node build reads big transcripts the same way.
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

const RELEVANT = /"usage"|"toolUseResult"|"tool_result"|compact_boundary|"isCompactSummary"/;
const CHUNK = 1024 * 1024;
const DEFAULT_MAX = 3.5 * 1024 * 1024;

// --chat: one row per human prompt or assistant answer that carries text (tool calls, results and sidechains are left out).
const CHAT_CAP = 4000;
function chatRow(o) {
  if (!o || (o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta) return null;
  const c = o.message && o.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ');
  if (!text.trim()) return null;
  const out = { type: o.type, message: { role: o.type, content: text.slice(0, CHAT_CAP) } };
  if (o.timestamp) out.timestamp = o.timestamp;
  return out;
}
const CHAT_LINE = /"type":"(?:user|assistant)"/;

// --adv: the rows core/advisor-scan.ts parseTranscript reads (same field names, so the same parser takes the output).
const ADV_LINE = /"usage"|"tool_use"|compact_boundary/;
const ADV_USER = /"type"s*:s*"user"/;
const ADV_HEAD = 600;
function advBase(o) {
  const out = { type: o.type };
  if (o.timestamp) out.timestamp = o.timestamp;
  if (typeof o.sessionId === 'string') out.sessionId = o.sessionId;
  if (o.isSidechain) out.isSidechain = true;
  return out;
}
function advRow(o) {
  if (!o || typeof o !== 'object') return null;
  const out = advBase(o);
  if (o.type === 'system' && o.subtype === 'compact_boundary') {
    out.subtype = o.subtype;
    if (o.compactMetadata) out.compactMetadata = { trigger: o.compactMetadata.trigger };
    return out;
  }
  const m = o.message;
  if (!m || typeof m !== 'object') return null;
  const msg = {};
  if (m.id) msg.id = m.id;
  if (typeof m.model === 'string') msg.model = m.model;
  if (m.usage && typeof m.usage === 'object') msg.usage = m.usage;
  if (Array.isArray(m.content)) {
    const tu = m.content.filter((b) => b && b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')).map((b) => {
      const i = b.input && typeof b.input === 'object' ? b.input : {};
      const inp = {};
      if (typeof i.model === 'string') inp.model = i.model;
      if (typeof i.description === 'string') inp.description = i.description;
      if (typeof i.prompt === 'string') inp.prompt = i.prompt.slice(0, ADV_HEAD);
      return { type: 'tool_use', id: b.id, name: b.name, input: inp };
    });
    if (tu.length) msg.content = tu;
  }
  if (!msg.usage && !msg.content) return null;
  if (o.requestId) out.requestId = o.requestId;
  out.message = msg;
  return out;
}
function advUser(o) {
  const out = advBase(o);
  const c = o.message && o.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(' ');
  out.message = { content: text.slice(0, ADV_HEAD) };
  return out;
}
function parseLine(line) {
  try { return JSON.parse(line); } catch (e) { return null; }
}
// The slim row of one line for the given kind ('slim' | 'chat' | 'adv'), or null. st carries what must be seen once (adv: first user row).
function rowOf(kind, line, st, sinceMs) {
  if (kind === 'chat') {
    if (!CHAT_LINE.test(line) || line.includes('"tool_result"')) return null;
    const c = chatRow(parseLine(line));
    if (c && sinceMs && c.type === 'assistant' && c.timestamp && Date.parse(c.timestamp) < sinceMs) return null;
    return c;
  }
  if (kind === 'adv') {
    const wantUser = !st.firstUser && ADV_USER.test(line);
    if (!wantUser && !ADV_LINE.test(line)) return null;
    const o = parseLine(line);
    if (!o) return null;
    if (wantUser && o.type === 'user') { st.firstUser = true; return advUser(o); }
    return advRow(o);
  }
  if (!RELEVANT.test(line)) return null;
  const s = slim(parseLine(line));
  if (s && sinceMs && s.type === 'assistant' && s.timestamp && Date.parse(s.timestamp) < sinceMs) return null;
  return s;
}

const TUR_KEEP = ['usage', 'resolvedModel', 'status', 'agentId'];

// The part of one transcript row that the savings estimate uses; null for a row that carries nothing of it.
function slim(o) {
  if (!o || typeof o !== 'object') return null;
  const out = { type: o.type };
  if (o.uuid) out.uuid = o.uuid;
  if (o.timestamp) out.timestamp = o.timestamp;
  if (o.isSidechain) out.isSidechain = true;
  if (o.type === 'assistant' && o.message && o.message.usage) {
    const m = o.message;
    out.message = { id: m.id, model: m.model, usage: m.usage };
    if (Array.isArray(m.content)) out.message.content = m.content.filter((b) => b && b.type === 'tool_use' && b.id).map((b) => ({ type: 'tool_use', id: b.id }));
    return out;
  }
  if (o.type === 'system' && o.subtype === 'compact_boundary') {
    out.subtype = o.subtype;
    if (o.compactMetadata) out.compactMetadata = o.compactMetadata;
    return out;
  }
  if (o.type === 'user') {
    if (o.isCompactSummary) {
      out.isCompactSummary = true;
      if (o.message) out.message = { content: o.message.content };
      return out;
    }
    const c = o.message && o.message.content;
    if (Array.isArray(c)) {
      const res = c.filter((b) => b && b.type === 'tool_result').map((b) => ({ type: 'tool_result', tool_use_id: b.tool_use_id }));
      if (!res.length) return null;
      out.message = { content: res };
      if (o.toolUseResult && typeof o.toolUseResult === 'object') {
        const t = {};
        for (const k of TUR_KEEP) if (o.toolUseResult[k] !== undefined) t[k] = o.toolUseResult[k];
        out.toolUseResult = t;
      }
      return out;
    }
  }
  return null;
}

// Calls onLine(slimJson) for each relevant row from byte `from` on, in order. Stops early when onLine returns false and
// then returns the byte offset of the row that was not taken (the place to continue); returns -1 at the end of the file.
function eachSlim(file, from, sinceMs, onLine, mode) {
  const kind = mode === 'adv' ? 'adv' : mode ? 'chat' : 'slim';
  const st = { firstUser: false };
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = from || 0;
    let carry = Buffer.alloc(0);
    let carryAt = pos; // file offset of carry[0]
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let start = 0;
      for (;;) {
        const nl = data.indexOf(10, start);
        if (nl < 0) break;
        const at = carryAt + start;
        const line = data.toString('utf8', start, nl);
        start = nl + 1;
        if (!line) continue;
        const s = rowOf(kind, line, st, sinceMs);
        if (!s) continue;
        if (onLine(JSON.stringify(s)) === false) return at;
      }
      carry = data.subarray(start);
      carryAt += start;
    }
    if (carry.length) {
      const line = carry.toString('utf8');
      const s = rowOf(kind, line, st, sinceMs);
      if (s) onLine(JSON.stringify(s));
    }
    return -1;
  } finally {
    fs.closeSync(fd);
  }
}

// Whole slim text of a file for the Node build (no output cap; the caller parses it as JSONL).
function slimText(file, sinceMs) {
  const parts = [];
  eachSlim(file, 0, sinceMs, (l) => { parts.push(l); });
  return parts.join('\n');
}

// The byte offset of the first line start at or after `pos` (pos itself when it is 0 or already starts a line).
function lineStartAtOrAfter(file, pos) {
  if (pos <= 0) return 0;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(65536);
    let at = pos - 1;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, at);
      if (n <= 0) return fs.fstatSync(fd).size;
      const i = buf.subarray(0, n).indexOf(10);
      if (i >= 0) return at + i + 1;
      at += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { slim, chatRow, eachSlim, slimText, lineStartAtOrAfter, DEFAULT_MAX };

if (require.main === module) {
  const a = process.argv.slice(2);
  const file = a[0];
  const opt = (k, d) => { const i = a.indexOf(k); return i > 0 && a[i + 1] !== undefined ? Number(a[i + 1]) : d; };
  if (!file) { process.stderr.write('usage: transcript-slim.js <file> [--from N] [--max N] [--since MS] [--chat] [--adv] [--tail N]\n'); process.exit(2); }
  const max = opt('--max', DEFAULT_MAX);
  let used = 0;
  const chunks = [];
  let next;
  try {
    const chat = a.includes('--adv') ? 'adv' : a.includes('--chat');
    let from = opt('--from', 0);
    if (!from && opt('--tail', 0) > 0) from = lineStartAtOrAfter(file, Math.max(0, fs.statSync(file).size - opt('--tail', 0)));
    next = eachSlim(file, from, opt('--since', 0), (l) => {
      const b = Buffer.byteLength(l) + 1;
      if (used + b > max) return false;
      used += b;
      chunks.push(l);
    }, chat);
  } catch (e) {
    process.stderr.write(String(e && e.message || e) + '\n');
    process.exit(1);
  }
  if (next >= 0) chunks.push(JSON.stringify({ _next: next }));
  process.stdout.write(chunks.join('\n') + '\n');
}
