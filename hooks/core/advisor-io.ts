// Shared plumbing of the advisor's file-touching modules (scan, apply, followup, weekly, snapshot, run): one context
// object carries the CmdIO (register.ts fills it from `$.fs`), the folders and the config. Nothing here touches a file
// itself except through ctx.io, so the tests run the same code over a node:fs-backed CmdIO.
import type { CmdIO } from './cmd-io.ts';
import { joinPath, sha1Hex } from './text.ts';

export const DAY = 86400000;
// $.fs.read rejects a file over 4 MiB, so a transcript above this is never opened (design decision 1).
export const MAX_READ_BYTES = 4 * 1024 * 1024;

export interface AdvisorCtx {
  io: CmdIO;
  home: string; // the data folder (TOKEN_STAMINA_HOME)
  claudeDir: string; // ~/.claude (or CLAUDE_CONFIG_DIR): projects/ and settings.json live here
  cfg: Record<string, any>; // merged config (defaults + user)
  cfgDefaults: Record<string, any>; // config.default.json as shipped
  nowMs: number;
  sevenDayResetsAt?: number | null; // state.json seven_day.resets_at (epoch seconds), for the weekly schedule
  hintsFor?: (days: number, nowMs: number) => Promise<any>; // hint follow-through numbers (register.ts supplies them)
  // Long background loops (the scan) await this every YIELD_EVERY files so other hooks get a turn (register.ts: $.clock.sleep).
  yieldFn?: () => Promise<void>;
}

export const YIELD_EVERY = 20;
export async function maybeYield(ctx: AdvisorCtx, n: number): Promise<void> {
  if (ctx.yieldFn && n > 0 && n % YIELD_EVERY === 0) { try { await ctx.yieldFn(); } catch { /* a refused wait only means no pause */ } }
}

// UTF-8 length of a string without TextEncoder (the hooks module may not have it).
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xFC00) === 0xDC00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export const dataDir = (ctx: AdvisorCtx) => joinPath(ctx.home, 'advisor');
export const cfgFile = (ctx: AdvisorCtx) => joinPath(ctx.home, 'config.json');
export const defaultSettings = (ctx: AdvisorCtx) => joinPath(ctx.claudeDir, 'settings.json');

export async function readJson<T>(io: CmdIO, path: string, fallback: T): Promise<T> {
  const t = await io.read(path);
  if (t == null || t === '') return fallback;
  try { return JSON.parse(t) as T; } catch { return fallback; }
}

export async function writeJson(io: CmdIO, path: string, obj: unknown): Promise<void> {
  await io.write(path, JSON.stringify(obj));
}

// Hex of `bytes` random bytes. The hooks module has no node:crypto; Web Crypto when the engine has it.
export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const sha = (salt: string, x: unknown) => sha1Hex(salt + String(x)).slice(0, 16);
export const hash12 = (salt: string, x: unknown) => sha1Hex(salt + String(x)).slice(0, 12);

export const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, '-');

// Folder part and last part of a path written with either separator.
export function relPath(dir: string, p: string): string {
  const d = dir.replace(/[\\/]+$/, '');
  const s = p.startsWith(d) ? p.slice(d.length) : p;
  return s.replace(/\\/g, '/').replace(/^\/+/, '');
}
