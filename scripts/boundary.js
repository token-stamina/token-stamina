'use strict';
// Stop hook: at a work boundary with a big context, show the user a /compact (or new session) hint.
// Output is `systemMessage` only (user-facing). Never uses decision:"block"; nothing goes into model context.
const fs = require('fs');
const path = require('path');
const pace = require('./pace');
const savings = require('./clear-savings');
const langmod = require('./lang');

const TAIL_BYTES = 256 * 1024;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const GIT_COMMIT = /\bgit(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+commit\b/;

// Read the last `bytes` of a file and parse JSONL lines. The first line is dropped when the read starts mid-file.
function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let lines = buf.toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1);
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch (e) { /* partial or foreign line */ }
    }
    return out;
  } finally { fs.closeSync(fd); }
}

function isRealPrompt(o) {
  if (!o || o.type !== 'user' || o.isSidechain || o.isMeta || !o.message) return false;
  const c = o.message.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  if (c.some((b) => b && b.type === 'tool_result')) return false;
  return c.some((b) => b && b.type === 'text' && String(b.text || '').trim());
}

function contextTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
}

function commitSubject(cmd) {
  const hd = /<<-?\s*['"]?(\w+)['"]?\r?\n\s*([^\r\n]+)/.exec(cmd);
  let s = hd ? hd[2] : null;
  if (!s) {
    const m = /(?:^|\s)-m\s+(?:"([^"\n]*)"|'([^'\n]*)')/.exec(cmd);
    if (m) s = m[1] != null ? m[1] : m[2];
  }
  if (!s) return null;
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

// Pure: entries = parsed transcript lines (tail). Returns {tokens, turnFound, commits[], edited, endsWithAnswer}.
function analyze(entries) {
  let tokens = 0;
  for (const o of entries) {
    if (o.type === 'assistant' && !o.isSidechain && o.message && o.message.usage && o.message.model !== '<synthetic>') {
      const t = contextTokens(o.message.usage);
      if (t > 0) tokens = t;
    }
  }
  let promptIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) if (isRealPrompt(entries[i])) { promptIdx = i; break; }
  const res = { tokens, turnFound: promptIdx >= 0, commits: [], commitCount: 0, edited: false, endsWithAnswer: false };
  if (promptIdx < 0) return res;
  const failed = new Set();
  const calls = [];
  let lastAssistant = null;
  for (let i = promptIdx + 1; i < entries.length; i++) {
    const o = entries[i];
    if (!o || o.isSidechain || !o.message) continue;
    const c = o.message.content;
    if (o.type === 'user' && Array.isArray(c)) {
      for (const b of c) if (b && b.type === 'tool_result' && b.is_error) failed.add(b.tool_use_id);
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      lastAssistant = c;
      for (const b of c) if (b && b.type === 'tool_use') calls.push(b);
    }
  }
  const seen = new Set();
  for (const b of calls) {
    if (b.id) { if (seen.has(b.id)) continue; seen.add(b.id); }
    if (EDIT_TOOLS.has(b.name)) res.edited = true;
    const cmd = b.input && typeof b.input.command === 'string' ? b.input.command : '';
    if (SHELL_TOOLS.has(b.name) && GIT_COMMIT.test(cmd) && !failed.has(b.id)) {
      res.commitCount++;
      const s = commitSubject(cmd);
      if (s && res.commits.length < 2) res.commits.push(s);
    }
  }
  res.endsWithAnswer = !!lastAssistant && !lastAssistant.some((b) => b && b.type === 'tool_use');
  return res;
}

function tokLabel(n, lang) {
  if (lang === 'ko' || lang === 'ja') {
    const ja = lang === 'ja';
    if (n >= 10000) { const v = Math.round(n / 1000) / 10; return (Number.isInteger(v) ? v : v.toFixed(1)) + (ja ? '万' : '만'); }
    return Math.round(n / 1000) + (ja ? '千' : '천');
  }
  return Math.round(n / 1000) + 'k';
}

