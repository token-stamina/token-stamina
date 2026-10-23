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

function run(raw) {
  const input = JSON.parse(raw);
  const event = input.hook_event_name;
  if (event !== 'UserPromptSubmit' && event !== 'SessionStart') return '';
  const cfg = langmod.withLang(pace.loadConfig(), input);
  const file = path.join(pace.home(), 'nudge.json');
  const book = pace.readJson(file, {});
  const sid = input.session_id || 'unknown';
  const last = book[sid] && book[sid].grade;
  const d = decide(input, pace.readState(), cfg, Math.floor(Date.now() / 1000), last);
  if (d.grade && d.grade !== last) {
    book[sid] = { grade: d.grade, ts: Date.now() };
    const keys = Object.keys(book);
    if (keys.length > 50) keys.sort((x, y) => book[x].ts - book[y].ts).slice(0, keys.length - 50).forEach((k) => delete book[k]);
    pace.writeJson(file, book);
  }
  if (!d.text) return '';
  pace.appendEvent({ event: 'nudge', session: sid, hook: event, grade: d.grade, worst: d.worst });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: pace.attributed(d.text, cfg.lang, cfg._langAuto) } });
}

module.exports = { decide, message, run };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try { if (!pace.skipHook(JSON.parse(raw), pace.loadConfig())) { const o = run(raw); if (o) process.stdout.write(o); } } catch (e) { /* silent */ }
    process.exit(0);
  });
}
