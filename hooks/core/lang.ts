// Language follow-along, ported from scripts/lang.js.
// Order: explicit config.lang (en|ko|ja|zh) > language of the prompt just typed
// (UserPromptSubmit) > last detected language (this session, then any session) > OS locale > en.
//
// The original `resolve(cfg, input)` read/wrote lang.json internally (impure). The port splits
// that into a pure `resolveLang(cfg, prompt, sid, book, nowMs)` that takes the already-loaded
// book object and returns the resolved language plus (only when it actually changed) the next
// book to persist -- register.ts owns the `$.fs` read/write and the 50-session cap persistence.

export const EXPLICIT = ['en', 'ko', 'ja', 'zh'] as const;
export const NAMES: Record<string, string> = { en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese' };

export function stripNoise(text: unknown): string {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:[A-Za-z]:)?[\\/][\w.\-\\/]+/g, ' ') // paths and slash commands
    .replace(/<[^>\n]{1,200}>/g, ' '); // pasted tags
}

// Returns 'ko' | 'ja' | 'zh' | 'en' | null (null = not enough signal: keep the previous language).
export function detect(text: unknown): string | null {
  const s = stripNoise(text);
  let hangul = 0;
  let kana = 0;
  let han = 0;
  let latin = 0;
  let words = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) hangul++;
    else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff)) kana++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) han++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xc0 && c <= 0x24f)) latin++;
  }
  for (const _m of s.match(/[A-Za-zÀ-ɏ]{2,}/g) || []) words++;
  const cjk = hangul + kana + han;
  const letters = cjk + latin;
  if (cjk > 0) {
    if (cjk < 2 || cjk / letters < 0.12) return null; // a quoted foreign word inside a longer text: no change
    if (hangul >= kana && hangul > 0 && hangul >= han * 0.5) return 'ko';
    if (kana > 0) return 'ja';
    if (han >= 4) return 'zh';
    return null;
  }
  return words >= 3 && latin >= 12 ? 'en' : null;
}

// Reads the actual OS locale via the global Intl API (no fs/env access -- safe to keep in core).
export function osLocale(): string {
  try {
    const l = String(Intl.DateTimeFormat().resolvedOptions().locale || '')
      .toLowerCase()
      .slice(0, 2);
    return (EXPLICIT as readonly string[]).includes(l) ? l : 'en';
  } catch (e) {
    return 'en';
  }
}

export interface LangCfg { lang?: string }
export function isAuto(cfg: LangCfg | undefined): boolean {
  return !(cfg && (EXPLICIT as readonly string[]).includes(cfg.lang || ''));
}

export interface LangSessionEntry { lang: string; ts: number }
export interface LangBook { last?: string; sessions?: Record<string, LangSessionEntry> }
export interface ResolveLangResult { lang: string; nextBook?: LangBook }

// Pure core of scripts/lang.js `resolve(cfg, input)`. `book` is the already-loaded lang.json
// content (or {} if absent); `prompt` is input.prompt (string) or null/undefined for non-prompt
// events; `nowMs` defaults to Date.now() but can be injected for deterministic tests.
// Returns the resolved language, and -- only when the session record actually needs updating --
// the next book object the caller should persist (register.ts writes it via `$.fs`).
export function resolveLang(
  cfg: LangCfg | undefined,
  prompt: string | null | undefined,
  sid: string | undefined,
  book: LangBook | undefined,
  nowMs: number = Date.now(),
): ResolveLangResult {
  if (!isAuto(cfg)) return { lang: cfg!.lang as string };
  const id = sid || 'unknown';
  const b = book || {};
  const sess = b.sessions || {};
  if (typeof prompt === 'string') {
    const d = detect(prompt);
    if (d) {
      let nextBook: LangBook | undefined;
      if (b.last !== d || !sess[id] || sess[id].lang !== d) {
        const newSess: Record<string, LangSessionEntry> = { ...sess, [id]: { lang: d, ts: nowMs } };
        let keys = Object.keys(newSess);
        if (keys.length > 50) {
          keys
            .sort((x, y) => newSess[x].ts - newSess[y].ts)
            .slice(0, keys.length - 50)
            .forEach((k) => delete newSess[k]);
        }
        nextBook = { last: d, sessions: newSess };
      }
      return { lang: d, nextBook };
    }
  }
  if (sess[id] && (EXPLICIT as readonly string[]).includes(sess[id].lang)) return { lang: sess[id].lang };
  if ((EXPLICIT as readonly string[]).includes(b.last || '')) return { lang: b.last as string };
  return { lang: osLocale() };
}

// Copy of cfg whose lang is the resolved one. _langAuto tells pacer.attributed to add the
// "user's language" directive. Pure, given the already-resolved language string.
export function withLang<T extends LangCfg>(cfg: T, resolvedLang: string): T & { lang: string; _langAuto: boolean } {
  return Object.assign({}, cfg, { lang: resolvedLang, _langAuto: isAuto(cfg) });
}
