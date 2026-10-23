'use strict';
// Status line: records rate_limits to state.json, prints one short segment.
// If config.wrap is set, runs that command with the same stdin and prepends its output.
const cp = require('child_process');
const pace = require('./pace');
const langmod = require('./lang');

const { tokLabel } = require('./boundary');

// Current context size: current_usage (input + cache read + cache creation), else total_input_tokens.
function contextTokens(cw) {
  if (!cw) return 0;
  const u = cw.current_usage;
  if (u && typeof u === 'object') {
    const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (n > 0) return n;
  }
  return typeof cw.total_input_tokens === 'number' && cw.total_input_tokens > 0 ? cw.total_input_tokens : 0;
}

const ICON = { green: '🟢', yellow: '🟡', red: '🔴' };

function buildState(input, prev, now) {
  const rl = input && input.rate_limits;
  const next = Object.assign({}, prev || {});
  let changed = false;
  if (rl) {
    for (const k of ['seven_day', 'five_hour']) {
      const w = rl[k];
      if (w && typeof w.used_percentage === 'number' && typeof w.resets_at === 'number') {
        next[k] = { pct: w.used_percentage, resets_at: w.resets_at };
        changed = true;
      }
    }
  }
  if (changed) next.recorded_at = now;
  return { state: next, changed };
}

function segment(input, state, now, cfg) {
  const lang = cfg.lang || 'en';
  const L = ({
    ko: { today: '오늘 몫', reset: '리셋', empty: '소진 예상', turn: '턴' },
    ja: { today: '今日の枠', reset: 'リセット', empty: '枯渇予想', turn: 'ターン' },
  })[lang] || { today: 'today', reset: 'reset', empty: 'empty', turn: 'turn' };
  const parts = [];
  const a = pace.assess(state, now, cfg);
  if (a.d7) {
    parts.push(`7d ${Math.round(a.d7.used)}%`);
    parts.push(`${L.today} ${pace.fmt1(a.quota)}% ${ICON[a.grade] || ''}`.trim());
    parts.push(`${L.reset} ${pace.fmtReset(a.d7.resetsAt, lang)}`);
  } else if (a.h5) {
    parts.push(`${ICON[a.grade] || ''}`);
  }
  if (a.h5 && (a.h5.used >= (cfg.fiveHourShowAt || 80) || a.exhaust5h)) {
    let s = `5h ${Math.round(a.h5.used)}%`;
    if (a.exhaust5h) s += ` → ${pace.fmtClock(a.exhaust5h)} ${L.empty} · ${L.reset} ${pace.fmtClock(a.h5.resetsAt)}`;
    parts.push(s);
  }
  const cw = input && input.context_window;
  const ctx = cw && cw.used_percentage;
  const tok = contextTokens(cw);
  let c = '';
  if (typeof ctx === 'number') c = `ctx ${Math.round(ctx)}%`;
  if (tok) {
    // ASCII unit on purpose: some terminals mis-measure the width of 만 in the status line and garble it.
    const per = `${tokLabel(tok, 'en')}/${L.turn}`;
    c = c ? `${c} (${per})` : `ctx (${per})`;
    if (tok >= pace.thresholds(cfg).compactAt) c += ' 🔴';
    else if (tok >= (cfg.turnCostYellowTokens || 100000)) c += ' 🟡';
  }
  if (c) parts.push(c);
  return parts.filter(Boolean).join(' · ');
}

function run(raw) {
  let input = {};
  try { input = JSON.parse(raw) || {}; } catch (e) { /* ignore */ }
  const now = Math.floor(Date.now() / 1000);
  const cfg = langmod.withLang(pace.loadConfig(), input);
  let state = pace.readState();
  try {
    const r = buildState(input, state, now);
    state = r.state;
    if (r.changed) pace.writeState(state);
  } catch (e) { /* ignore */ }
  let ours = '';
  try { ours = segment(input, state, now, cfg); } catch (e) { /* ignore */ }
  let wrapped = '';
  if (cfg.wrap) {
    try {
      const r = cp.spawnSync(cfg.wrap, { input: raw, shell: true, encoding: 'utf8', timeout: 3000 });
      wrapped = (r.stdout || '').replace(/\s+$/, '');
    } catch (e) { /* ignore */ }
  }
  if (wrapped && ours) return wrapped + ' │ ' + ours;
  return wrapped || ours;
}

module.exports = { buildState, segment, run, contextTokens };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try { process.stdout.write(run(raw)); } catch (e) { /* silent */ }
    process.exit(0);
  });
}
