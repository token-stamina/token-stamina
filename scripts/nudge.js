'use strict';
// UserPromptSubmit / SessionStart hook: one-line additionalContext when the grade changes.
const path = require('path');
const pace = require('./pace');
const langmod = require('./lang');

const MSG = {
  en: {
    red7: (a) => `Token Stamina: weekly usage ${Math.round(a.d7.used)}% is over pace; today's share is ${pace.fmt1(a.quota)}% (resets ${pace.fmtReset(a.d7.resetsAt, 'en')}). Use Sonnet/Haiku for subagents and keep big outputs in subagents.`,
    red5: (a) => `Token Stamina: 5-hour window ${Math.round(a.h5.used)}% used (resets ${pace.fmtClock(a.h5.resetsAt)}). Defer big tasks until after the reset or run subagent work on Haiku/Sonnet.`,
    yellow: (a) => `Token Stamina: slightly over pace (${a.worst}); prefer Sonnet/Haiku for routine subagent work.`,
  },
  ko: {
    red7: (a) => `Token Stamina: 주간 ${Math.round(a.d7.used)}% 로 오늘 몫(${pace.fmt1(a.quota)}%)을 넘었어요 (리셋 ${pace.fmtReset(a.d7.resetsAt, 'ko')}). 하위 작업은 Sonnet/Haiku, 큰 출력은 하위 에이전트에.`,
    red5: (a) => `Token Stamina: 5시간 창 ${Math.round(a.h5.used)}% 사용 (리셋 ${pace.fmtClock(a.h5.resetsAt)}). 큰 작업은 리셋 뒤로 미루거나 하위 작업을 Haiku/Sonnet 으로.`,
    yellow: (a) => `Token Stamina: 속도가 약간 빨라요(${a.worst}). 반복 하위 작업은 Sonnet/Haiku 로.`,
  },
};

function message(a, lang) {
  const m = MSG[lang] || MSG.en;
  if (a.grade === 'red') return (a.worst === '5h' ? m.red5 : m.red7)(a);
  if (a.grade === 'yellow') return m.yellow(a);
  return null;
}

// Pure: returns {text|null, grade} given the previous grade recorded for this session.
// Nudges only on a grade change (green is recorded silently); SessionStart repeats a red line.
function decide(input, state, cfg, now, last) {
  if (cfg.nudge === false) return { text: null, grade: last };
  const a = pace.assess(state, now, cfg);
  if (!a.grade || a.stale) return { text: null, grade: last };
  const changed = a.grade !== last;
  const sessionRed = input.hook_event_name === 'SessionStart' && a.grade === 'red';
  if (!changed && !sessionRed) return { text: null, grade: a.grade };
  return { text: message(a, cfg.lang), grade: a.grade, worst: a.worst };
}

// --- Stage 0: ask Claude (desktop only) to sync the usage record via get_usage -> sync-usage.js ---
// Neutral wording (W7 #8): the hint says what the call does; it never asks Claude to keep anything from the user.
// HEAD.stale(age) when a record exists, HEAD.none when there is none yet (W7 #9: no "none h old").
const SYNC_HEAD = {
  ko: { stale: (age) => `Token Stamina: 한도 기록이 ${age}시간 전 것이에요.`, none: 'Token Stamina: 아직 한도 기록이 없어요.' },
  en: { stale: (age) => `Token Stamina: the usage record is ${age}h old.`, none: 'Token Stamina: there is no usage record yet.' },
  ja: { stale: (age) => `Token Stamina: 使用量の記録が${age}時間前のものです。`, none: 'Token Stamina: 使用量の記録はまだありません。' },
};
// The 5h window is fresh but the weekly (7d) one is missing or stale: the hint names the weekly record.
const SYNC_HEAD_7D = {
  ko: { stale: (age) => `Token Stamina: 주간(7d) 한도 기록이 ${age}시간 전 것이에요.`, none: 'Token Stamina: 주간(7d) 한도 기록이 없어요.' },
  en: { stale: (age) => `Token Stamina: the weekly (7d) usage record is ${age}h old.`, none: 'Token Stamina: there is no weekly (7d) usage record.' },
  ja: { stale: (age) => `Token Stamina: 週間(7d)の使用量の記録が${age}時間前のものです。`, none: 'Token Stamina: 週間(7d)の使用量の記録がありません。' },
};
// Age of the 7d window from its own recorded_at (never the top-level time, which a 5h-only write bumps). null when the
// window or its stamp is missing, or the stamp is more than 120 s ahead (clock went backwards): unknown.
function syncAgeSec(state, now) {
  const w = state && state.seven_day;
  const t = w && w.recorded_at;
  if (!Number.isFinite(t) || t > now + 120) return null;
  return Math.max(0, now - t);
}
const SYNC_BODY = {
  ko: (root) => ` 이 세션에서 한 번, mcp__ccd_session_mgmt__get_usage 도구가 있으면 불러서 결과 JSON 을 그대로 \`node "${root}/scripts/sync-usage.js"\` 의 stdin 으로 넘기면 기록이 새로 고쳐져요. 도구가 없으면 건너뛰면 돼요.`,
  en: (root) => ` Once in this session, if the tool mcp__ccd_session_mgmt__get_usage exists, calling it and piping its JSON result unchanged into \`node "${root}/scripts/sync-usage.js"\` (stdin) refreshes the record. If the tool does not exist, skip this.`,
  ja: (root) => ` このセッションで一度、mcp__ccd_session_mgmt__get_usage ツールがあれば呼び出し、結果の JSON をそのまま \`node "${root}/scripts/sync-usage.js"\` の stdin に渡すと記録が更新されます。ツールがなければ省略してかまいません。`,
};
// Answers from the app that sync-usage.js remembers in last_reject (status:*, invalid:*, no_window): back off on all of them.
const BACKOFF_RE = /^(status:|invalid:|no_window$)/;

