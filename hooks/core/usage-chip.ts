// The usage chip in the band above the prompt: one short label with the week's use and today's share, coloured by the
// pace grade, and the longer on-screen block a press prints. Pure: the numbers come from pacer.ts (assess), nothing is
// calculated again here.
import { tokLabel } from './boundary.ts';
import { assess, fmt1, fmtReset, fmtClock, type PaceConfig, type PaceState } from './pacer.ts';

export interface DayUse { day: string; pct: number }

const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};

// Per-day growth of the weekly limit, from the recorded pace_sample events (hourly readings): the rise between two
// readings of the same week is counted on the later reading's local day (today is left out: it has its own line). A new week (another reset time), a fall or a
// missing number adds nothing. At most the last 5 days that have a pair; fewer than 2 days means no trend (null).
export function dailyUse(samples: any[], nowMs: number, maxDays = 5): DayUse[] | null {
  const rows = (samples || [])
    .filter((e) => e && e.event === 'pace_sample' && typeof e.week_pct === 'number' && typeof e.week_reset_at === 'number' && Number.isFinite(Date.parse(e.ts)))
    .map((e) => ({ t: Date.parse(e.ts), pct: e.week_pct as number, reset: e.week_reset_at as number }))
    .sort((a, b) => a.t - b.t);
  const days = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!, b = rows[i]!;
    if (Math.abs(a.reset - b.reset) > 120) continue;
    const delta = b.pct - a.pct;
    if (delta < 0) continue;
    const k = localDay(b.t);
    days.set(k, (days.get(k) || 0) + delta);
  }
  days.delete(localDay(nowMs)); // today has its own line
  const out = [...days.entries()].map(([day, pct]) => ({ day, pct: Math.round(pct * 10) / 10 })).slice(-maxDays);
  return out.length >= 2 ? out : null;
}

export interface TodayUse { pct: number; since: string | null }

const hhmm = (ms: number): string => `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`;

// Use since local midnight, in weekly-limit percent: the current reading minus the last reading of the same week taken
// before midnight (at most 18 h before it, so a long unrecorded gap is not counted as today's). Without such a reading
// the base is today's first reading of the week (since = its clock time). No base or a fall -> null (nothing is made up).
export function todayUse(samples: any[], nowMs: number, currentPct: number, resetAt: number): TodayUse | null {
  const mid = new Date(nowMs); mid.setHours(0, 0, 0, 0);
  const m0 = mid.getTime();
  const rows = (samples || [])
    .filter((e) => e && e.event === 'pace_sample' && typeof e.week_pct === 'number' && typeof e.week_reset_at === 'number' && Number.isFinite(Date.parse(e.ts)) && Math.abs(e.week_reset_at - resetAt) <= 120)
    .map((e) => ({ t: Date.parse(e.ts), pct: e.week_pct as number }))
    .sort((a, b) => a.t - b.t);
  let base: { t: number; pct: number } | undefined = rows.filter((r) => r.t < m0 && r.t >= m0 - 18 * 3600 * 1000).pop();
  let since: string | null = null;
  if (!base) {
    base = rows.find((r) => r.t >= m0 && r.t <= nowMs - 5 * 60 * 1000);
    if (base) since = hhmm(base.t);
  }
  if (!base) return null;
  const d = currentPct - base.pct;
  if (d < 0) return null;
  return { pct: Math.round(d * 10) / 10, since };
}

export interface ChipExtra {
  daily?: DayUse[] | null;
  today?: TodayUse | null;
  fleet?: { running: number; models: Record<string, number> } | null;
  ctx?: { tokens: number; clearLine: string; compactLine: string } | null;
}

const MODEL_NAME: Record<string, string> = { F: 'Fable', O: 'Opus', S: 'Sonnet', H: 'Haiku' };