function message(res, lang, level, cfg, prof) {
  const t = tokLabel(res.tokens, lang);
  const est = savings.hintLine(res.tokens, lang, level === 'new_session' ? 'clear' : 'compact', cfg, prof);
  const tail = est ? ' ' + est : '';
  const fill = res.commits.length ? res.commits.join(' · ') : null;
  if (lang === 'ko') {
    if (level === 'new_session') {
      return `Token Stamina: 컨텍스트 ${t} 토큰 — 매 턴 이만큼 다시 읽어요. 새 세션 권장: 결론·남은 일은 파일에 남기고 새로 시작하세요(/clear 뒤에도 자동 저장된 인계 메모가 복원돼요). 이어 가려면 /compact 만 쳐도 되고, 직접 정하려면 /compact ${fill || '(남길 결정·남은 일)'}${tail}`;
    }
    return `Token Stamina: 컨텍스트 ${t} 토큰 — 매 턴 이만큼 다시 읽어요. 작업이 끝났으면 지금 /compact 하기 좋은 때예요. 그냥 /compact 만 쳐도 돼요(자동 저장된 인계 메모가 복원돼요; 단축키는 /token-stamina:setup). 직접 정하려면: /compact ${fill || '(남길 결정·남은 일)'}${tail}`;
  }
  if (lang === 'ja') {
    if (level === 'new_session') {
      return `Token Stamina: コンテキストは ${t} トークン — 毎ターンこれだけ読み直します。新しいセッションをおすすめします: 結論と残りの作業をファイルに残してから始めてください(/clear の後も自動保存した引き継ぎメモが復元されます)。続けるなら /compact だけでも構いません。残す内容を決めるなら /compact ${fill || '(残す決定・残りの作業)'}${tail}`;
    }
    return `Token Stamina: コンテキストは ${t} トークン — 毎ターンこれだけ読み直します。作業が終わったなら今が /compact のしどきです。/compact だけで構いません(自動保存した引き継ぎメモが復元されます; ショートカットは /token-stamina:setup)。決めるなら: /compact ${fill || '(残す決定・残りの作業)'}${tail}`;
  }
  if (level === 'new_session') {
    return `Token Stamina: context is ${t} tokens, re-read every turn. Starting a new session is recommended: save conclusions and open items to a file first (the auto-saved handoff note is restored after /clear). To continue instead, plain /compact works, or choose what to keep: /compact ${fill || '(decisions to keep · what is left)'}${tail}`;
  }
  return `Token Stamina: context is ${t} tokens, re-read every turn. If the task is done, now is a good time to /compact. Plain /compact is enough (the auto-saved handoff note is restored; keybinding: /token-stamina:setup). To choose what to keep: /compact ${fill || '(decisions to keep · what is left)'}${tail}`;
}

// Pure decision. `last` = tokens at the previous notification for this session (or undefined).
function decide(res, cfg, last) {
  // Screen hint (systemMessage) is opt-in: by default Claude writes the hint in its reply (topic-gate inline hint).
  if (cfg.boundary !== true) return { notify: false, reason: 'off' };
  const { compactAt, newAt } = pace.thresholds(cfg);
  const grow = cfg.renotifyGrowthTokens || 100000;
  if (!res.tokens || res.tokens < compactAt) return { notify: false, reason: 'below_threshold' };
  if (!res.turnFound) return { notify: false, reason: 'no_turn' };
  let kind = null;
  if (res.commitCount > 0) kind = 'commit';
  else if (res.edited && res.endsWithAnswer) kind = 'edit';
  if (!kind) return { notify: false, reason: 'not_boundary' };
  // A smaller context than last time means /compact or a new window happened: start over.
  if (typeof last === 'number' && res.tokens >= last && res.tokens < last + grow) return { notify: false, reason: 'renotify_suppressed' };
  return { notify: true, kind, level: res.tokens >= newAt ? 'new_session' : 'compact' };
}

// The user's own fixed share and auto-compact point for the savings estimate (see clear-savings.profile).
function savingsProfile(input, entries, cfg) {
  const projectsDir = path.dirname(path.dirname(input.transcript_path));
  return savings.profile({ cfg, entries, transcriptPath: input.transcript_path, projectsDir,
    cacheFile: path.join(pace.home(), 'compact-point.json') });
}

function run(raw) {
  const input = JSON.parse(raw);
  if (input.hook_event_name && input.hook_event_name !== 'Stop') return '';
  const cfg = langmod.withLang(pace.loadConfig(), input);
  if (!input.transcript_path) return '';
  const entries = readTail(input.transcript_path, TAIL_BYTES);
  const res = analyze(entries);
  // The transcript is written asynchronously: if its last line is still a tool call but Stop fired with a final
  // message, trust the hook's last_assistant_message for "ended with an answer".
  if (!res.endsWithAnswer && typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()) res.endsWithAnswer = true;
  const file = path.join(pace.home(), 'boundary.json');
  const book = pace.readJson(file, {});
  const sid = input.session_id || 'unknown';
  const d = decide(res, cfg, book[sid] && book[sid].tokens);
  if (!d.notify) return '';
  book[sid] = { tokens: res.tokens, ts: Date.now() };
  const keys = Object.keys(book);
  if (keys.length > 50) keys.sort((x, y) => book[x].ts - book[y].ts).slice(0, keys.length - 50).forEach((k) => delete book[k]);
  pace.writeJson(file, book);
  pace.appendEvent({ event: 'boundary', session: sid, tokens: res.tokens, kind: d.kind, level: d.level, commits: res.commitCount });
  return JSON.stringify({ systemMessage: message(res, cfg.lang || 'en', d.level, cfg, savingsProfile(input, entries, cfg)) });
}

module.exports = { isRealPrompt, readTail, analyze, decide, message, tokLabel, commitSubject, contextTokens, savingsProfile, run };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try { if (!pace.skipHook(JSON.parse(raw), pace.loadConfig())) { const o = run(raw); if (o) process.stdout.write(o); } } catch (e) { /* silent */ }
    process.exit(0);
  });
}
