'use strict';
require('./helpers/temp-home'); // isolated data folder before anything reads it
// Entry B (scripts/sync-usage.js): get_usage result on stdin -> state.json. W1 of IMPL-PLAN-v2.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stamina-v11-'));
process.env.TOKEN_STAMINA_HOME = path.join(TMP, 'home');
const sync = require('../scripts/sync-usage');
const statusline = require('../scripts/statusline');
const pace = require('../scripts/pace');

const FIX = path.join(__dirname, 'fixtures', 'usage');
const NOW = Math.floor(Date.parse('2026-10-27T12:00:00Z') / 1000);
const iso = (sec) => new Date(sec * 1000).toISOString();
const W5 = (o) => Object.assign({ label: '5-hour limit', percentUsed: 2, resetsAt: iso(NOW + 3 * 3600) }, o);
const W7 = (o) => Object.assign({ label: 'Weekly · all models', percentUsed: 25, resetsAt: iso(NOW + 5 * 86400) }, o);
const WF = () => ({ label: 'Weekly · Fable', percentUsed: 2, resetsAt: iso(NOW + 5 * 86400) });
const ok = (...ws) => ({ plan: { status: 'ok', windows: ws } });
const stateFile = () => path.join(pace.home(), 'state.json');
const eventsFile = () => path.join(pace.home(), 'events.jsonl');
function reset() { fs.rmSync(pace.home(), { recursive: true, force: true }); }
const events = () => (fs.existsSync(eventsFile()) ? fs.readFileSync(eventsFile(), 'utf8').trim().split('\n').map(JSON.parse) : []);

test('sync: ok response -> both windows, epoch seconds, source, extra', () => {
  const r = sync.fromUsage(ok(W5(), W7(), WF()), NOW);
  assert.equal(r.state.seven_day.pct, 25);
  assert.equal(r.state.five_hour.pct, 2);
  assert.equal(r.state.seven_day.resets_at, NOW + 5 * 86400);
  assert.ok(Number.isInteger(r.state.five_hour.resets_at));
  assert.equal(r.state.source, 'get_usage');
  assert.equal(r.state.recorded_at, NOW);
  assert.deepEqual(r.extra, [{ label: 'Weekly · Fable', pct: 2 }]);
});

test('sync: non-ok status -> null with reason, no state file written', () => {
  reset();
  for (const s of ['not_applicable', 'unavailable']) {
    const r = sync.fromUsage({ plan: { status: s } }, NOW);
    assert.equal(r.state, null);
    assert.equal(r.reason, 'status:' + s);
  }
  const out = sync.run(fs.readFileSync(path.join(FIX, 'na.json'), 'utf8'), NOW);
  assert.equal(out, 'rejected: status:not_applicable');
  assert.equal(fs.existsSync(stateFile()), false);
  const book = JSON.parse(fs.readFileSync(path.join(pace.home(), 'usage-sync.json'), 'utf8'));
  assert.equal(book.last_reject.reason, 'status:not_applicable');
});

test('sync: label variants match; Fable-only weekly gives 5h only', () => {
  const r = sync.fromUsage(ok(W5({ label: '5-Hour Limit' }), W7({ label: 'weekly - ALL MODELS' })), NOW);
  assert.ok(r.state.five_hour && r.state.seven_day);
  const f = sync.fromUsage(ok(W5(), WF()), NOW);
  assert.ok(f.state.five_hour);
  assert.equal(f.state.seven_day, undefined);
  assert.equal(sync.fromUsage(ok(WF()), NOW).reason, 'no_window');
});

test('sync: only weekly in response -> fresh 5h kept from prev with its measured time (window-wise merge)', () => {
  reset();
  // 0.5 writers stamp every window; an unstamped one is unknown and dropped (L3, test/v12 'L3 (r1 C)')
  pace.writeState({ five_hour: { pct: 50, resets_at: NOW + 1000, recorded_at: NOW - 2 * 3600 }, seven_day: { pct: 1, resets_at: NOW + 1000 }, recorded_at: NOW - 2 * 3600 });
  assert.equal(sync.run(JSON.stringify(ok(W7())), NOW), 'recorded 7d=25%');
  const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  assert.equal(s.seven_day.pct, 25);
  assert.equal(s.five_hour.pct, 50);
  assert.equal(s.five_hour.recorded_at, NOW - 2 * 3600);
  assert.equal(s.source, 'get_usage');
});

