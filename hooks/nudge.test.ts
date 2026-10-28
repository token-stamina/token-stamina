// Ported from test/pacer.test.js's nudge.decide/nudge.run fixtures (lines 139-169). The legacy
// `nudge.run(raw)` is impure (reads stdin, pace.loadConfig/readState/readJson/writeJson/
// appendEvent, lang.withLang, pace.attributed) -- NOT ported here, that is register.ts's job
// (desktop-only, unverified on this PC). `decide()` itself was already pure in the original (see
// hooks/core/nudge.ts's header) so every `nudge.decide(...)` fixture ports with an unchanged
// signature; only the "run() persists per-session grade" test (line 162) is legacy-run-only and
// is skipped here for that reason.

import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { decide, syncHint, isDesktop, type NudgeCfg } from './core/nudge.ts';

const NOW = 1_800_000_000;
// Default config.default.json values relevant to pace grading / nudge wording (lang: 'auto'
// falls back to the English message table, matching the legacy test's un-set TOKEN_STAMINA_HOME).
const cfg: NudgeCfg = {
  yellowMargin: 10,
  redAt: 90,
  floors: { '5h': { yellow: 25, red: 50 }, '7d': { yellow: 0, red: 0 } },
  fiveHourShowAt: 80,
  stateMaxAgeSec: 21600,
};

const week = (u: number, e: number) => ({ pct: u, resets_at: NOW + Math.round(7 * 86400 * (1 - e)) });
const five = (u: number, e: number) => ({ pct: u, resets_at: NOW + Math.round(5 * 3600 * (1 - e)) });
const st = (d7: ReturnType<typeof week>, h5?: ReturnType<typeof five>) => ({ seven_day: d7, five_hour: h5, recorded_at: NOW });

test('nudge: only on grade change, once per grade', () => {
  const ev = { hook_event_name: 'UserPromptSubmit' };
  const g = st(week(40, 0.5));
  const y = st(week(55, 0.5));
  const r = st(week(80, 0.5));
  assert.equal(decide(ev, g, cfg, NOW, undefined).text, null); // first green: silent
  const d1 = decide(ev, y, cfg, NOW, 'green');
  assert.ok(d1.text);
  assert.equal(decide(ev, y, cfg, NOW, d1.grade).text, null); // duplicate suppressed
  const d2 = decide(ev, r, cfg, NOW, 'yellow');
  assert.ok(d2.text);
  assert.equal(decide(ev, r, cfg, NOW, 'red').text, null);
  assert.equal(decide(ev, g, cfg, NOW, 'red').text, null); // back to green: silent
});

test('nudge: SessionStart repeats red; messages distinguish windows', () => {
  const r = st(week(80, 0.5));
  assert.ok(decide({ hook_event_name: 'SessionStart' }, r, cfg, NOW, 'red').text);
  const m7 = decide({ hook_event_name: 'UserPromptSubmit' }, r, cfg, NOW, 'green').text;
  const m5 = decide({ hook_event_name: 'UserPromptSubmit' }, st(week(10, 0.5), five(95, 0.5)), cfg, NOW, 'green').text;
  assert.ok(m7 && /weekly/.test(m7) && m5 && /5-hour/.test(m5));
});

test('nudge: cfg.nudge === false silences everything, regardless of state/grade', () => {
  const r = st(week(80, 0.5));
  const off: NudgeCfg = { ...cfg, nudge: false };
  const d = decide({ hook_event_name: 'UserPromptSubmit' }, r, off, NOW, 'green');
  assert.deepEqual(d, { text: null, grade: 'green' });
});

test('nudge: no grade (stale or unusable state) passes through the previous grade untouched', () => {
  const stale = { seven_day: week(80, 0.5), recorded_at: NOW - 999999 };
  const d = decide({ hook_event_name: 'UserPromptSubmit' }, stale, cfg, NOW, 'green');
  assert.deepEqual(d, { text: null, grade: 'green' });
});

