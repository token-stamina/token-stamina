// Approved apply + revert (design section 7). Writes only what the plan lists: Token Stamina config keys and
// env keys of settings.json (the compact window also sets compactWindowTokens). Every run is logged and revertible.
// Mod build: all file access goes through ctx.io ($.fs: whole-file read, write makes folders, no rename/copy/delete),
// so a backup is a second write of the text just read and a settings.json is rewritten in place.
//
// Consent is a property of the shape, not of the caller's good manners: apply() refuses any settings.json item unless the
// caller says `confirmed: true` (register.ts sets it only after $.ui.ask put the items in front of the person), and an
// automatic run (by: 'auto') can never carry that flag. revert() asks through `confirmSettings` before it restores a
// settings.json value and holds the value back when there is no one to ask.
import { joinPath } from './text.ts';
import * as text from './advisor-text.ts';
import { readJson, writeJson, randomHex, stamp, dataDir, cfgFile, defaultSettings, utf8Bytes, type AdvisorCtx } from './advisor-io.ts';
import * as followup from './advisor-followup.ts';

export const COMPACT_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
export const COMPACT_TOKENS_KEY = 'compactWindowTokens';
export const PLAN_TTL_MS = 10 * 60 * 1000;
export const LOG_ROTATE_BYTES = 3 * 1024 * 1024; // $.fs.read rejects 4 MiB: the log moves aside well before that

const same = (a: any, b: any) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
export const show = (v: any) => (v === undefined || v === null ? '(unset)' : typeof v === 'string' ? v : JSON.stringify(v));
const logFile = (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'apply-log.jsonl');
const oldLogFile = (ctx: AdvisorCtx) => joinPath(dataDir(ctx), 'apply-log.old.jsonl');

// ---- settings.json without reformatting it: BOM, line ending, indent and final newline are detected and kept.

// oneLine: the file was a single line (minified). It is written back as one compact line; spaces after ':' and ',' and \uXXXX
// escapes of the original are not kept (JSON.stringify decides), the data is the same. A bare `{}` is not a minified file: it is
// written back in the normal indented form.
export interface Fmt { bom: boolean; eol: string; indent: number | string; finalNewline: boolean; oneLine?: boolean }
// ok + isNew: the file does not exist; it reads as {} and the first write creates it. unreadable: it exists but cannot be read.
export interface SettingsRead { ok: boolean; missing?: boolean; isNew?: boolean; unreadable?: boolean; invalid?: boolean; raw: string | null; json: any; bom?: boolean; fmt?: Fmt }

export function detectFmt(raw: string, bom: boolean): Fmt {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const m = /\n([ \t]+)"/.exec(raw);
  let indent: number | string = 2;
  if (m) indent = m[1][0] === '\t' ? '\t' : m[1].length;
  return { bom: !!bom, eol, indent, finalNewline: raw.length ? /\n$/.test(raw) : true, oneLine: raw.trim().length > 0 && !/\n/.test(raw.trim()) && !/^\{\s*\}$/.test(raw.trim()) };
}

export function parseSettings(rawIn: string | null): SettingsRead {
  if (rawIn == null) return { ok: false, missing: true, raw: null, json: null };
  let raw = rawIn;
  const bom = raw.charCodeAt(0) === 0xFEFF;
  if (bom) raw = raw.slice(1);
  const fmt = detectFmt(raw, bom);
  try { return { ok: true, raw, json: JSON.parse(raw), bom, fmt }; } catch { return { ok: false, invalid: true, raw, json: null, bom, fmt }; }
}

export function serializeSettings(obj: any, fmt?: Partial<Fmt>): string {
  const f = fmt || {};
  let s = f.oneLine ? JSON.stringify(obj) : JSON.stringify(obj, null, f.indent === undefined ? 2 : f.indent);
  const eol = f.eol || '\n';
  if (eol !== '\n') s = s.replace(/\n/g, eol);
  if (f.finalNewline !== false) s += eol;
  return (f.bom ? '﻿' : '') + s;
}