// "2d 5h" / "5h 20m" / "40m": time left until the reset.
export function fmtLeft(secs: number, lang?: string): string {
  const ko = lang === 'ko';
  const m = Math.max(0, Math.round(secs / 60));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return ko ? `${d}일 ${h}시간` : `${d}d ${h}h`;
  if (h > 0) return ko ? `${h}시간 ${mm}분` : `${h}h ${mm}m`;
  return ko ? `${mm}분` : `${mm}m`;
}

export interface UsageChip { label: string; grade: 'green' | 'yellow' | 'red'; lines: string[]; dialog: string }

const COLOR: Record<string, string> = { green: 'green', yellow: 'yellow', red: 'red' };
export const chipColor = (grade: string): string => COLOR[grade] || 'green';

// A plan with no 5-hour or weekly window (0.6.14): no percentage is shown, only the context size and the spend when known.
function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
}
export function noWindowChip(tokens: number, usd: number | null | undefined, lang: string | undefined): UsageChip {
  const ko = lang === 'ko';
  const spend = typeof usd === 'number' && usd > 0 ? ' · $' + usd.toFixed(2) : '';
  const label = (ko ? '주간 한도 없음 · ' : 'no weekly limit · ') + fmtTok(tokens) + (ko ? ' 토큰' : ' tokens') + spend;
  const note = ko ? '이 요금제에는 5시간·주간 한도가 없어요' : 'No 5-hour or weekly limit on this plan';
  const lines = [note, (ko ? '이 대화 맥락: ' : 'This chat context: ') + fmtTok(tokens) + (ko ? ' 토큰' : ' tokens') + spend];
  return { label, grade: 'green', lines, dialog: lines.join('\n') };
}