test('W7 R1: partial response over a 3-day-old 7d 94% -> no red, no downgrade from the old value', () => {
  reset();
  const am = require('../scripts/agent-model');
  pace.writeState({ seven_day: { pct: 94, resets_at: NOW + 3 * 86400 }, five_hour: { pct: 50, resets_at: NOW - 100 }, recorded_at: NOW - 3 * 86400 });
  const out = sync.run(JSON.stringify({ plan: { status: 'ok', windows: [{ label: '5-hour limit', percentUsed: 2, resetsAt: iso(NOW + 3600) }, { label: 'Weekly limit', percentUsed: 20, resetsAt: iso(NOW + 86400) }] } }), NOW);
  assert.equal(out, 'recorded 5h=2%');
  const st = pace.readState();
  assert.equal(st.seven_day, undefined);
  const a = pace.assess(st, NOW, {});
  assert.equal(a.grade, 'green');
  assert.equal(a.d7, null);
  const d = am.decide({ tool_input: { description: 'collect files', prompt: 'x' } }, st, pace.loadConfig(), NOW, {});
  assert.notEqual(d.reason, 'red_downgrade');
  assert.ok(!(d.action === 'inject' && /red/.test(String(d.reason))), JSON.stringify(d));
  const ev = events().pop();
  assert.deepEqual(ev.dropped_stale, ['seven_day']);
});

test('W7 R1: assess ignores a stale window next to a fresh one (per-window recorded_at)', () => {
  const st = { seven_day: { pct: 94, resets_at: NOW + 3 * 86400, recorded_at: NOW - 3 * 86400 }, five_hour: { pct: 2, resets_at: NOW + 3600, recorded_at: NOW }, recorded_at: NOW };
  const a = pace.assess(st, NOW, {});
  assert.equal(a.grade, 'green');
  assert.equal(a.stale, false);
  assert.equal(a.d7, null);
  assert.deepEqual(a.staleWindows, ['7d']);
  // all windows stale -> stale:true like before
  const b = pace.assess({ seven_day: { pct: 94, resets_at: NOW + 86400 }, recorded_at: NOW - 3 * 86400 }, NOW, {});
  assert.equal(b.stale, true);
});

test('sync: past 7d reset rejects that window, 5h recorded, event ok:true with rejected', () => {
  reset();
  const out = sync.run(JSON.stringify(ok(W5(), W7({ resetsAt: iso(NOW - 3600) }))), NOW);
  assert.equal(out, 'recorded 5h=2%');
  const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  assert.equal(s.seven_day, undefined);
  const e = events().pop();
  assert.equal(e.ok, true);
  assert.deepEqual(e.rejected, ['seven_day']);
});

test('sync: out-of-range / non-number pct is rejected, never clamped', () => {
  for (const p of [101, -1, '25', NaN, null]) {
    assert.equal(sync.fromUsage(ok(W7({ percentUsed: p })), NOW).state, null, String(p));
  }
  reset();
  assert.match(sync.run(JSON.stringify(ok(W7({ percentUsed: 101 }))), NOW), /^rejected/);
  assert.equal(fs.existsSync(stateFile()), false);
});

test('sync: reset beyond the cap is rejected (7d +9d, 5h +6h)', () => {
  assert.equal(sync.fromUsage(ok(W7({ resetsAt: iso(NOW + 9 * 86400) })), NOW).state, null);
  assert.equal(sync.fromUsage(ok(W5({ resetsAt: iso(NOW + 6 * 3600) })), NOW).state, null);
});

test('sync: race with the status line', () => {
  const next = sync.fromUsage(ok(W5(), W7()), NOW).state;
  const a = sync.merge({ recorded_at: NOW - 30 }, next, NOW);
  assert.equal(a.written, false);
  assert.equal(a.reason, 'fresher_exists');
  assert.equal(sync.merge({ recorded_at: NOW - 61 }, next, NOW).written, true);
  assert.equal(sync.merge({ recorded_at: NOW - 30, source: 'get_usage' }, next, NOW).written, true);
});