export async function readSettings(ctx: AdvisorCtx, p: string): Promise<SettingsRead> {
  const raw = await ctx.io.read(p);
  if (raw == null) {
    // $.fs.read answers null for a missing file and for one it cannot read (over 4 MiB, no access): only the first is a new file.
    if (await ctx.io.exists(p)) return { ok: false, unreadable: true, raw: null, json: null };
    return { ok: true, missing: true, isNew: true, raw: '', json: {}, bom: false, fmt: { bom: false, eol: '\n', indent: 2, finalNewline: true } };
  }
  return parseSettings(raw);
}

const settingsRefusal = (st: SettingsRead, p: string) => (st.invalid ? text.tbl('en').apply.invalid : 'Cannot read settings file: ' + p);

// The Token Stamina config.json, strictly: missing or empty is {}, anything that is not a JSON object is refused (never overwritten).
export interface ConfigRead { ok: boolean; invalid?: boolean; unreadable?: boolean; obj: any; raw: string | null }
export async function readConfigStrict(ctx: AdvisorCtx): Promise<ConfigRead> {
  const f = cfgFile(ctx);
  const raw = await ctx.io.read(f);
  if (raw == null) return (await ctx.io.exists(f)) ? { ok: false, unreadable: true, obj: null, raw: null } : { ok: true, obj: {}, raw: null };
  const body = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  if (body.trim() === '') return { ok: true, obj: {}, raw };
  try {
    const j = JSON.parse(body);
    if (j && typeof j === 'object' && !Array.isArray(j)) return { ok: true, obj: j, raw };
  } catch { /* fall through */ }
  return { ok: false, invalid: true, obj: null, raw };
}
export const configRefusal = (c: ConfigRead) => (c.invalid ? text.tbl('en').apply.configInvalid : text.tbl('en').apply.configUnreadable);

// ---- plan

export interface PlanItem { id: string; rule: string; file: 'config' | 'settings'; key: string; before: any; after: any; hadKey: boolean }
export interface Plan { settingsPath: string; items: PlanItem[]; notes: { id: string; kind: string }[]; approved: string[]; settingsNew?: boolean }

// Read-only. recs: Recommendation[]; approved: ids. Fills `before` from the files as they are now (not the merged
// defaults), so the log and the revert work on what was really in the files.
export async function plan(ctx: AdvisorCtx, recs: any[], approved: string[], settingsPath?: string): Promise<Plan> {
  settingsPath = settingsPath || defaultSettings(ctx);
  const user: any = (await readJson(ctx.io, cfgFile(ctx), {})) || {};
  const st = await readSettings(ctx, settingsPath);
  const env = st.ok && st.json.env && typeof st.json.env === 'object' ? st.json.env : {};
  const out: Plan = { settingsPath, items: [], notes: [], approved: Array.from(approved || []), settingsNew: !!st.isNew };
  for (const id of out.approved) {
    const rec = (recs || []).find((r) => String(r.id).toUpperCase() === String(id).toUpperCase());
    if (!rec) { out.notes.push({ id, kind: 'unknown' }); continue; }
    if (!rec.changes || !rec.changes.length) { out.notes.push({ id, kind: 'info' }); continue; }
    let n = 0;
    for (const ch of rec.changes) {
      const src = ch.file === 'settings' ? env : user;
      const hadKey = Object.prototype.hasOwnProperty.call(src, ch.key);
      const before = hadKey ? src[ch.key] : null;
      if (hadKey && same(before, ch.after)) continue;
      out.items.push({ id, rule: rec.rule, file: ch.file, key: ch.key, before, after: ch.after, hadKey });
      n++;
    }
    if (!n) out.notes.push({ id, kind: 'same' });
  }
  return out;
}

export const itemLine = (it: PlanItem, settingsNew?: boolean) =>
  `${it.id} ${it.file === 'settings' ? 'settings env.' + it.key + (settingsNew ? ' ' + text.tbl('en').apply.newFile : '') : 'config ' + it.key}: ${show(it.before)} -> ${show(it.after)}`;

