// Rows for a transcript the mod cannot read (over 4 MiB): rebuilt from $.session.messages({ as: 'api' }).
// An API user message may hold tool_result blocks AND text together (the app adds <system-reminder> text beside a
// result, and a prompt typed during a tool run is merged into the result message). A transcript keeps those as
// separate rows, and every parser here (isRealPrompt, scan, clearedSelf) reads transcript rows, so the message is
// split the same way: runs of tool_result blocks and runs of other blocks, in order.
// A text row split off a mixed message that no one typed (only reminders / app events) is marked isMeta: in a
// transcript it is an attachment, not a prompt, and as a prompt it would cut clearedSelf's "last turn" short.

import { promptBody, promptText } from './handoff.ts';

const isResult = (b: any): boolean => !!b && b.type === 'tool_result';

export function apiRows(msgs: unknown): any[] {
  if (!Array.isArray(msgs)) return [];
  const rows: any[] = [];
  const row = (role: string, content: unknown, extra?: object) => rows.push({ type: role, isSidechain: false, message: { role, content }, ...extra });
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = (m as any).role === 'assistant' ? 'assistant' : 'user';
    const c = (m as any).content;
    if (role !== 'user' || !Array.isArray(c) || !c.some(isResult) || c.every(isResult)) {
      row(role, c);
      continue;
    }
    let i = 0;
    while (i < c.length) {
      const res = isResult(c[i]);
      let j = i;
      while (j < c.length && isResult(c[j]) === res) j++;
      const run = c.slice(i, j);
      if (res) row('user', run);
      else {
        const typed = promptBody(promptText({ message: { content: run } }));
        row('user', run, typed ? undefined : { isMeta: true });
      }
      i = j;
    }
  }
  return rows;
}
