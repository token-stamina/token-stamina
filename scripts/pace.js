'use strict';
// Pure pacing math plus tiny state/config/event helpers. Zero dependencies.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WEEK = 7 * 86400;
const FIVE = 5 * 3600;
const RANK = { green: 0, yellow: 1, red: 2 };

// Data folder. TOKEN_STAMINA_HOME wins; the old name TOKEN_PACER_HOME is still honoured. By default the data lives in
// ~/.claude/token-stamina; when only the old ~/.claude/token-pacer exists it is copied there once (the old folder is
// left alone, so a not-yet-updated install keeps working).
let migrationChecked = false;
function home() {
  if (process.env.TOKEN_STAMINA_HOME) return process.env.TOKEN_STAMINA_HOME;
  if (process.env.TOKEN_PACER_HOME) return process.env.TOKEN_PACER_HOME;
  const dir = path.join(os.homedir(), '.claude', 'token-stamina');
  if (!migrationChecked) {
    migrationChecked = true;
    try {
      const old = path.join(os.homedir(), '.claude', 'token-pacer');
      if (!fs.existsSync(dir) && fs.existsSync(old)) fs.cpSync(old, dir, { recursive: true });
    } catch (e) { /* best effort: start fresh */ }
  }
  return dir;
}

function num(x) {
  return typeof x === 'number' && isFinite(x) ? x : null;
}

// One rate-limit window. w = {pct, resets_at}; returns null when unusable or already reset.
function windowStats(w, windowSec, now, cfg) {
  if (!w) return null;
  const u = num(w.pct), r = num(w.resets_at);
  if (u === null || r === null) return null;
  const remaining = r - now;
  if (remaining <= 0) return null; // window reset since the value was recorded
  const e = Math.min(1, Math.max(0, 1 - remaining / windowSec));
  const margin = (cfg && cfg.yellowMargin) != null ? cfg.yellowMargin : 10;
  const redAt = (cfg && cfg.redAt) != null ? cfg.redAt : 90;
  const expected = e * 100;
  // Floors keep the first minutes of a window from turning red on a few percent (mainly the 5h window).
  const floor = (cfg && cfg.floors && cfg.floors[windowSec === FIVE ? '5h' : '7d']) || {};
  let grade = 'green';
  if (u >= redAt || (u > expected + margin && u >= (floor.red || 0))) grade = 'red';
  else if (u > expected && u >= (floor.yellow || 0)) grade = 'yellow';
  return { used: u, elapsedPct: expected, remainingSec: remaining, resetsAt: r, grade };
}

// Remaining budget split across remaining days (at least 1 day, so the last day gets all of it).
function dailyQuota(used, remainingSec) {
  return Math.max(0, 100 - used) / Math.max(remainingSec / 86400, 1);
}

// Projected time the window hits 100% at the current burn rate, or null if it will not before reset.
function exhaustAt(w, windowSec, now) {
  const s = windowStats(w, windowSec, now);
  if (!s || s.used <= 0) return null;
  const elapsedSec = windowSec - s.remainingSec;
  if (elapsedSec < 60) return null;
  const t = now + ((100 - s.used) / (s.used / elapsedSec));
  return t < s.resetsAt ? Math.round(t) : null;
}

