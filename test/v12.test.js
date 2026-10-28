'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// W2: stage-0 usage-sync hint in scripts/nudge.js (isDesktop, syncHint, run integration).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nudge = require('../scripts/nudge');

const NOW = 1_800_000_000;
const DESK = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' };
const SS = { hook_event_name: 'SessionStart' };
const stale7 = { grade: 'green', stale: true, ageSec: 7 * 3600 };
const cfg = { lang: 'en' };

test('syncHint ko/en/ja stale desktop', () => {
  for (const lang of ['ko', 'en', 'ja']) {
    const h = nudge.syncHint(SS, stale7, { lang }, NOW, {}, DESK, '/plug');
    assert.equal(h.reason, 'stale');
    assert.ok(h.text.includes('/plug/scripts/sync-usage.js') && h.text.includes('mcp__ccd_session_mgmt__get_usage') && h.text.includes('7'));
  }
});
test('syncHint no_state, fresh, cli, version-only, event, disabled', () => {
  assert.ok(nudge.syncHint(SS, { grade: null }, { lang: 'ko' }, NOW, {}, DESK).text.includes('아직 한도 기록이 없어요'));
  assert.ok(nudge.syncHint(SS, { grade: null }, cfg, NOW, {}, DESK).text.includes('there is no usage record yet'));
  assert.equal(nudge.syncHint(SS, { grade: 'green', stale: false, d7: { used: 10 }, ageSec: 3600 }, cfg, NOW, {}, DESK).text, null);
  assert.deepEqual(nudge.syncHint(SS, stale7, cfg, NOW, {}, { CLAUDE_CODE_ENTRYPOINT: 'cli' }), { text: null, reason: 'not_desktop' });
  assert.ok(nudge.syncHint(SS, stale7, cfg, NOW, {}, { CLAUDE_CODE_DESKTOP_APP_VERSION: '3.6556.2' }).text);
  assert.equal(nudge.syncHint({ hook_event_name: 'UserPromptSubmit' }, stale7, cfg, NOW, {}, DESK).text, null);
  assert.equal(nudge.syncHint({ hook_event_name: 'SessionStart', source: 'compact' }, stale7, cfg, NOW, {}, DESK).reason, 'stale');
  assert.equal(nudge.syncHint(SS, stale7, { usageSync: false }, NOW, {}, DESK).text, null);
});
test('syncHint cooldown and na backoff', () => {
  assert.equal(nudge.syncHint(SS, stale7, cfg, NOW, { hinted_at: NOW - 600 }, DESK).reason, 'cooldown');
  assert.ok(nudge.syncHint(SS, stale7, cfg, NOW, { hinted_at: NOW - 901 }, DESK).text);
  const na = (ts) => nudge.syncHint(SS, stale7, cfg, NOW, { last_reject: { ts, reason: 'status:not_applicable' } }, DESK);
  assert.equal(na(NOW - 3600).text, null);
  assert.ok(na(NOW - 86401).text);
});
test('W7 #8/#9: hint wording is neutral (no "do not report") and the no-state sentence is whole in ko/en/ja', () => {
  for (const lang of ['ko', 'en', 'ja']) {
    for (const a of [stale7, { grade: null }, { grade: null, ageSec: 7200 }]) {
      const t = nudge.syncHint(SS, a, { lang }, NOW, {}, DESK, '/plug').text;
      assert.ok(t, lang);
      assert.ok(!/report|보고|報告|사용자|ユーザー|the user/i.test(t), lang + ': ' + t);
      assert.ok(!/none|없어요시간|なし時間|undefined|NaN|null/.test(t), lang + ': ' + t);
    }
  }
  assert.ok(nudge.syncHint(SS, { grade: null }, { lang: 'ja' }, NOW, {}, DESK).text.includes('記録はまだありません'));
  assert.ok(nudge.syncHint(SS, stale7, { lang: 'ko' }, NOW, {}, DESK).text.includes('7시간 전'));
});

test('W7 #10: an invalid / no_window answer backs off like not_applicable (usageSyncNaBackoffSec)', () => {
  for (const reason of ['invalid:seven_day', 'no_window', 'status:error']) {
    const h = (ts) => nudge.syncHint(SS, stale7, cfg, NOW, { last_reject: { ts, reason } }, DESK);
    assert.equal(h(NOW - 3600).reason, 'na_backoff', reason);
    assert.ok(h(NOW - 86401).text, reason);
  }
  assert.equal(nudge.syncHint(SS, stale7, { lang: 'en', usageSyncNaBackoffSec: 60 }, NOW, { last_reject: { ts: NOW - 120, reason: 'no_window' } }, DESK).reason, 'stale');
  assert.ok(nudge.syncHint(SS, stale7, cfg, NOW, { last_reject: { ts: NOW - 10, reason: 'parse' } }, DESK).text, 'our own pipe error does not back off');
});