test('sync: flat format is recorded as given', () => {
  reset();
  const out = sync.run(JSON.stringify({ seven_day: { pct: 30, resets_at: NOW + 86400 }, five_hour: { pct: 4, resets_at: NOW + 3600 } }), NOW);
  assert.equal(out, 'recorded 7d=30% 5h=4%');
});

test('sync: garbage / empty stdin -> "rejected: parse", state untouched', () => {
  reset();
  pace.writeState({ recorded_at: 5 });
  const before = fs.readFileSync(stateFile(), 'utf8');
  assert.equal(sync.run('garbage', NOW), 'rejected: parse');
  assert.equal(sync.run('', NOW), 'rejected: parse');
  assert.equal(fs.readFileSync(stateFile(), 'utf8'), before);
});

test('sync: success event shape', () => {
  reset();
  pace.writeState({ recorded_at: NOW - 7 * 3600 });
  sync.run(JSON.stringify(ok(W5(), W7(), WF())), NOW);
  const e = events().pop();
  assert.equal(e.event, 'usage_sync');
  assert.equal(e.ok, true);
  assert.equal(e.d7, 25);
  assert.equal(e.h5, 2);
  assert.equal(e.age_before, 7 * 3600);
});

test('sync: CLI reads stdin, prints one line, exits 0, writes only to TOKEN_STAMINA_HOME', () => {
  const home = path.join(TMP, 'cli-home');
  const real = JSON.parse(fs.readFileSync(path.join(FIX, 'ok.json'), 'utf8'));
  const nowReal = Math.floor(Date.now() / 1000);
  real.plan.windows[0].resetsAt = iso(nowReal + 3600);
  real.plan.windows[1].resetsAt = iso(nowReal + 5 * 86400);
  const script = path.join(__dirname, '..', 'scripts', 'sync-usage.js');
  const env = Object.assign({}, process.env, { TOKEN_STAMINA_HOME: home });
  const r = cp.spawnSync(process.execPath, [script], { input: JSON.stringify(real), encoding: 'utf8', env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'recorded 7d=25% 5h=2%');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).source, 'get_usage');
  const g = cp.spawnSync(process.execPath, [script], { input: '', encoding: 'utf8', env });
  assert.equal(g.status, 0);
  assert.equal(g.stdout.trim(), 'rejected: parse');
});

test('statusline buildState marks its record source:statusline', () => {
  const b = statusline.buildState({ rate_limits: { seven_day: { used_percentage: 5, resets_at: NOW + 100 } } }, { source: 'get_usage' }, NOW);
  assert.equal(b.state.source, 'statusline');
  assert.equal(statusline.buildState({}, { source: 'get_usage' }, NOW).state.source, 'get_usage');
});

test('W7 R1 statusline buildState (JS): partial render never re-stamps the other window', () => {
  // own stamp: carried with its real (old) time, so it stays stale
  const prev = { seven_day: { pct: 94, resets_at: NOW + 3 * 86400, recorded_at: NOW - 3 * 86400 }, recorded_at: NOW - 3 * 86400 };
  const b = statusline.buildState({ rate_limits: { five_hour: { used_percentage: 3, resets_at: NOW + 3600 } } }, prev, NOW);
  assert.equal(b.state.seven_day.recorded_at, NOW - 3 * 86400);
  assert.equal(pace.assess(b.state, NOW, {}).grade, 'green');
  // no own stamp (0.4.8 shape): its time is unknown, so it is dropped rather than given the top-level time (L3)
  const legacy = { seven_day: { pct: 94, resets_at: NOW + 3 * 86400 }, recorded_at: NOW - 3 * 86400 };
  const b2 = statusline.buildState({ rate_limits: { five_hour: { used_percentage: 3, resets_at: NOW + 3600 } } }, legacy, NOW);
  assert.equal(b2.state.seven_day, undefined);
  assert.equal(pace.assess(b2.state, NOW, {}).grade, 'green');
});
