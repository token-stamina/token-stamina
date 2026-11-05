// Shared plumbing for the slash commands that read local files (savings, report, audit): the I/O
// interface register.ts fills from `$.fs` / `$.settings`, small path helpers (a hooks module has no
// node:path) and the argument splitter. Pure: nothing here touches a file itself.
//
// Limits of the mods engine that the commands live with: `$.fs.read` rejects a file over 4 MiB, so
// such a file is counted by the adapter (`skipped()`) and the command prints that count under its output.

export interface DirEntry { name: string; kind: string; size: number; mtimeMs: number }

export interface CmdIO {
  // Text of a file, or null when it is missing or cannot be read (over 4 MiB counts in skipped()).
  // { slim: true }: a transcript over 4 MiB is streamed by scripts/transcript-slim.js (when Node is there) and comes back as the
  // slim rows /ts-savings reads, so it is no longer skipped.
  // { adv: true } (0.6.8): the same, but the rows the Usage Advisor's scan reads (transcript-slim.js --adv), under a time budget of its own.
  read(path: string, opts?: { slim?: boolean; adv?: boolean }): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  // Entries of a folder, or null when it is missing.
  list(path: string): Promise<DirEntry[] | null>;
  // Where a path really lands (symlinks resolved), the path itself when that cannot be told.
  realKey(path: string): Promise<string>;
  // How many files existed but could not be read, so far.
  skipped(): number;
}

export interface FileInfo { path: string; name: string; size: number; mtimeMs: number; sub: boolean }

const SEP = /[\\/]/;

export function parentDir(p: string): string {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return p;
  if (i === 0) return s.slice(0, 1);
  const head = s.slice(0, i);
  return /^[A-Za-z]:$/.test(head) ? head + s[i] : head;
}

export function baseName(p: string, ext?: string): string {
  const s = String(p).replace(/[\\/]+$/, '');
  const b = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
}

export function hasSegment(p: string, name: string): boolean {
  return String(p).split(SEP).includes(name);
}

// Every *.jsonl under `dir`, with the folder named `subagents` marking what is below it as `sub`.
// A missing folder gives []. Depth is capped (projects/<slug>/<session>/subagents/... is 4 deep).
export async function walkJsonl(io: CmdIO, dir: string, sub = false, depth = 0): Promise<FileInfo[]> {
  const list = await io.list(dir);
  if (!list || depth > 8) return [];
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const out: FileInfo[] = [];
  for (const e of list) {
    const p = dir.replace(/[\\/]+$/, '') + sep + e.name;
    if (e.kind === 'dir') out.push(...(await walkJsonl(io, p, sub || e.name === 'subagents', depth + 1)));
    else if (e.kind === 'file' && e.name.endsWith('.jsonl')) out.push({ path: p, name: e.name, size: e.size, mtimeMs: e.mtimeMs, sub });
  }
  return out;
}

// `a --b "c d" e` -> ['a', '--b', 'c d', 'e'].
export function splitArgs(s: string | undefined): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(s || '')))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

export const pad2 = (n: number) => String(n).padStart(2, '0');

// Local calendar day `days` days back, as YYYY-MM-DD.
export function dayAgo(days: number, nowMs: number = Date.now()): string {
  const d = new Date(nowMs - days * 86400000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

export function skippedLine(n: number, lang: string): string {
  if (!n) return '';
  if (lang === 'ko') return `참고: 4 MiB 를 넘거나 읽을 수 없는 파일 ${n}개는 건너뛰었어요(mod 판 제한).`;
  return `Note: ${n} file(s) over 4 MiB or unreadable were skipped (mod build limit).`;
}
