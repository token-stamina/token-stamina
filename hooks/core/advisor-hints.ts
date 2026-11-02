// Hint follow-through numbers for one window, from the event log and savings.ts (the plugin's own estimate).
// Reads files (through ctx.io); aggregate.ts stays pure and receives the result. Any failure gives zeros.
import * as pricing from './advisor-pricing.ts';
import { readEvents } from './events.ts';
import { compute as savingsCompute } from './savings.ts';
import { MAX_READ_BYTES, type AdvisorCtx } from './advisor-io.ts';
import { defaultDir } from './advisor-scan.ts';
import { baseName, walkJsonl } from './cmd-io.ts';

const OPUS: any = (pricing.TABLE as any)['opus-5-5'];
export const EMPTY = { hint_events: 0, hint_followed: 0, hint_saving_usd: 0, line_usd: 0, overhead_usd: 0 };
const ALERT = new Set(['inline_hint', 'topic_gate', 'boundary', 'topic_check']);

// `unreadSessions`: sessions whose transcript is over 4 MiB. savings.ts cannot open them, so whether their hints were followed is
// unknowable; counting them in the denominator would make the followed share look worse than it is (R2 would then quiet hints that work).
export function countEvents(events: any[], sinceMs: number, untilMs: number, unreadSessions?: Set<string>): number {
  let n = 0;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (!(ALERT.has(e.event) && t >= sinceMs && t <= untilMs)) continue;
    if (unreadSessions && unreadSessions.has(String(e.session))) continue;
    n++;
  }
  return n;
}

// Main transcripts the scan cannot open (over 4 MiB), by session id (the file name).
export async function unreadSessionIds(ctx: AdvisorCtx, dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const f of await walkJsonl(ctx.io, dir)) if (!f.sub && f.size > MAX_READ_BYTES) out.add(baseName(f.path, '.jsonl'));
  return out;
}

const localDate = (ms: number) => {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// Savings are priced with the Opus 5.5 cache-read price (savings' own assumption: dropped context is re-read from cache).
export async function hintStats(ctx: AdvisorCtx, days: number, nowMs: number, dir?: string | null): Promise<typeof EMPTY> {
  try {
    const sinceMs = nowMs - days * 86400000;
    const projects = dir || defaultDir(ctx);
    const all = await readEvents(ctx.io, ctx.home, sinceMs);
    const events = countEvents(all, sinceMs, nowMs, countEvents(all, sinceMs, nowMs) ? await unreadSessionIds(ctx, projects) : undefined);
    if (!events) return Object.assign({}, EMPTY);
    const r: any = await savingsCompute(ctx.io, { since: localDate(sinceMs), projectsDir: projects, home: ctx.home }, ctx.cfg as any);
    return {
      hint_events: events, hint_followed: r.compact.count + r.clear.count,
      hint_saving_usd: (r.compact.tokens + r.clear.tokens) * OPUS.read / 1e6,
      line_usd: r.topic_check_cost.tokens * OPUS.read / 1e6,
      overhead_usd: r.compact.compact_overhead_opus_input_equiv * OPUS.input / 1e6,
    };
  } catch { return Object.assign({}, EMPTY); }
}