function isDesktop(env) {
  const e = env || {};
  return e.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop' || !!e.CLAUDE_CODE_DESKTOP_APP_VERSION;
}

// Pure. a = pace.assess(state) plus optional a.ageSec (age of the 7d window, syncAgeSec); book = usage-sync.json.
// Freshness is per window: a fresh 5h next to a missing or stale 7d (a.d7 null) still asks for a sync, because the
// weekly window is the one the pacing grade depends on (reason 'no_7d' / 'stale_7d').
function syncHint(input, a, cfg, now, book, env, root) {
  if (cfg.usageSync === false) return { text: null, reason: 'disabled' };
  if (!input || input.hook_event_name !== 'SessionStart') return { text: null, reason: 'event' };
  if (!isDesktop(env)) return { text: null, reason: 'not_desktop' };
  const noState = !a || a.grade === null || a.grade === undefined;
  const miss7 = !noState && !a.stale && !a.d7;
  if (!noState && !a.stale && !miss7) return { text: null, reason: 'fresh' };
  const b = book || {};
  const cool = Number.isFinite(cfg.usageSyncHintCooldownSec) ? cfg.usageSyncHintCooldownSec : 900;
  if (Number.isFinite(b.hinted_at) && now - b.hinted_at < cool) return { text: null, reason: 'cooldown' };
  const naSec = Number.isFinite(cfg.usageSyncNaBackoffSec) ? cfg.usageSyncNaBackoffSec : 86400;
  const lr = b.last_reject;
  if (lr && BACKOFF_RE.test(String(lr.reason)) && Number.isFinite(lr.ts) && now - lr.ts < naSec) return { text: null, reason: 'na_backoff' };
  const lang = SYNC_HEAD[cfg.lang] ? cfg.lang : 'en';
  const hasAge = !!a && Number.isFinite(a.ageSec);
  const H = miss7 ? SYNC_HEAD_7D[lang] : SYNC_HEAD[lang];
  const head = noState || !hasAge ? H.none : H.stale(String(Math.floor(a.ageSec / 3600)));
  const r = root || process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
  const reason = noState ? 'no_state' : (miss7 ? ((a.staleWindows || []).includes('7d') ? 'stale_7d' : 'no_7d') : 'stale');
  return { text: head + SYNC_BODY[lang](r), reason, age_sec: hasAge ? a.ageSec : null };
}

function run(raw) {
  const input = JSON.parse(raw);
  const event = input.hook_event_name;
  if (event !== 'UserPromptSubmit' && event !== 'SessionStart') return '';
  const cfg = langmod.withLang(pace.loadConfig(), input);
  const file = path.join(pace.home(), 'nudge.json');
  const book = pace.readJson(file, {});
  const sid = input.session_id || 'unknown';
  const last = book[sid] && book[sid].grade;
  const state = pace.readState();
  const nowSec = Math.floor(Date.now() / 1000);
  const d = decide(input, state, cfg, nowSec, last);
  if (d.grade && d.grade !== last) {
    book[sid] = { grade: d.grade, ts: Date.now() };
    const keys = Object.keys(book);
    if (keys.length > 50) keys.sort((x, y) => book[x].ts - book[y].ts).slice(0, keys.length - 50).forEach((k) => delete book[k]);
    pace.writeJson(file, book);
  }
  const parts = [];
  if (d.text) {
    pace.appendEvent({ event: 'nudge', session: sid, hook: event, grade: d.grade, worst: d.worst });
    parts.push(pace.attributed(d.text, cfg.lang, cfg._langAuto));
  }
  if (event === 'SessionStart') {
    const a = pace.assess(state, nowSec, cfg);
    a.ageSec = syncAgeSec(state, nowSec);
    const syncFile = path.join(pace.home(), 'usage-sync.json');
    const sb = pace.readJson(syncFile, {}) || {};
    const h = syncHint(input, a, cfg, nowSec, sb, process.env);
    if (h.text) {
      pace.writeJson(syncFile, Object.assign({}, sb, { hinted_at: nowSec, hinted_session: sid }));
      pace.appendEvent({ event: 'usage_sync_hint', session: sid, reason: h.reason, age_sec: h.age_sec });
      parts.push(h.text);
    }
  }
  if (!parts.length) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: parts.join('\n') } });
}

module.exports = { decide, message, run, isDesktop, syncHint, syncAgeSec };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try { if (!pace.skipHook(JSON.parse(raw), pace.loadConfig())) { const o = run(raw); if (o) process.stdout.write(o); } } catch (e) { /* silent */ }
    process.exit(0);
  });
}
