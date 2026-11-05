// The usage chip in the band above the prompt: one short label with the week's use and today's share, coloured by the
// pace grade, and the longer on-screen block a press prints. Pure: the numbers come from pacer.ts (assess), nothing is
// calculated again here.
import { assess, fmt1, fmtReset, fmtClock, type PaceConfig, type PaceState } from './pacer.ts';

export interface UsageChip { label: string; grade: 'green' | 'yellow' | 'red'; lines: string[] }

const COLOR: Record<string, string> = { green: 'green', yellow: 'yellow', red: 'red' };
export const chipColor = (grade: string): string => COLOR[grade] || 'green';

// null when there is no fresh weekly reading (no chip is drawn then).
export function usageChip(state: PaceState | null | undefined, nowSec: number, cfg: PaceConfig | undefined, lang: string | undefined): UsageChip | null {
  const a = assess(state, nowSec, cfg);
  if (!a.grade || a.stale || !a.d7 || a.quota == null) return null;
  const ko = lang === 'ko';
  const used = Math.round(a.d7.used);
  const label = ko ? `주간 ${used}% · 오늘 몫 ${fmt1(a.quota)}%` : `week ${used}% · today ${fmt1(a.quota)}%`;
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
  return { label, grade, lines };
}