// Overall assessment. The worse window wins; a calm 5h never upgrades a bad 7d.
// Freshness is per window: a window's own recorded_at (else the state's) older than stateMaxAgeSec is stale. When at
// least one usable window is fresh, stale windows are left out entirely (d7/h5 null, listed in staleWindows), so an
// old value can never set the grade next to a fresh one. When every usable window is stale, stale is true as before.
// A time more than 120 s in the future (the clock went backwards since it was written) is unknown, so it counts as old.
function assess(state, now, cfg) {
  if (!state) return { grade: null };
  const maxAge = (cfg && cfg.stateMaxAgeSec) || 21600;
  const top = num(state.recorded_at);
  const isOld = (t) => t !== null && (now - t > maxAge || t - now > 120);
  const ageOf = (w) => (w && num(w.recorded_at) !== null ? w.recorded_at : top);
  let d7 = windowStats(state.seven_day, WEEK, now, cfg);
  let h5 = windowStats(state.five_hour, FIVE, now, cfg);
  if (!d7 && !h5) return { grade: null, stale: isOld(top) };
  const old7 = !!d7 && isOld(ageOf(state.seven_day));
  const old5 = !!h5 && isOld(ageOf(state.five_hour));
  const staleWindows = [];
  let stale = false;
  if ((!d7 || old7) && (!h5 || old5)) stale = true;
  else {
    if (old7) { d7 = null; staleWindows.push('7d'); }
    if (old5) { h5 = null; staleWindows.push('5h'); }
  }
  let grade = 'green', worst = null;
  for (const [name, s] of [['7d', d7], ['5h', h5]]) {
    if (s && RANK[s.grade] > RANK[grade]) { grade = s.grade; worst = name; }
  }
  if (!worst) worst = d7 ? '7d' : '5h';
  return {
    grade, worst, stale, d7, h5, staleWindows,
    quota: d7 ? dailyQuota(d7.used, d7.remainingSec) : null,
    exhaust5h: h5 ? exhaustAt(state.five_hour, FIVE, now) : null,
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

const readState = () => readJson(path.join(home(), 'state.json'), null);
const writeState = (s) => writeJson(path.join(home(), 'state.json'), s);

function appendEvent(ev) {
  try {
    fs.mkdirSync(home(), { recursive: true });
    fs.appendFileSync(path.join(home(), 'events.jsonl'), JSON.stringify(Object.assign({ ts: new Date().toISOString() }, ev)) + '\n');
  } catch (e) { /* never block */ }
}

function loadConfig() {
  const def = readJson(path.join(__dirname, '..', 'config.default.json'), {});
  const user = readJson(path.join(home(), 'config.json'), {});
  return Object.assign({}, def, user);
}

// Hooks stay out of headless runs (SDK / automation) and of cwds the user excluded,
// so bots that drive Claude Code never get Token Stamina lines in their prompts.
function skipHook(input, cfg) {
  const ep = process.env.CLAUDE_CODE_ENTRYPOINT || '';
  if (/^sdk/i.test(ep)) return true;
  const cwd = String((input && input.cwd) || '').toLowerCase();
  const ex = (cfg && Array.isArray(cfg.excludeCwd)) ? cfg.excludeCwd : [];
  return ex.some((x) => x && cwd.includes(String(x).toLowerCase()));
}

// Context thresholds. Order: explicit user config key > scaled from compactWindowTokens > default.
function thresholds(cfg) {
  const user = readJson(path.join(home(), 'config.json'), {}) || {};
  const w = num(cfg && cfg.compactWindowTokens) || num(user.compactWindowTokens);
  const pick = (key, ratio, dflt) => {
    if (num(user[key]) !== null) return user[key];
    if (w) return Math.round(w * ratio);
    return num(cfg && cfg[key]) !== null ? cfg[key] : dflt;
  };
  return { compactAt: pick('compactAtTokens', 0.4, 150000), newAt: pick('newSessionAtTokens', 0.95, 400000), gateAt: pick('gateAtTokens', 0.5, 200000) };
}

const DAYS = { en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], ko: ['일', '월', '화', '수', '목', '금', '토'], ja: ['日', '月', '火', '水', '木', '金', '土'] };
function fmtReset(epoch, lang) {
  const d = new Date(epoch * 1000);
  const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return (DAYS[lang] || DAYS.en)[d.getDay()] + ' ' + hh;
}
function fmtClock(epoch) {
  const d = new Date(epoch * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
const fmt1 = (x) => (Math.round(x * 10) / 10).toString();

// additionalContext is invisible to the user, so when Claude relays a suggestion it must say where it came from.
const ATTRIB = {
  en: ' (When you pass this on to the user, start with "Token Stamina:" so they know it came from the plugin, not from you.)',
  ko: ' (이 내용을 사용자에게 전하거나 버튼·질문으로 만들 때는 "Token Stamina 알림:"으로 시작해 플러그인 제안임을 밝히세요.)',
};
// Languages without a message table get the English line plus a directive to answer the user in their own language.
const LANG_NAME = { ja: 'Japanese', zh: 'Chinese' };
function attributed(text, lang, auto) {
  let out = text + (ATTRIB[lang] || ATTRIB.en);
  if (LANG_NAME[lang]) out += ` Write whatever you tell the user in ${LANG_NAME[lang]}.`;
  else if (auto && lang === 'en') out += " Write whatever you tell the user in the language the user is writing in.";
  return out;
}

module.exports = { skipHook,
  WEEK, FIVE, RANK, home, windowStats, dailyQuota, exhaustAt, assess,
  thresholds, readJson, writeJson, readState, writeState, appendEvent, loadConfig, fmtReset, fmtClock, fmt1, attributed,
};