// null when there is no fresh weekly reading (no chip is drawn then).
export function usageChip(state: PaceState | null | undefined, nowSec: number, cfg: PaceConfig | undefined, lang: string | undefined, extra?: ChipExtra): UsageChip | null {
  const a = assess(state, nowSec, cfg);
  if (!a.grade || a.stale || !a.d7 || a.quota == null) return null;
  const ko = lang === 'ko';
  const used = Math.round(a.d7.used);
  const label = ko ? `주간 한도 ${used}% · 오늘 몫 ${fmt1(a.quota)}%` : `week ${used}% · today ${fmt1(a.quota)}%`;
  const grade = (a.grade as 'green' | 'yellow' | 'red') || 'green';
  const L = ko
    ? { week: '주간', elapsed: '경과', today: '오늘 몫', empty: '소진 예상', none: '리셋 전 소진 없음', reset: '리셋', five: '5시간 창', pace: '페이스' }
    : { week: 'week', elapsed: 'elapsed', today: 'today', empty: 'runs out', none: 'not before the reset', reset: 'resets', five: '5-hour window', pace: 'pace' };
  // Few lines: each $.ui.log call is a row with the plugin's prefix on the terminal.
  const lines = [
    `${L.week}: ${fmt1(a.d7.used)}% / ${L.elapsed} ${fmt1(a.d7.elapsedPct)}% (${L.pace} ${grade}) · ${L.empty}: ${a.exhaust7d ? fmtReset(a.exhaust7d, lang) : L.none}`,
    `${L.reset}: ${fmtReset(a.d7.resetsAt, lang)} · ${L.today}: ${fmt1(a.quota)}%`,
  ];
  if (a.h5) {
    let s = `${L.five}: ${fmt1(a.h5.used)}%`;
    if (a.exhaust5h) s += ` · ${L.empty} ${fmtClock(a.exhaust5h)}`;
    s += ` · ${L.reset} ${fmtClock(a.h5.resetsAt)}`;
    lines.push(s);
  }
  // The press dialog: what the chip is, then the numbers in sentences (the desktop draws no $.ui.log row).
  const gradeWord = ko ? { green: '여유', yellow: '빠듯', red: '초과' }[grade] : { green: 'on track', yellow: 'tight', red: 'over' }[grade];
  const d: string[] = ko
    ? [
        'Token Stamina 사용량 - 주간 한도를 얼마나 썼는지와, 리셋까지 하루에 써도 되는 몫이에요.',
        `주간 한도 ${fmt1(a.d7.used)}% 사용 (기간은 ${fmt1(a.d7.elapsedPct)}% 지남 · 페이스 ${gradeWord}).`,
        a.exhaust7d ? `이 속도면 ${fmtReset(a.exhaust7d, lang)} 에 소진돼요 (리셋 ${fmtReset(a.d7.resetsAt, lang)}).` : `리셋(${fmtReset(a.d7.resetsAt, lang)}) 전에는 소진되지 않아요.`,
        `리셋까지 하루 ${fmt1(a.quota)}% 안에 쓰면 돼요.`,
      ]
    : [
        'Token Stamina usage - how much of the weekly limit is used, and the daily share left until the reset.',
        `Weekly limit ${fmt1(a.d7.used)}% used (${fmt1(a.d7.elapsedPct)}% of the week gone · pace ${gradeWord}).`,
        a.exhaust7d ? `At this pace it runs out ${fmtReset(a.exhaust7d, lang)} (resets ${fmtReset(a.d7.resetsAt, lang)}).` : `It does not run out before the reset (${fmtReset(a.d7.resetsAt, lang)}).`,
        `Use at most ${fmt1(a.quota)}% a day until the reset.`,
      ];
  if (a.h5) d.push(ko ? `5시간 창 ${fmt1(a.h5.used)}% · 리셋 ${fmtClock(a.h5.resetsAt)}` : `5-hour window ${fmt1(a.h5.used)}% · resets ${fmtClock(a.h5.resetsAt)}`);
  const x = extra || {};
  if (x.today) d.push(ko
    ? `오늘 ${x.today.since ? x.today.since + ' 기록 이후 ' : '지금까지 '}${fmt1(x.today.pct)}% 사용 / 오늘 몫 ${fmt1(a.quota)}%`
    : `Today ${x.today.since ? 'since the ' + x.today.since + ' reading: ' : 'so far: '}${fmt1(x.today.pct)}% used / today's share ${fmt1(a.quota)}%`);
  d.push(ko ? `리셋까지 ${fmtLeft(a.d7.resetsAt - nowSec, lang)} 남았어요.` : `${fmtLeft(a.d7.resetsAt - nowSec, lang)} left until the reset.`);
  if (x.daily && x.daily.length >= 2) d.push((ko ? '최근 하루별 사용(주간 한도 %): ' : 'Recent days (weekly limit %): ') + x.daily.map((y) => `${y.day} ${fmt1(y.pct)}`).join(' · '));
  d.push(ko ? '모델별·하위 에이전트 비중은 /ts-report 로 자세히 볼 수 있어요.' : 'Model and subagent shares: see /ts-report.');
  if (x.fleet && x.fleet.running > 0) {
    const fm = x.fleet.models;
    const parts = Object.keys(fm).sort((p, q) => fm[q]! - fm[p]! || p.localeCompare(q)).map((k) => `${MODEL_NAME[k] || k} ${fm[k]}`);
    const tail = parts.length ? ' (' + parts.join(' · ') + ')' : '';
    d.push(ko ? `지금 돌고 있는 하위 에이전트 ${x.fleet.running}개${tail}` : `Subagents running now: ${x.fleet.running}${tail}`);
  }
  if (x.ctx && x.ctx.tokens > 0) {
    d.push(ko ? `지금 대화 크기 약 ${tokLabel(x.ctx.tokens, 'ko')} 토큰` : `This chat is about ${tokLabel(x.ctx.tokens, 'en')} tokens`);
    if (x.ctx.clearLine) d.push(x.ctx.clearLine);
    if (x.ctx.compactLine) d.push(x.ctx.compactLine);
  }
  return { label, grade, lines, dialog: d.join('\n') };
}