test('W7 #10: sync-usage records invalid / no_window in last_reject, so the next hint backs off', () => {
  const su = require('../scripts/sync-usage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-w7-10-'));
  const prev = process.env.TOKEN_STAMINA_HOME;
  process.env.TOKEN_STAMINA_HOME = dir;
  try {
    su.run(JSON.stringify({ plan: { status: 'ok' } }), NOW);
    const b = JSON.parse(fs.readFileSync(path.join(dir, 'usage-sync.json'), 'utf8'));
    assert.match(b.last_reject.reason, /^(no_window|invalid:)/);
    assert.equal(nudge.syncHint(SS, stale7, cfg, NOW + 60, b, DESK).reason, 'na_backoff');
  } finally {
    process.env.TOKEN_STAMINA_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: SessionStart hint is one additionalContext, writes usage-sync.json + event, then cooldown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-w2-'));
  const prevHome = process.env.TOKEN_STAMINA_HOME, prevEp = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.TOKEN_STAMINA_HOME = dir; process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop';
  try {
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ seven_day: { pct: 10, resets_at: now + 3 * 86400 }, recorded_at: now - 7 * 3600 }));
    const raw = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'x' });
    const out = JSON.parse(nudge.run(raw));
    assert.equal(typeof out.hookSpecificOutput.additionalContext, 'string');
    assert.ok(out.hookSpecificOutput.additionalContext.includes('sync-usage.js'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'usage-sync.json'), 'utf8')).hinted_session, 'x');
    assert.ok(/"usage_sync_hint"/.test(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')));
    assert.equal(nudge.run(raw), '');
    assert.equal(nudge.run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'y' })), '');
  } finally {
    if (prevHome === undefined) delete process.env.TOKEN_STAMINA_HOME; else process.env.TOKEN_STAMINA_HOME = prevHome;
    if (prevEp === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = prevEp;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- re-review fixes: clock going backwards (M1), per-window sync hint (L1), measured_at (L2), legacy state (L3) ----
const su = require('../scripts/sync-usage');
const pace = require('../scripts/pace');
const sl = require('../scripts/statusline');
const boardMod = require('../scripts/board');
const H = 3600;
const resp = (w) => ({ plan: { status: 'ok', windows: w } });
const W7r = (p, r) => ({ label: 'Weekly · all models', percentUsed: p, resetsAt: r });
const W5r = (p, r) => ({ label: '5-hour', percentUsed: p, resetsAt: r });

test('M1 (r1 D): a 7d stamp from the future (clock went back) is unknown -> dropped by merge, not kept fresh', () => {
  const prev = { seven_day: { pct: 94, resets_at: NOW + 3 * 86400, recorded_at: NOW + 86400 }, recorded_at: NOW + 86400, source: 'get_usage' };
  const m = su.merge(prev, su.fromUsage(resp([W5r(3, NOW + 4 * H)]), NOW).state, NOW);
  assert.equal(m.state.seven_day, undefined);
  assert.deepEqual(m.dropped, ['seven_day']);
  // within the 120 s skew a stamp is still accepted
  const near = su.merge({ seven_day: { pct: 50, resets_at: NOW + 86400, recorded_at: NOW + 100 }, recorded_at: NOW - 3600, source: 'get_usage' },
    su.fromUsage(resp([W5r(3, NOW + 4 * H)]), NOW).state, NOW);
  assert.equal(near.state.seven_day.pct, 50);
});

test('M1 (r1 F): a future statusline record does not block sync (fresher_exists only for prev <= now+60)', () => {
  const prev = { seven_day: { pct: 94, resets_at: NOW + 3 * 86400, recorded_at: NOW + 86400 }, recorded_at: NOW + 86400, source: 'statusline' };
  const m = su.merge(prev, su.fromUsage(resp([W7r(20, NOW + 3 * 86400), W5r(3, NOW + 4 * H)]), NOW).state, NOW);
  assert.equal(m.written, true);
  assert.equal(m.state.seven_day.pct, 20);
  // a genuinely fresh statusline record (30 s old) still wins
  const fresh = su.merge({ seven_day: { pct: 9, resets_at: NOW + 86400, recorded_at: NOW - 30 }, recorded_at: NOW - 30, source: 'statusline' },
    su.fromUsage(resp([W7r(20, NOW + 3 * 86400)]), NOW).state, NOW);
  assert.equal(fresh.reason, 'fresher_exists');
});

test('M1 (r1 G): assess treats a future-stamped state as stale, never as a fresh red', () => {
  const st = { seven_day: { pct: 94, resets_at: NOW + 3 * 86400, recorded_at: NOW + 86400 }, recorded_at: NOW + 86400 };
  assert.equal(pace.assess(st, NOW + 7 * H, {}).stale, true);
  // a future 7d next to a fresh 5h: the 7d is left out
  const st2 = Object.assign({}, st, { five_hour: { pct: 3, resets_at: NOW + 4 * H, recorded_at: NOW } });
  const a = pace.assess(st2, NOW, {});
  assert.equal(a.d7, null); assert.deepEqual(a.staleWindows, ['7d']); assert.equal(a.grade, 'green');
  // statusline carry: a future-stamped or unstamped 7d is dropped on a 5h-only render
  const b = sl.buildState({ rate_limits: { five_hour: { used_percentage: 3, resets_at: NOW + 4 * H } } }, st, NOW);
  assert.equal(b.state.seven_day, undefined);
});

test('L3 (r1 C): a 0.4.8 state with no per-window stamps -> the 7d time is unknown, dropped (top time is not the 7d time)', () => {
  const prev = { seven_day: { pct: 94, resets_at: NOW + 2 * 86400 }, five_hour: { pct: 3, resets_at: NOW + 4 * H }, recorded_at: NOW - 600 };
  const m = su.merge(prev, su.fromUsage(resp([W5r(3, NOW + 4 * H)]), NOW).state, NOW);
  assert.equal(m.state.seven_day, undefined);
  assert.deepEqual(m.dropped, ['seven_day']);
  assert.equal(pace.assess(m.state, NOW, {}).grade, 'green');
  // statusline over the same legacy state: the unstamped 7d is not re-stamped with the top-level time
  const b = sl.buildState({ rate_limits: { five_hour: { used_percentage: 3, resets_at: NOW + 4 * H } } }, prev, NOW);
  assert.equal(b.state.seven_day, undefined);
});

test('L1: the sync hint fires when 5h is fresh but 7d is missing or stale (per-window), naming the weekly record', () => {
  const st = { five_hour: { pct: 3, resets_at: NOW + 4 * H, recorded_at: NOW }, seven_day: { pct: 50, resets_at: NOW + 2 * 86400, recorded_at: NOW - 10 * H }, recorded_at: NOW };
  const a = pace.assess(st, NOW, {});
  a.ageSec = nudge.syncAgeSec(st, NOW);
  assert.equal(a.ageSec, 10 * H);
  const h = nudge.syncHint(SS, a, cfg, NOW, {}, DESK, '/r');
  assert.equal(h.reason, 'stale_7d');
  assert.ok(h.text.includes('weekly (7d) usage record is 10h old'), h.text);
  const noWeek = pace.assess({ five_hour: st.five_hour, recorded_at: NOW }, NOW, {});
  noWeek.ageSec = nudge.syncAgeSec({ five_hour: st.five_hour, recorded_at: NOW }, NOW);
  const h2 = nudge.syncHint(SS, noWeek, cfg, NOW, {}, DESK, '/r');
  assert.equal(h2.reason, 'no_7d'); assert.ok(h2.text.includes('no weekly (7d)'), h2.text);
  // both fresh -> no hint
  const both = pace.assess(Object.assign({}, st, { seven_day: Object.assign({}, st.seven_day, { recorded_at: NOW }) }), NOW, {});
  assert.equal(nudge.syncHint(SS, both, cfg, NOW, {}, DESK, '/r').reason, 'fresh');
  assert.equal(nudge.syncAgeSec({ seven_day: { recorded_at: NOW + 86400 } }, NOW), null);
});

test('L2: account measured_at is the 7d window\'s own recorded_at, not the top-level time', () => {
  const st = { seven_day: { pct: 40, resets_at: NOW + 2 * 86400, recorded_at: NOW - 5 * H }, five_hour: { pct: 3, resets_at: NOW + 4 * H, recorded_at: NOW }, recorded_at: NOW };
  const acc = boardMod.accountOf(st, pace.assess(st, NOW, {}), NOW);
  assert.equal(acc.measured_at, new Date((NOW - 5 * H) * 1000).toISOString());
  assert.equal(boardMod.accountOf({ five_hour: st.five_hour, recorded_at: NOW }, {}, NOW).measured_at, null);
  assert.equal(boardMod.accountOf({ seven_day: { recorded_at: NOW + 86400 } }, {}, NOW).measured_at, null);
});

test('L4: temp-home helper removes only its own folder when the process exits', () => {
  const { spawnSync } = require('child_process');
  const helper = path.join(__dirname, 'helpers', 'temp-home.js');
  const r = spawnSync(process.execPath, ['-e', `const h=require(${JSON.stringify(helper)});require('fs').writeFileSync(require('path').join(h.HOME,'state.json'),'{}');console.log(h.HOME)`], { encoding: 'utf8' });
  const made = r.stdout.trim();
  assert.ok(path.basename(made).startsWith('ts-home-'), made);
  assert.equal(fs.existsSync(made), false, 'removed on exit');
});
