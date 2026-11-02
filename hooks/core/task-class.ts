// One shared task classifier (advisor scan + the agent-model "always" path), so the analyzer's R1b estimate matches the hook.
// Order: description judgment > implementation > simple, then the prompt's first 600 chars implementation > judgment > simple,
// then the default (implementation). Most subagent descriptions carry no keyword and prompts nearly always mention
// "review"/"plan", so the prompt checks implementation first.
export const PROMPT_CHARS = 600;

export interface ClassCfg { judgmentKeywords?: string[]; implementationKeywords?: string[]; simpleKeywords?: string[] }
export interface ClassResult { cls: 'judgment' | 'implementation' | 'simple'; word: string | null; source: 'description' | 'prompt' | 'default' }

// ASCII keywords match at a word start (so "port" does not hit "report"), non-ASCII keywords by substring.
export function hasKeyword(text: unknown, list: unknown): string | null {
  const s = String(text || '').toLowerCase();
  for (const k of (Array.isArray(list) ? list : [])) {
    const kw = String(k || '').toLowerCase();
    if (!kw) continue;
    if (/^[\x00-\x7f]+$/.test(kw)) {
      const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(^|[^a-z0-9])' + esc).test(s)) return String(k);
    } else if (s.includes(kw)) return String(k);
  }
  return null;
}

export function classifyTask(description: unknown, prompt: unknown, cfg?: ClassCfg): ClassResult {
  const c = cfg || {};
  const j = c.judgmentKeywords, im = c.implementationKeywords, sm = c.simpleKeywords;
  const d = String(description || ''), p = String(prompt || '').slice(0, PROMPT_CHARS);
  let w: string | null;
  if (d.trim()) {
    if ((w = hasKeyword(d, j))) return { cls: 'judgment', word: w, source: 'description' };
    if ((w = hasKeyword(d, im))) return { cls: 'implementation', word: w, source: 'description' };
    if ((w = hasKeyword(d, sm))) return { cls: 'simple', word: w, source: 'description' };
  }
  if (p.trim()) {
    if ((w = hasKeyword(p, im))) return { cls: 'implementation', word: w, source: 'prompt' };
    if ((w = hasKeyword(p, j))) return { cls: 'judgment', word: w, source: 'prompt' };
    if ((w = hasKeyword(p, sm))) return { cls: 'simple', word: w, source: 'prompt' };
  }
  return { cls: 'implementation', word: null, source: 'default' };
}