export function previewLines(p: Plan, lang: string): string[] {
  const t = text.tbl(lang).apply;
  const lines: string[] = [];
  for (const n of p.notes) lines.push(n.kind === 'unknown' ? t.unknown(n.id) : n.kind === 'info' ? t.info(n.id) : t.same(n.id));
  if (!p.items.length) { lines.push(t.none); return lines; }
  lines.push(t.preview);
  for (const it of p.items) lines.push(`${it.id} ${it.file === 'settings' ? 'settings env.' + it.key + (p.settingsNew ? ' ' + t.newFile : '') : 'config ' + it.key}: ${show(it.before)} -> ${show(it.after)}`);
  return lines;
}

// ---- apply log (one JSON object per line; rotated to apply-log.old.jsonl before it can reach the 4 MiB read limit)

// Reads the log for a write. A log that exists but cannot be read (over 4 MiB, no access) is never overwritten: the caller refuses.
async function readLogForWrite(ctx: AdvisorCtx): Promise<string | null> {
  const f = logFile(ctx);
  const cur = await ctx.io.read(f);
  if (cur == null && (await ctx.io.exists(f))) return null;
  return cur || '';
}

// Before anything is changed: the log must be readable, and one over 3 MiB moves to apply-log.old.jsonl (the older one is replaced).
export async function prepareLog(ctx: AdvisorCtx): Promise<boolean> {
  try {
    const cur = await readLogForWrite(ctx);
    if (cur === null) return false;
    if (utf8Bytes(cur) > LOG_ROTATE_BYTES) {
      await ctx.io.write(oldLogFile(ctx), cur);
      await ctx.io.write(logFile(ctx), '');
    }
    return true;
  } catch { return false; }
}

export async function appendLog(ctx: AdvisorCtx, entry: any): Promise<void> {
  const cur = await readLogForWrite(ctx);
  if (cur === null) throw new Error(text.tbl('en').apply.logUnreadable);
  await ctx.io.write(logFile(ctx), cur + (cur && !cur.endsWith('\n') ? '\n' : '') + JSON.stringify(entry) + '\n');
}

function parseLines(txt: string, out: any[]): void {
  for (const l of txt.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* skip */ } }
}

// Entries of the rotated log first, then the current one.
export async function readLog(ctx: AdvisorCtx): Promise<any[]> {
  const out: any[] = [];
  parseLines((await ctx.io.read(oldLogFile(ctx))) || '', out);
  parseLines((await ctx.io.read(logFile(ctx))) || '', out);
  return out;
}

// ---- writes

// Generic env write with the setup-compact pattern: refuse invalid JSON, back up once per run, keep indent and other keys.
// A settings.json that does not exist is created ({} plus the key); there is nothing to back up then.
// keepEnv: removing the last key leaves `env: {}` in place (the apply found an env object there before it added its key).
export async function writeSettingsEnv(ctx: AdvisorCtx, file: string, key: string, value: any, now: Date, keepEnv?: boolean): Promise<{ ok: boolean; changed?: boolean; backup?: string | null; message?: string }> {
  const st = await readSettings(ctx, file);
  if (!st.ok) return { ok: false, message: settingsRefusal(st, file) };
  const next = st.isNew ? {} as any : JSON.parse(st.raw as string);
  const before = next.env && next.env[key] !== undefined ? next.env[key] : null;
  if (value === null || value === undefined) { if (next.env) { delete next.env[key]; if (!Object.keys(next.env).length && !keepEnv) delete next.env; } }
  else next.env = Object.assign({}, next.env, { [key]: value });
  if (same(before, value)) return { ok: true, changed: false, backup: null };
  let backup: string | null = null;
  if (!st.isNew) {
    backup = file + '.bak-token-stamina-' + stamp(now);
    if (!(await ctx.io.exists(backup))) await ctx.io.write(backup, (st.bom ? '﻿' : '') + (st.raw as string));
  }
  await ctx.io.write(file, serializeSettings(next, st.fmt));
  return { ok: true, changed: true, backup };
}

