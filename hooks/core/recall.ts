// /ts-recall and the "previous chat" button: the last turns of the session that was just cleared, from its transcript.
// Pure: rows in, screen lines out. Only the human's words and the assistant's text are kept (no tool calls or results);
// the lines are drawn with $.ui.log, so the model never reads them.
export interface Turn { user: string; claude: string }

export const RECALL_TURNS = 6;
export const RECALL_SEARCH_MAX = 10;
const USER_CAP = 300;
const CLAUDE_CAP = 600;
// Text that is not the human talking: command echoes, injected reminders, interrupts, the compact summary header.
const NOISE = /^\s*(?:<(?:command-|local-command|system-reminder|task-notification)|Caveat:|\[Request interrupted|This session is being continued)/;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join(' ');
}

const flat = (s: string, cap: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > cap ? t.slice(0, cap - 1) + '…' : t;
};

// JSONL text -> rows (a broken line is skipped).
export function parseRows(text: string): any[] {
  const rows: any[] = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { rows.push(JSON.parse(l)); } catch { /* partial line */ }
  }
  return rows;
}

// Transcript rows -> turns: a human prompt and the assistant text that followed it, in order.
export function chatTurns(rows: any[]): Turn[] {
  const turns: Turn[] = [];
  let cur: { user: string; claude: string[] } | null = null;
  const close = () => { if (cur) turns.push({ user: flat(cur.user, USER_CAP), claude: flat(cur.claude.join(' '), CLAUDE_CAP) }); cur = null; };
  for (const r of rows) {
    if (!r || r.isSidechain || r.isMeta || (r.type !== 'user' && r.type !== 'assistant')) continue;
    const text = textOf(r.message && r.message.content);
    if (!text.trim()) continue;
    if (r.type === 'user') {
      if (NOISE.test(text)) continue;
      close();
      cur = { user: text, claude: [] };
    } else if (cur) {
      cur.claude.push(text);
    }
  }
  close();
  return turns;
}

export function recallLines(turns: Turn[], lang: string, query: string, n = RECALL_TURNS): string[] {
  const ko = lang === 'ko';
  const q = query.trim().toLowerCase();
  const hit = q ? turns.filter((t) => (t.user + ' ' + t.claude).toLowerCase().includes(q)) : turns;
  const shown = hit.slice(-(q ? RECALL_SEARCH_MAX : n));
  if (!shown.length) return [q ? (ko ? `Token Stamina: 이전 대화에서 "${query.trim()}" 가 들어간 턴이 없어요` : `Token Stamina: no turn of the previous chat contains "${query.trim()}"`) : ko ? 'Token Stamina: 이전 대화에 보여줄 턴이 없어요' : 'Token Stamina: no turns to show from the previous chat'];
  const head = q
    ? ko ? `Token Stamina: 이전 대화에서 "${query.trim()}" 검색 ${shown.length}건 (화면에만, 모델은 안 읽음)` : `Token Stamina: ${shown.length} match(es) for "${query.trim()}" in the previous chat (on screen only, not sent to the model)`
    : ko ? `Token Stamina: 이전 대화 마지막 ${shown.length}턴 (화면에만, 모델은 안 읽음)` : `Token Stamina: last ${shown.length} turns of the previous chat (on screen only, not sent to the model)`;
  const out = [head];
  for (const t of shown) {
    out.push('> ' + t.user);
    if (t.claude) out.push('  ' + t.claude);
  }
  return out;
}

export const noPreviousLine = (lang: string): string => (lang === 'ko' ? 'Token Stamina: 방금 비운 이전 대화가 없어요' : 'Token Stamina: there is no just-cleared previous chat');
