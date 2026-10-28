'use strict';
// Entry B: records the desktop app's usage (mcp__ccd_session_mgmt__get_usage result, JSON on stdin) into state.json,
// because the status line, the only other writer, does not run in the desktop app.
// Contract: DESIGN-v2-integrated.md 4.1. Never throws, always exits 0, prints one line.
const path = require('path');
const pace = require('./pace');

// Rejection reasons that are an app answer (remembered for the hint backoff).
const BACKOFF_RE = /^(status:|invalid:|no_window$)/;
const RESET_MAX = { seven_day: 8 * 86400, five_hour: 5 * 3600 + 600 };

function pctOf(x) {
  return typeof x === 'number' && isFinite(x) && x >= 0 && x <= 100 ? x : null; // out of range: reject, never clamp
}

function resetOf(x) {
  if (typeof x === 'number' && isFinite(x)) return Math.floor(x);
  if (typeof x === 'string') {
    const t = Date.parse(x);
    if (isFinite(t)) return Math.floor(t / 1000);
  }
  return null;
}

function labelKey(label) {
  if (typeof label !== 'string') return null;
  if (/^5[\s-]*hour/i.test(label)) return 'five_hour';
  if (/^weekly/i.test(label) && /all models/i.test(label)) return 'seven_day';
  return undefined; // another window (per-model weekly etc.)
}

// usage (get_usage result or flat {seven_day:{pct,resets_at},five_hour:{...}}) -> accepted windows only.
// Returns {state|null, reason, extra, rejected}; state has no merge with prev.
function fromUsage(usage, nowSec) {
  const out = { state: null, reason: 'parse', extra: [], rejected: [] };
  if (!usage || typeof usage !== 'object') return out;
  const found = {}; // key -> {pct, resets}
  if (usage.plan && typeof usage.plan === 'object') {
    if (usage.plan.status !== 'ok') { out.reason = 'status:' + usage.plan.status; return out; }
    const ws = Array.isArray(usage.plan.windows) ? usage.plan.windows : [];
    for (const w of ws) {
      if (!w || typeof w !== 'object') continue;
      const k = labelKey(w.label);
      if (k === undefined) {
        if (typeof w.label === 'string') out.extra.push({ label: w.label, pct: w.percentUsed });
      } else if (k && !found[k]) found[k] = { pct: w.percentUsed, resets: w.resetsAt };
    }
  } else if (usage.seven_day || usage.five_hour) {
    for (const k of ['seven_day', 'five_hour']) {
      const w = usage[k];
      if (w && typeof w === 'object') found[k] = { pct: w.pct !== undefined ? w.pct : w.used_percentage, resets: w.resets_at };
    }
  } else { out.reason = 'no_window'; return out; }
  const keys = Object.keys(found);
  if (!keys.length) { out.reason = 'no_window'; return out; }
  const state = {};
  for (const k of keys) {
    const pct = pctOf(found[k].pct);
    const r = resetOf(found[k].resets);
    if (pct === null || r === null || !(r > nowSec) || r > nowSec + RESET_MAX[k]) { out.rejected.push(k); continue; }
    state[k] = { pct, resets_at: r };
  }
  if (!Object.keys(state).length) { out.reason = 'invalid:' + out.rejected.join(','); return out; }
  state.recorded_at = nowSec;
  state.source = 'get_usage';
  out.state = state;
  out.reason = 'ok';
  return out;
}

