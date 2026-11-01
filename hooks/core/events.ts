// The event log of the mod build: one slot file per session under <home>/events/, so two processes
// never write the same file ($.fs has no append; each write is a whole-file rewrite).
//
//   events/sXXX.jsonl      XXX = 000..3ff, the slot a session holds; first line {"v":5,"ts":..,"owner":"<sid>"}
//   events/sXXX.old.jsonl  the slot's previous 3 MiB, moved aside on rotation (overwritten)
//
// A session's slot starts at FNV-1a(sid) mod SLOTS and probes forward. A slot is free when missing,
// empty or unwritten for KEEP_MS; else it is the session's own only when its first line names it.
// The older single-file logs (events.jsonl, events-mod.jsonl, events-<time>.jsonl) are read, never written.
import { joinPath } from './text.ts';
import type { CmdIO } from './cmd-io.ts';

export const SLOTS = 1024;
export const ROTATE_AT = 3 * 1024 * 1024;
export const KEEP_MS = 30 * 86400 * 1000;
export const REUSE_MS = 86400 * 1000; // all slots taken: the oldest one idle this long is reused
export const MAX_READS = 16; // slots read per search before settling for the oldest idle one
export const EMPTY_GRACE_MS = 60 * 1000;
export const DIR = 'events';
const SLOT_RE = /^s[0-9a-f]{3}(\.old)?\.jsonl$/;

export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const slotName = (i: number) => 's' + (i % SLOTS).toString(16).padStart(3, '0') + '.jsonl';
export const oldName = (name: string) => name.replace(/\.jsonl$/, '.old.jsonl');
export const header = (sid: string, nowMs: number) => JSON.stringify({ v: 5, ts: new Date(nowMs).toISOString(), owner: sid }) + '\n';

// The owner named on the first line, or null.
export function ownerOf(text: string | null): string | null {
  if (!text) return null;
  const nl = text.indexOf('\n');
  try {
    const o = JSON.parse(nl < 0 ? text : text.slice(0, nl));
    return o && typeof o.owner === 'string' ? o.owner : null;
  } catch {
    return null;
  }
}

export interface SlotEntry { name: string; size: number; mtimeMs: number }
export type SlotPick = { name: string; fresh: true } | { name: string; fresh: false; text: string } | null;

// Where `sid` writes. `entries` is the listing of events/ (missing folder: []); `read` reads one slot
// (null when unreadable). Fresh means the slot is free and the caller starts it with a header.
export async function pickSlot(sid: string, entries: SlotEntry[], nowMs: number, read: (name: string) => Promise<string | null>, skip?: Set<string>): Promise<SlotPick> {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const start = hash(sid) % SLOTS;
  let oldest: { name: string; mtimeMs: number } | null = null;
  let reads = 0;
  for (let k = 0; k < SLOTS; k++) {
    const name = slotName(start + k);
    if (skip && skip.has(name)) continue;
    const e = byName.get(name);
    // a file emptied moments ago may be another process's rewrite in flight, not a free slot
    if (!e || (e.size === 0 && nowMs - e.mtimeMs > EMPTY_GRACE_MS) || nowMs - e.mtimeMs > KEEP_MS) return { name, fresh: true };
    if (e.size === 0) continue;
    if (reads++ >= MAX_READS) break; // each read is a whole slot: bound the cost of a crowded folder
    const text = await read(name);
    if (text != null && ownerOf(text) === sid) return { name, fresh: false, text };
    if (nowMs - e.mtimeMs > REUSE_MS && (!oldest || e.mtimeMs < oldest.mtimeMs)) oldest = { name, mtimeMs: e.mtimeMs };
  }
  return oldest ? { name: oldest.name, fresh: true } : null;
}

// Every event line since `sinceMs`, from the old single-file logs and the slot files. A file last
// written before `since` cannot hold a newer event and is not read.
export async function readEvents(io: CmdIO, home: string, sinceMs: number): Promise<any[]> {
  const files: string[] = [joinPath(home, 'events.jsonl'), joinPath(home, 'events-mod.jsonl')];
  const top = await io.list(home);
  if (top) for (const e of top) if (e.kind === 'file' && /^events-[\w-]+\.jsonl$/.test(e.name) && e.name !== 'events-mod.jsonl' && e.mtimeMs >= sinceMs) files.push(joinPath(home, e.name));
  const slots = await io.list(joinPath(home, DIR));
  if (slots) for (const e of slots) if (e.kind === 'file' && SLOT_RE.test(e.name) && e.size > 0 && e.mtimeMs >= sinceMs) files.push(joinPath(home, DIR, e.name));
  const out: any[] = [];
  for (const f of files) {
    const txt = await io.read(f);
    if (!txt) continue;
    for (const line of txt.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e && e.event && Date.parse(e.ts) >= sinceMs) out.push(e);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}