// NOTE: the legacy "nudge: run() persists per-session grade" test (pacer.test.js line 162) is
// impure end-to-end (pace.writeState + nudge.run reading/writing state.json) and is not portable
// here -- that persistence loop is register.ts's job.

// ---- W2: stage-0 usage-sync hint (syncHint is pure; env injected) ----
const DESK = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' };
const SS = { hook_event_name: 'SessionStart' };
const stale7 = { grade: 'green', stale: true, ageSec: 7 * 3600 };
const R = '/plug';

test('syncHint: desktop + stale -> text in ko/en/ja with age 7', () => {
  for (const lang of ['ko', 'en', 'ja']) {
    const h = syncHint(SS, stale7, { ...cfg, lang }, NOW, {}, DESK, R);
    assert.equal(h.reason, 'stale');
    assert.ok(h.text && h.text.includes('/plug/scripts/sync-usage.js') && h.text.includes('mcp__ccd_session_mgmt__get_usage') && h.text.includes('7'), lang);
  }
});
test('syncHint: no_state uses none-word; fresh/cli/other-event/disabled -> null', () => {
  assert.ok(syncHint(SS, { grade: null }, { ...cfg, lang: 'ko' }, NOW, {}, DESK, R).text!.includes('아직 한도 기록이 없어요'));
  assert.ok(syncHint(SS, { grade: null }, { ...cfg, lang: 'en' }, NOW, {}, DESK, R).text!.includes('there is no usage record yet'));
  assert.equal(syncHint(SS, { grade: 'green', stale: false, d7: { used: 10 }, ageSec: 3600 }, cfg, NOW, {}, DESK).text, null);
  const cli = syncHint(SS, stale7, cfg, NOW, {}, { CLAUDE_CODE_ENTRYPOINT: 'cli' });
  assert.deepEqual([cli.text, cli.reason], [null, 'not_desktop']);
  assert.ok(syncHint(SS, stale7, cfg, NOW, {}, { CLAUDE_CODE_DESKTOP_APP_VERSION: '3.6556.2' }).text);
  assert.equal(syncHint({ hook_event_name: 'UserPromptSubmit' }, stale7, cfg, NOW, {}, DESK).text, null);
  assert.equal(syncHint({ hook_event_name: 'SessionStart', source: 'compact' } as any, stale7, cfg, NOW, {}, DESK).reason, 'stale');
  assert.equal(syncHint(SS, stale7, { ...cfg, usageSync: false }, NOW, {}, DESK).text, null);
  assert.equal(isDesktop(undefined, undefined), false);
});
test('W7 #8/#9/#10 syncHint (TS): neutral wording, whole no-state sentence, backoff on invalid / no_window', () => {
  for (const lang of ['ko', 'en', 'ja']) for (const a of [stale7, { grade: null }]) {
    const t = syncHint(SS, a, { ...cfg, lang }, NOW, {}, DESK, R).text!;
    assert.ok(!/report|보고|報告|사용자|ユーザー|the user/i.test(t), t);
    assert.ok(!/none|없어요시간|なし時間|undefined|NaN/.test(t), t);
  }
  for (const reason of ['invalid:five_hour', 'no_window']) {
    assert.equal(syncHint(SS, stale7, cfg, NOW, { last_reject: { ts: NOW - 60, reason } }, DESK).reason, 'na_backoff', reason);
  }
});
test('syncHint: cooldown 900s and na backoff 86400s', () => {
  const c = syncHint(SS, stale7, cfg, NOW, { hinted_at: NOW - 600 }, DESK);
  assert.deepEqual([c.text, c.reason], [null, 'cooldown']);
  assert.ok(syncHint(SS, stale7, cfg, NOW, { hinted_at: NOW - 901 }, DESK).text);
  const na = (ts: number) => syncHint(SS, stale7, cfg, NOW, { last_reject: { ts, reason: 'status:not_applicable' } }, DESK);
  assert.equal(na(NOW - 3600).text, null);
  assert.ok(na(NOW - 86401).text);
});
