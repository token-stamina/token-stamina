// The usage chip in the band above the prompt: one short label with the week's use and today's share, coloured by the
// pace grade, and the longer on-screen block a press prints. Pure: the numbers come from pacer.ts (assess), nothing is
// calculated again here.
import { assess, fmt1, fmtReset, fmtClock, type PaceConfig, type PaceState } from './pacer.ts';

export interface UsageChip { label: string; grade: 'green' | 'yellow' | 'red'; lines: string[]; dialog: string }

const COLOR: Record<string, string> = { green: 'green', yellow: 'yellow', red: 'red' };
export const chipColor = (grade: string): string => COLOR[grade] || 'green';

// null when there is no fresh weekly reading (no chip is drawn then).
export function usageChip(state: PaceState | null | undefined, nowSec: number, cfg: PaceConfig | undefined, lang: string | undefined): UsageChip | null {
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
  return { label, grade, lines, dialog: d.join('\n') };
}
