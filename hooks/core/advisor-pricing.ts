// Prices per MTok (USD). Source: claude-api skill pricing table, cached 2026-10-06.
// Cache write: 5-min = 1.25x input, 1-hour = 2x input. ONE table for the whole advisor; nothing else holds prices.
// A model without a row is never guessed (row = null): callers list it as "unpriced".

const PRICING_DATE = '2026-10-06';
const PRICING_SOURCE = 'claude-api skill pricing table';
const WRITE_5M = 1.25;
const WRITE_1H = 2;

// key -> [input, output, cache read, family, tier]
const TABLE = {
  'fable-5-1': { input: 10, output: 50, read: 0.25, family: 'fable', tier: 'current' },
  'opus-5-5': { input: 4, output: 20, read: 0.20, family: 'opus', tier: 'current' },
  'sonnet-5-5': { input: 2, output: 10, read: 0.20, family: 'sonnet', tier: 'current' },
  'haiku-5-5': { input: 0.10, output: 0.50, read: 0.01, family: 'haiku', tier: 'current' },
  'fable-5': { input: 10, output: 50, read: 1.0, family: 'fable', tier: 'old' },
  // Explicit old versions (claude-api skill table, models.md). opus-4-5, opus-4-1, opus-4-0, sonnet-4-5 and older have NO
  // verified price here and stay unpriced: a generic family prefix used to price them with a newer model's numbers.
  'opus-5': { input: 5, output: 25, read: 0.5, family: 'opus', tier: 'old' },
  'opus-4-8': { input: 5, output: 25, read: 0.5, family: 'opus', tier: 'old' },
  'opus-4-7': { input: 5, output: 25, read: 0.5, family: 'opus', tier: 'old' },
  'opus-4-6': { input: 5, output: 25, read: 0.5, family: 'opus', tier: 'old' },
  'sonnet-5': { input: 2, output: 10, read: 0.2, family: 'sonnet', tier: 'old' },
  'sonnet-4-6': { input: 3, output: 15, read: 0.3, family: 'sonnet', tier: 'old' },
  'haiku-4-5': { input: 1, output: 5, read: 0.1, family: 'haiku', tier: 'old' },
};
const KEYS = Object.keys(TABLE).sort((a, b) => b.length - a.length || (a < b ? -1 : 1)); // longest prefix first
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

function strip(model) { return String(model || '').toLowerCase().replace(/^claude-/, ''); }

// Family by name even when the version has no row (so "opus-9" is still an opus, just unpriced).
function familyOf(model) {
  const m = strip(model);
  for (const f of FAMILIES) if (m.includes(f)) return f;
  return 'other';
}

// A key matches the model id itself, a date suffix ("-20260101") or a bracket suffix ("[1m]"), never a longer version
// ("opus-5-1" is not "opus-5", "opus-4-10" is not "opus-4-1").
const MINOR_NEXT = /^-\d{1,2}(?!\d)/;
function matches(m, k) { return m.startsWith(k) && !MINOR_NEXT.test(m.slice(k.length)); }

// Version by name, e.g. "opus-4-1-2025..." -> [4, 1]; "claude-3-opus" -> [3, 0]. null when there is none.
function versionOf(model) {
  const m = strip(model);
  let x = /(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(m);
  if (x) return [Number(x[2]), x[3] === undefined ? 0 : Number(x[3])];
  x = /(?:^|-)(\d+)(?:-(\d{1,2})(?!\d))?-(?:fable|opus|sonnet|haiku)/.exec(m);
  return x ? [Number(x[1]), x[2] === undefined ? 0 : Number(x[2])] : null;
}

// 'old' for a model of a known family whose version is below the current generation's, priced or not.
function tierByVersion(model) {
  const fam = familyOf(model);
  const v = versionOf(model);
  const cur = fam === 'other' ? null : currentRow(fam);
  if (!v || !cur) return null;
  const ck = Object.keys(TABLE).find((k) => TABLE[k] === cur);
  const cv = versionOf(ck);
  return v[0] < cv[0] || (v[0] === cv[0] && v[1] < cv[1]) ? 'old' : null;
}

function priceOf(model) {
  const m = strip(model);
  for (const k of KEYS) {
    if (matches(m, k)) { const row = TABLE[k]; return { key: k, family: row.family, tier: row.tier, row }; }
  }
  return { key: null, family: familyOf(model), tier: tierByVersion(model), row: null };
}

// Row of the current generation for a family (used to price "the same tokens on the current model").
function currentRow(family) {
  for (const k of Object.keys(TABLE)) if (TABLE[k].family === family && TABLE[k].tier === 'current') return TABLE[k];
  return null;
}

// rec = {input, output, read, w5, w1} in tokens.
function usdParts(row, rec) {
  return {
    read: (rec.read || 0) * row.read / 1e6,
    w5: (rec.w5 || 0) * row.input * WRITE_5M / 1e6,
    w1: (rec.w1 || 0) * row.input * WRITE_1H / 1e6,
    input: (rec.input || 0) * row.input / 1e6,
    output: (rec.output || 0) * row.output / 1e6,
  };
}
function usdOf(row, rec) {
  const p = usdParts(row, rec);
  return p.read + p.w5 + p.w1 + p.input + p.output;
}

// ---- price ratios for the "why" lines: computed from the table, never typed into text.
// ref = a table key ('opus-5-5'), a family ('opus' = its current row) or a row object; `table` defaults to TABLE (tests inject one).
function rowOfRef(ref, table) {
  const t = table || TABLE;
  if (ref && typeof ref === 'object') return ref;
  if (t[ref]) return t[ref];
  for (const k of Object.keys(t)) if (t[k].family === ref && t[k].tier === 'current') return t[k];
  return null;
}
// part: input | output | read | write5 | write1 (USD per MTok)
function priceOfPart(ref, part, table) {
  const row = rowOfRef(ref, table);
  if (!row) return null;
  const p = part === 'input' ? row.input : part === 'output' ? row.output : part === 'read' ? row.read : part === 'write5' ? row.input * WRITE_5M : part === 'write1' ? row.input * WRITE_1H : null;
  return typeof p === 'number' && isFinite(p) ? p : null;
}
// price of `a` divided by price of `b` for one part; b is another model or, with partB, another part of the same model (write5 / read).
function ratio(a, b, part, table, partB) {
  const x = priceOfPart(a, part, table), y = priceOfPart(b, partB || part, table);
  return x === null || !y ? null : x / y;
}
export { priceOfPart, ratio, rowOfRef, PRICING_DATE, PRICING_SOURCE, WRITE_5M, WRITE_1H, TABLE, FAMILIES, priceOf, familyOf, versionOf, currentRow, usdOf, usdParts, strip };