async function backupConfig(ctx: AdvisorCtx, now: Date, tag?: string, rawIn?: string | null): Promise<string | null> {
  const raw = rawIn !== undefined ? rawIn : await ctx.io.read(cfgFile(ctx));
  if (raw == null) return null;
  const b = joinPath(dataDir(ctx), 'backups', 'config-' + stamp(now) + (tag ? '-' + tag : '') + '.json');
  await ctx.io.write(b, raw);
  return b;
}

export interface ApplyOpts { dryRun?: boolean; now?: Date; by?: string; lang?: string; analysis?: any; noTrack?: boolean; trackSkipIds?: string[]; confirmed?: boolean }

// p = plan(); opts {dryRun, now: Date, by: 'user'|'auto', lang, confirmed}.
// Order: validate everything (settings.json readable, config.json valid, apply log readable), then settings.json, then config.json.
// When the config write fails after settings.json was written, settings.json is put back to the text it had.
export async function apply(ctx: AdvisorCtx, p: Plan, opts?: ApplyOpts): Promise<any> {
  const o = opts || {};
  const now = o.now || new Date(ctx.nowMs);
  const lang = o.lang || 'en';
  const t = text.tbl(lang).apply;
  const lines = previewLines(p, lang);
  const res: any = { ok: true, dryRun: !!o.dryRun, lines, applied: [], backups: [], errors: [], logId: null };
  if (!p.items.length) return res;
  const fail = (msg: string) => { res.ok = false; res.errors.push(msg); lines.push(msg); return res; };
  const settingsItems = p.items.filter((i) => i.file === 'settings');
  const cfgItems = p.items.filter((i) => i.file === 'config');
  const compact = settingsItems.find((i) => i.key === COMPACT_KEY);
  // A settings item that cannot be written stops the whole run first, so config and settings never end up half applied.
  let stIn: SettingsRead | null = null;
  if (settingsItems.length) {
    stIn = await readSettings(ctx, p.settingsPath);
    if (!stIn.ok) return fail(settingsRefusal(stIn, p.settingsPath));
  }
  let cfgIn: ConfigRead | null = null;
  if (cfgItems.length || compact) {
    cfgIn = await readConfigStrict(ctx);
    if (!cfgIn.ok) return fail(configRefusal(cfgIn));
    // The compact window is one rule with two values: when the plan carries only the settings half, the config half
    // (compactWindowTokens) becomes a real plan item here, so it is written, logged and reverted like any other.
    if (compact && !cfgItems.some((i) => i.key === COMPACT_TOKENS_KEY)) {
      const hadKey = Object.prototype.hasOwnProperty.call(cfgIn.obj, COMPACT_TOKENS_KEY);
      const before = hadKey ? cfgIn.obj[COMPACT_TOKENS_KEY] : null;
      const after = compact.after === null || compact.after === undefined ? null : Number(compact.after);
      if (hadKey ? !same(before, after) : after !== null) cfgItems.push({ id: compact.id, rule: compact.rule, file: 'config', key: COMPACT_TOKENS_KEY, before, after, hadKey });
    }
  }
  if (o.dryRun) { lines.push(t.dry); return res; }
  // settings.json changes only with a person's yes (register.ts: $.ui.ask); an automatic run never carries it
  if (settingsItems.length && !(o.confirmed === true && o.by !== 'auto')) return fail(t.needConfirm);
  if (!(await prepareLog(ctx))) return fail(t.logUnreadable);

  const done: PlanItem[] = [];
  let origSettings: string | null = null;
  let cfgWritten = false;
  const hadEnv = !!(stIn && stIn.ok && stIn.json && stIn.json.env && typeof stIn.json.env === 'object');
  const rollbackConfig = async () => {
    if (!cfgWritten || !cfgIn) return;
    const b = res.backups.find((x: string) => /[\/]config-[^\/]*\.json$/.test(x)) || '(no backup)';
    // no delete in $.fs: a config.json that was not there goes back as '{}', valid JSON for every reader
    try { await ctx.io.write(cfgFile(ctx), cfgIn.raw === null ? '{}\n' : cfgIn.raw); } catch { lines.push(t.cfgRollbackFailed(b)); }
  };
  const rollback = async () => {
    if (origSettings === null) return;
    try { await ctx.io.write(p.settingsPath, origSettings); lines.push(t.rolledBack); }
    catch { lines.push(t.rollbackFailed(res.backups.find((b: string) => b.includes('.bak-token-stamina-')) || '(no backup)')); }
  };
  if (settingsItems.length) {
    origSettings = stIn!.isNew ? '{}\n' : (stIn!.bom ? '﻿' : '') + (stIn!.raw as string);
    for (const it of settingsItems) {
      let r: { ok: boolean; backup?: string | null; message?: string };
      try { r = await writeSettingsEnv(ctx, p.settingsPath, it.key, it.after, now); } catch (e: any) { r = { ok: false, message: 'Cannot write settings file: ' + (e && e.message || e) }; }
      if (!r.ok) { fail(r.message as string); await rollback(); return res; }
      if (r.backup && !res.backups.includes(r.backup)) { res.backups.push(r.backup); lines.push(t.backup + ' ' + r.backup); }
      done.push(it);
    }
  }
  if (cfgIn) {
    try {
      const b = await backupConfig(ctx, now, undefined, cfgIn.raw);
      if (b) { res.backups.push(b); lines.push(t.backup + ' ' + b); }
      const user = cfgIn.obj;
      for (const it of cfgItems) {
        if (it.key === COMPACT_TOKENS_KEY) { if (it.after === null || it.after === undefined) delete user[it.key]; else user[it.key] = Number(it.after); }
        else user[it.key] = it.after;
        done.push(it);
      }
      await writeJson(ctx.io, cfgFile(ctx), user);
      cfgWritten = true;
    } catch (e: any) {
      fail('Cannot write the config file: ' + (e && e.message || e));
      await rollback();
      res.applied = [];
      return res;
    }
  }
  res.applied = done;
  if (done.length) {
    const id = 'ap-' + randomHex(6);
    // No change without a record: when the log cannot be written, both files go back to the text they had.
    try {
      await appendLog(ctx, { id, ts: now.toISOString(), by: o.by === 'auto' ? 'auto' : 'user',
        items: done.map((i) => (i.file === 'settings' ? { rule: i.rule, file: i.file, key: i.key, before: i.before, after: i.after, hadKey: i.hadKey, hadEnv } : { rule: i.rule, file: i.file, key: i.key, before: i.before, after: i.after, hadKey: i.hadKey })), backups: res.backups });
    } catch (e: any) {
      await rollback();
      await rollbackConfig();
      res.applied = [];
      return fail(t.logWriteFailed((e && e.message) || String(e)));
    }
    res.logId = id;
    // follow-up items (UNDO-*/TUNE-*) are never tracked as a new apply; only the ordinary items of the run are
    const skip = new Set((o.trackSkipIds || []).map((s) => String(s).toUpperCase()));
    const tracked = done.filter((i) => !skip.has(String(i.id).toUpperCase()));
    if (!o.noTrack && tracked.length) { try { await followup.record(ctx, { id, at: now.toISOString(), items: tracked, analysis: o.analysis || null }); } catch { /* the one-week check is optional */ } }
    lines.push(t.logged(id));
  }
  return res;
}