// Window-wise merge of accepted windows over prev. A statusline record newer than 60 s wins (fresher_exists), but
// only when its time is not in the future: a stamp written while the clock ran ahead must not block every sync.
// Every window carries its own recorded_at: a window this response did not update keeps the time it was really
// measured (never "now"), and is dropped when that time is older than maxAgeSec or unknown, so a partial response
// can never make an old value look fresh (W7 R1). Unknown includes a window without its own stamp (0.4.8 and older
// wrote only the top-level recorded_at, which a 5h-only render bumped, so it is not the window's time) and a stamp
// more than FUTURE_SKEW_SEC ahead of now (the clock went backwards).
const MERGE_MAX_AGE = 21600;
const FUTURE_SKEW_SEC = 120;
function windowTime(w, nowSec) {
  if (!w || typeof w.recorded_at !== 'number' || !isFinite(w.recorded_at)) return null;
  return w.recorded_at > nowSec + FUTURE_SKEW_SEC ? null : w.recorded_at;
}
function merge(prev, next, nowSec, maxAgeSec) {
  if (!next) return { state: prev || null, written: false, reason: 'no_state', dropped: [] };
  if (prev && typeof prev.recorded_at === 'number' && prev.recorded_at > nowSec - 60 && prev.recorded_at <= nowSec + 60 && prev.source !== 'get_usage') {
    return { state: prev, written: false, reason: 'fresher_exists', dropped: [] };
  }
  const maxAge = typeof maxAgeSec === 'number' && isFinite(maxAgeSec) && maxAgeSec > 0 ? maxAgeSec : MERGE_MAX_AGE;
  const state = Object.assign({}, prev || {});
  const dropped = [];
  for (const k of ['seven_day', 'five_hour']) {
    if (next[k]) { state[k] = { pct: next[k].pct, resets_at: next[k].resets_at, recorded_at: nowSec }; continue; }
    if (!prev || !prev[k]) { delete state[k]; continue; }
    const t = windowTime(prev[k], nowSec);
    if (t === null || nowSec - t > maxAge) { delete state[k]; dropped.push(k); } else state[k] = Object.assign({}, prev[k], { recorded_at: t });
  }
  state.recorded_at = nowSec;
  state.source = 'get_usage';
  return { state, written: true, reason: 'ok', dropped };
}

function run(raw, nowSec) {
  const now = typeof nowSec === 'number' ? nowSec : Math.floor(Date.now() / 1000);
  const session = process.env.CLAUDE_SESSION_ID || null;
  const syncFile = path.join(pace.home(), 'usage-sync.json');
  let line;
  try {
    let usage = null;
    try { usage = JSON.parse(raw); } catch (e) { /* parse */ }
    const r = fromUsage(usage, now);
    const prev = pace.readState();
    const age = prev && typeof prev.recorded_at === 'number' ? now - prev.recorded_at : null;
    if (!r.state) {
      // Answers the app gave (status:*, a response without the windows we read, out-of-range values) are remembered so
      // nudge.js backs off (usageSyncNaBackoffSec) instead of asking again every cooldown. A parse error is our pipe, not the app.
      if (BACKOFF_RE.test(r.reason)) {
        const book = pace.readJson(syncFile, {}) || {};
        book.last_reject = { ts: now, reason: r.reason };
        pace.writeJson(syncFile, book);
      }
      line = 'rejected: ' + r.reason;
      pace.appendEvent({ event: 'usage_sync', session, ok: false, reason: r.reason, d7: null, h5: null, age_before: age, extra: r.extra });
    } else {
      const m = merge(prev, r.state, now, pace.loadConfig().stateMaxAgeSec);
      if (m.written) {
        pace.writeState(m.state);
        const book = pace.readJson(syncFile, null);
        if (book && book.last_reject) { delete book.last_reject; pace.writeJson(syncFile, book); }
        const bits = [];
        if (r.state.seven_day) bits.push('7d=' + Math.round(r.state.seven_day.pct) + '%');
        if (r.state.five_hour) bits.push('5h=' + Math.round(r.state.five_hour.pct) + '%');
        line = 'recorded ' + bits.join(' ');
      } else line = 'skipped: ' + m.reason;
      const ev = { event: 'usage_sync', session, ok: m.written, reason: m.written ? 'ok' : m.reason,
        d7: r.state.seven_day ? r.state.seven_day.pct : null, h5: r.state.five_hour ? r.state.five_hour.pct : null,
        age_before: age, extra: r.extra };
      if (r.rejected.length) ev.rejected = r.rejected;
      if (m.dropped && m.dropped.length) ev.dropped_stale = m.dropped;
      pace.appendEvent(ev);
    }
  } catch (e) { line = 'rejected: error'; }
  return line;
}

module.exports = { fromUsage, merge, run, labelKey, BACKOFF_RE, FUTURE_SKEW_SEC };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => { process.stdout.write(run(raw) + '\n'); process.exit(0); });
  process.stdin.on('error', () => { process.stdout.write('rejected: parse\n'); process.exit(0); });
}
