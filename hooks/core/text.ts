// Pure: token/size estimates and small string helpers shared by several core modules.
// Ported from scripts/audit.js (estimateTokens, encodeCwd) -- only the pure subset needed
// for stage 1. The rest of audit.js (report/audit command, SAFE_ARG allowlist, runClaude)
// is out of scope for stage 1 (PLAN-0.5-mods.md Stage 2+).

// Rough, deliberately simple token estimate: ascii chars/4 + everything else (CJK etc.)/1.5.
// Never presented as exact -- callers must label downstream text as an estimate.
export function estimateTokens(text: unknown): number {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text)) {
    if ((ch.codePointAt(0) ?? 0) < 128) ascii++;
    else other++;
  }
  return Math.round(ascii / 4 + other / 1.5);
}

// Claude Code project folder name: every non-alphanumeric character becomes '-'
// (C:\Projects -> C--Projects). Matches Claude Code's own ~/.claude/projects/<encoded> layout.
export function encodeCwd(cwd: unknown): string {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// Synchronous SHA-1 as lowercase hex, over the UTF-8 bytes of `s`. The hooks module has no
// node:crypto, and crypto.subtle.digest is async; every hash here is a short file-name or
// escalation key that must match what the Node 0.5 scripts wrote (createHash('sha1')).
export function sha1Hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const len = bytes.length;
  const words = new Uint32Array((((len + 8) >> 6) + 1) * 16);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  words[words.length - 1] = len * 8;
  words[words.length - 2] = Math.floor(len / 0x20000000);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let b = 0; b < words.length; b += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[b + t];
    for (let t = 16; t < 80; t++) { const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = (x << 1) | (x >>> 31); }
    let a = h0, bb = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (bb & c) | (~bb & d) : t < 40 ? bb ^ c ^ d : t < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
      e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = tmp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + bb) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

// path.join substitute for a module with no node:path: keeps the base's separator style
// (a base spelled only with backslashes gets backslashes), drops a trailing separator.
export function joinPath(base: string, ...parts: string[]): string {
  const b = String(base || '');
  const sep = b.includes('\\') && !b.includes('/') ? '\\' : '/';
  return [b.replace(/[\\/]+$/, ''), ...parts.map((p) => String(p).replace(/^[\\/]+|[\\/]+$/g, ''))].join(sep);
}

// Display form of a path under the user's home: `~/...` with forward slashes (the tools expand `~`).
// Used for the paths put into injected lines only; the file itself keeps its real name. A path outside
// the home, or no home, stays as given.
export function tildePath(p: string, home: string | undefined): string {
  const norm = (x: string) => String(x).replace(/[\\]/g, '/').replace(/\/+$/, '');
  const h = norm(home || '');
  const q = norm(p);
  if (!h || h.length < 2) return p;
  if (q.toLowerCase().startsWith(h.toLowerCase() + '/')) return '~' + q.slice(h.length);
  return p;
}