// The user declining an auto-applied change (or reverting it) must not bring it back next week: remember it like `reject`.
export async function rememberRejected(ctx: AdvisorCtx, rules: string[], now: Date): Promise<void> {
  if (!rules.length) return;
  try {
    const f = joinPath(dataDir(ctx), 'baseline.json');
    const base: any = (await readJson(ctx.io, f, {})) || {};
    base.rejected = Object.assign({}, base.rejected);
    for (const r of rules) { base.rejected[r] = now.getTime(); if (base.rules) delete base.rules[r]; }
    await writeJson(ctx.io, f, base);
  } catch { /* read-only home: the revert itself still counts */ }
}

const itemKey = (i: any) => i.rule + '|' + i.file + '|' + i.key;

export interface RevertOpts { settings?: string; lang?: string; now?: Date; confirmSettings?: (lines: string[]) => Promise<boolean> }

// Restores before-values, but only where the current value still equals what the apply wrote.
// Per-item: only restored items are logged, so a later `revert <id>` retries what is still open (error / changed).
// The config part of a rule is held back when its settings part failed or changed since, so one rule never ends up half reverted.
// A settings.json value is only restored after confirmSettings (the person's yes) answered true; without it the item is held back.
export async function revert(ctx: AdvisorCtx, which: string | undefined, opts?: RevertOpts): Promise<any> {
  const o = opts || {};
  const now = o.now || new Date(ctx.nowMs);
  const lang = o.lang || 'en';
  const t = text.tbl(lang).apply;
  const settingsPath = o.settings || defaultSettings(ctx);
  const log = await readLog(ctx);
  const done = new Map<string, Set<string>>(); // apply id -> Set of item keys already restored
  for (const e of log) {
    if (!e.reverts) continue;
    const set = done.get(e.reverts) || new Set<string>();
    if (e.complete === undefined && !Array.isArray(e.items)) set.add('*');
    for (const i of e.items || []) if (i.status === 'restored') set.add(itemKey(i));
    if (e.complete === true) set.add('*');
    done.set(e.reverts, set);
  }
  const open = (e: any) => { const d = done.get(e.id); return !(d && d.has('*')) && e.items.some((i: any) => !(d && d.has(itemKey(i)))); };
  const applies = log.filter((e) => e.items && e.id && !e.reverts);
  let target: any;
  if (which === '--last' || which === 'last' || !which) target = applies.slice().reverse().find(open);
  else {
    target = applies.find((e) => e.id === which);
    if (!target) return { ok: false, lines: [t.unknownId(which)], items: [] };
    if (!open(target)) return { ok: false, lines: [t.already(which)], items: [] };
  }
  if (!target) return { ok: true, lines: [t.nothingToRevert], items: [] };
  const lines: string[] = [];
  const out: any[] = [];
  const prior = done.get(target.id) || new Set<string>();
  const todo = target.items.filter((i: any) => !prior.has(itemKey(i))).reverse();
  // config.json that is not a JSON object is never rewritten: the whole revert is refused before anything is touched
  const cfgIn = await readConfigStrict(ctx);
  if (!cfgIn.ok && todo.some((i: any) => i.file !== 'settings')) return { ok: false, lines: [configRefusal(cfgIn)], items: [], id: target.id };
  if (!(await prepareLog(ctx))) return { ok: false, lines: [t.logUnreadable], items: [], id: target.id };
  const user: any = cfgIn.ok ? cfgIn.obj : {};
  let cfgDirty = false;
  const st = await readSettings(ctx, settingsPath);
  const env = st.ok && st.json.env && typeof st.json.env === 'object' ? st.json.env : {};
  const label = (it: any) => `${it.rule} ${it.file === 'settings' ? 'settings env.' + it.key : 'config ' + it.key}`;
  const back = (it: any) => `(${show(it.after)} -> ${it.hadKey ? show(it.before) : '(unset)'})`;
  const failedRules = new Set<string>();
  const settingsTodo = todo.filter((i: any) => i.file === 'settings');
  // the values that would really be restored (the file still holds what the apply wrote) need a yes before the first write
  let allowSettings = false;
  const restoredAlready = (it: any) => same(Object.prototype.hasOwnProperty.call(env, it.key) ? env[it.key] : undefined, it.hadKey ? it.before : undefined);
  const candidates = st.ok ? settingsTodo.filter((it: any) => same(Object.prototype.hasOwnProperty.call(env, it.key) ? env[it.key] : undefined, it.after) && !restoredAlready(it)) : [];
  let refusal = '';
  if (candidates.length) {
    if (!o.confirmSettings) refusal = t.needConfirm;
    else {
      try { allowSettings = (await o.confirmSettings(candidates.map((it: any) => `${label(it)}: ${back(it)}`))) === true; } catch { allowSettings = false; }
      if (!allowSettings) refusal = t.needConfirm;
    }
  }
  // settings items first: when one fails or changed, the config items of the same rule are held back
  for (const it of settingsTodo) {
    if (!st.ok) {
      out.push({ rule: it.rule, file: it.file, key: it.key, status: 'error' }); failedRules.add(it.rule);
      lines.push(`${label(it)}: ${settingsRefusal(st, settingsPath)} (${t.failed})`);
      continue;
    }
    const cur = Object.prototype.hasOwnProperty.call(env, it.key) ? env[it.key] : undefined;
    // the value is already back at its before (an earlier revert wrote it and then failed on the config half, or its log line was lost):
    // nothing to write and nothing to ask, the item only gets recorded, so a retry ends
    if (!same(cur, it.after) && restoredAlready(it)) { out.push({ rule: it.rule, file: it.file, key: it.key, status: 'restored' }); lines.push(`${label(it)}: ${t.alreadyRestored}`); continue; }
    if (!same(cur, it.after)) { out.push({ rule: it.rule, file: it.file, key: it.key, status: 'changed' }); failedRules.add(it.rule); lines.push(`${label(it)}: ${t.changedSince}`); continue; }
    if (!allowSettings) { out.push({ rule: it.rule, file: it.file, key: it.key, status: 'error' }); failedRules.add(it.rule); lines.push(`${label(it)}: ${refusal} (${t.failed})`); continue; }
    const r = await writeSettingsEnv(ctx, settingsPath, it.key, it.hadKey ? it.before : null, now, it.hadEnv === true);
    if (!r.ok) { out.push({ rule: it.rule, file: it.file, key: it.key, status: 'error' }); failedRules.add(it.rule); lines.push(`${label(it)}: ${r.message} (${t.failed})`); continue; }
    out.push({ rule: it.rule, file: it.file, key: it.key, status: 'restored' });
    lines.push(`${label(it)}: ${t.restored} ${back(it)}`);
  }
  let cfgBackup: string | null = null;
  for (const it of todo.filter((i: any) => i.file !== 'settings')) {
    if (failedRules.has(it.rule)) { out.push({ rule: it.rule, file: it.file, key: it.key, status: 'error' }); lines.push(`${label(it)}: ${t.heldBack}`); continue; }
    const cur = Object.prototype.hasOwnProperty.call(user, it.key) ? user[it.key] : undefined;
    if (!same(cur, it.after) && same(cur, it.hadKey ? it.before : undefined)) { out.push({ rule: it.rule, file: it.file, key: it.key, status: 'restored' }); lines.push(`${label(it)}: ${t.alreadyRestored}`); continue; }
    if (!same(cur, it.after)) { out.push({ rule: it.rule, file: it.file, key: it.key, status: 'changed' }); lines.push(`${label(it)}: ${t.changedSince}`); continue; }
    if (!cfgBackup) cfgBackup = await backupConfig(ctx, now, 'revert', cfgIn.raw);
    if (it.hadKey) user[it.key] = it.before; else delete user[it.key];
    cfgDirty = true;
    out.push({ rule: it.rule, file: it.file, key: it.key, status: 'restored' });
    lines.push(`${label(it)}: ${t.restored} ${back(it)}`);
  }
  if (cfgDirty) {
    // A config write that fails must not lose what the settings part already restored: the config items turn into errors,
    // the restored settings items are still logged, and the next revert finishes only the config part.
    try { await writeJson(ctx.io, cfgFile(ctx), user); }
    catch (e: any) {
      for (const x of out) if (x.file !== 'settings' && x.status === 'restored') x.status = 'error';
      lines.push(`config: ${(e && e.message) || e} (${t.failed})`);
    }
  }
  const restored = out.filter((x) => x.status === 'restored');
  const errors = out.filter((x) => x.status === 'error');
  const changed = out.filter((x) => x.status === 'changed');
  const complete = !errors.length && !changed.length;
  if (restored.length) {
    await appendLog(ctx, { reverts: target.id, ts: now.toISOString(), items: restored, complete });
    await rememberRejected(ctx, Array.from(new Set(restored.map((x) => x.rule))), now);
  }
  if (!restored.length) {
    lines.push(t.nothingReverted(target.id));
    return { ok: false, lines, items: out, id: target.id };
  }
  lines.push(t.reverted(target.id));
  return { ok: !errors.length, lines, items: out, id: target.id };
}
