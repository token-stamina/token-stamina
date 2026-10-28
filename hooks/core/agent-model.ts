// PreToolUse hook (matcher Agent), ported from scripts/agent-model.js: when usage is RED,
// downgrade the model of subagent calls that did not choose one. Never blocks; any error should
// map to a no-op pass. No permissionDecision is emitted, so the user's normal permission flow is
// untouched.
//
// Maps directly onto the mods `tool.call {tool:'Agent'} -> next({...e, model})` pattern (PLAN-0.5
// -mods.md §3): `decide()` was already designed (in the original) to take an injectable
// `opts.definitionHasModel` function, so it stays pure as-is -- register.ts's `tool.call` handler
// calls `decide(input, usage, cfg, now, opts)` and, on `action === 'inject'`, calls
// `next({...e, model: d.model})`.
//
// `definitionHasModel` itself still does its own fs reads (agent `.md` frontmatter lookup in the
// project and user `.claude/agents` dirs) via Node's built-in `node:fs`/`node:os`/`node:path` --
// those modules are available in every Node runtime (confirmed, used for local verification here),
// but whether a mods hook sandbox permits direct `node:fs` access (as opposed to only `$.fs`) is
// unconfirmed on this PC and is an open question beyond PLAN §7; if not permitted, register.ts
// must replace the default with an `$.fs`-based implementation and inject it via `opts`, which
// the original design already supports.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assess, attributed, type PaceConfig, type PaceState } from './pacer.ts';
import { textProtected } from './decisions.ts';

export const BUILTIN_WITH_MODEL = new Set(['explore', 'statusline-setup', 'claude-code-guide']);

export function includesAny(text: string, words: unknown[] | undefined): string | null {
  for (const w of words || []) if (text.includes(String(w).toLowerCase())) return String(w);
  return null;
}

// Does the agent definition (.md frontmatter) pin a model? Searches project and user agent dirs.
export function definitionHasModel(name: string | undefined, cwd: string | undefined, homeDir?: string): boolean {
  if (!name || /[\\/]/.test(name)) return false;
  if (BUILTIN_WITH_MODEL.has(String(name).toLowerCase())) return true;
  const dirs: string[] = [];
  if (cwd) dirs.push(join(cwd, '.claude', 'agents'));
  dirs.push(join(homeDir || homedir(), '.claude', 'agents'));
  for (const d of dirs) {
    let txt: string;
    try {
      txt = readFileSync(join(d, name + '.md'), 'utf8');
    } catch (e) {
      continue;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt);
    if (!m) continue;
    const mm = /^model:\s*(\S+)/m.exec(m[1]);
    if (mm && mm[1].toLowerCase() !== 'inherit') return true;
  }
  return false;
}

export interface AgentModelMsgTable {
  // g is only passed for the yellow fleet row (F); without it the text is the original red one.
  judgment: (w: string | null | undefined, g?: string) => string;
  suggest: (w: string | null | undefined, m: string) => string;
  inject: (w: string | null | undefined, m: string) => string;
  // Fleet rows (DESIGN-v2 §5.3). n = running subagents in this session (this call not included),
  // dist = model mix ('' when unknown), g = 'no_state' | 'stale' | 'green' | 'yellow' | 'red'.
  fleetAdvise: (n: number, dist: string, g: string) => string;
  fleetInject: (n: number, m: string, g: string, w: string | null | undefined) => string;
  fleetSuggest: (n: number, m: string, g: string, w: string | null | undefined) => string;
  fleetSuffix: (n: number) => string;
  fleetTrunc: () => string;
  // Concurrent interactive sessions (DESIGN-v2 §9.2), appended to fleet-row text only when sessions > 0.
  fleetSessions: (s: number) => string;
  // Explicit upper-tier model rows (DESIGN-v2 §8.2). req = the model the caller asked for, to = the
  // model put in its place, why = pace/pressure text from explicitWhy, marker = first keepModelMarker.
  explicitInject: (req: string, to: string, why: string, marker: string) => string;
  explicitSuggest: (req: string, to: string, why: string, marker: string) => string;
  explicitKept: (req: string, w: string) => string; // row Q, only with explicitDowngradeVerbose
  escalationKept: (req: string) => string; // row Q''
  agentDefault: (m: string) => string;
  explicitWhy: (g: string, w: string | null | undefined, n: number | null, s: number | null) => string;
}

// Upper bound of one fleet scan (scripts/fleet.js MAX_SCAN); quoted in the "truncated" note.
export const FLEET_SCAN_CAP = 64;

const enPace = (g: string, w: string | null | undefined) =>
  g === 'yellow' ? 'usage is slightly over pace (' + w + ' yellow)' : 'usage is over pace (' + w + ' red)';
const koPace = (g: string, w: string | null | undefined) =>
  g === 'yellow' ? '사용 속도가 약간 빨라요(' + w + ' 노랑)' : '사용 속도가 빨라요(' + w + ' 빨강)';
const koPaceBecause = (g: string, w: string | null | undefined) =>
  g === 'yellow' ? '사용 속도가 약간 빠르고(' + w + ' 노랑)' : '사용 속도가 빠르고(' + w + ' 빨강)';
const enWhy = (g: string) =>
  g === 'green' ? 'Budget has room (green). If they are repetitive or collection work, consider model="sonnet".'
    : (g === 'stale' ? 'The usage record is old' : 'There is no usage record') + ', so no model is downgraded. Start only the subagents you really need.';
const koWhy = (g: string) =>
  g === 'green' ? '예산은 여유 있어요(🟢). 반복·수집 작업이면 model="sonnet" 을 고려하세요.'
    : (g === 'stale' ? '한도 기록이 오래돼서' : '한도 기록이 없어서') + ' 모델을 강등하지는 않아요. 꼭 필요한 하위 에이전트만 띄우세요.';

export const T: Record<string, AgentModelMsgTable> = {
  en: {
    judgment: (w, g) => g === 'yellow'
      ? 'Token Stamina: ' + enPace(g, w) + '. This looks like a judgment task so no model was forced; consider model="sonnet" if it does not need the strongest model.'
      : 'Token Stamina: usage is over pace (' + w + ' red). This looks like a judgment task so no model was forced; consider model="sonnet" if it does not need the strongest model.',
    suggest: (w, m) => 'Token Stamina: usage is over pace (' + w + ' red). Consider model="' + m + '" for this subagent.',
    inject: (w, m) => 'Token Stamina: usage is over pace (' + w + ' red), so model="' + m + '" was set for this subagent. Pass an explicit model to override.',
    fleetAdvise: (n, dist, g) => 'Token Stamina: ' + n + ' subagents are running in this session' + (dist ? ' (' + dist + ')' : '') + '. ' + enWhy(g),
    fleetInject: (n, m, g, w) => 'Token Stamina: ' + enPace(g, w) + ' and ' + n + ' subagents are running, so model="' + m + '" was set for this subagent. Pass an explicit model to override.',
    fleetSuggest: (n, m, g, w) => 'Token Stamina: ' + enPace(g, w) + ' and ' + n + ' subagents are running. Consider model="' + m + '" for this subagent.',
    fleetSuffix: (n) => ' ' + n + ' subagents are running at the same time right now.',
    fleetTrunc: () => ' (More than ' + FLEET_SCAN_CAP + ' subagent records; only the newest ' + FLEET_SCAN_CAP + ' were counted.)',
    fleetSessions: (s) => ' ' + s + ' other interactive sessions are also active.',
    explicitInject: (req, to, why, marker) => 'Token Stamina: usage is running fast (' + why + '), so model="' + to + '" was set instead of the requested ' + req
      + '. If ' + req + ' is really needed, add \'' + marker + '\' to the description or start the same task again.',
    explicitSuggest: (req, to, why, marker) => 'Token Stamina: usage is running fast (' + why + '). Consider model="' + to + '" instead of the requested ' + req
      + '. If ' + req + ' is really needed, add \'' + marker + '\' to the description.',
    explicitKept: (req, w) => 'Token Stamina: this looks like a judgment task (' + w + '), so the requested ' + req + ' was kept.',
    escalationKept: (req) => 'Token Stamina: the same task was started again, so ' + req + ' was allowed.',
    agentDefault: (m) => 'Token Stamina: the default subagent model is set to ' + m + ', so model="' + m + '" was set for this subagent. Pass an explicit model to override.',
    explicitWhy: (g, w, n, s) => g === 'yellow'
      ? w + ' yellow, ' + (s !== null ? s + ' other sessions + ' : '') + n + ' subagents running'
      : w + ' red',
  },
  ko: {
    judgment: (w, g) => g === 'yellow'
      ? 'Token Stamina: ' + koPace(g, w) + '. 판단이 필요한 작업으로 보여 모델을 강제하지 않았어요. 가장 강한 모델이 필요 없다면 model="sonnet" 을 고려하세요.'
      : 'Token Stamina: 사용 속도가 빨라요(' + w + ' 빨강). 판단이 필요한 작업으로 보여 모델을 강제하지 않았어요. 가장 강한 모델이 필요 없다면 model="sonnet" 을 고려하세요.',
    suggest: (w, m) => 'Token Stamina: 사용 속도가 빨라요(' + w + ' 빨강). 이 하위 에이전트는 model="' + m + '" 을 고려하세요.',
    inject: (w, m) => 'Token Stamina: 사용 속도가 빨라서(' + w + ' 빨강) 이 하위 에이전트에 model="' + m + '" 을 지정했어요. 바꾸려면 model 을 명시해서 호출하세요.',
    fleetAdvise: (n, dist, g) => 'Token Stamina: 이 세션에서 하위 에이전트 ' + n + '개가 실행 중이에요' + (dist ? '(' + dist + ')' : '') + '. ' + koWhy(g),
    fleetInject: (n, m, g, w) => 'Token Stamina: ' + koPaceBecause(g, w) + ' 하위 에이전트 ' + n + '개가 실행 중이라 이 하위 에이전트에 model="' + m + '" 을 지정했어요. 바꾸려면 model 을 명시해서 호출하세요.',
    fleetSuggest: (n, m, g, w) => 'Token Stamina: ' + koPaceBecause(g, w) + ' 하위 에이전트 ' + n + '개가 실행 중이에요. 이 하위 에이전트는 model="' + m + '" 을 고려하세요.',
    fleetSuffix: (n) => ' 지금 하위 에이전트 ' + n + '개가 동시에 실행 중이에요.',
    fleetTrunc: () => ' (하위 에이전트 기록이 ' + FLEET_SCAN_CAP + '개를 넘어 최근 ' + FLEET_SCAN_CAP + '개만 셌어요.)',
    fleetSessions: (s) => ' 다른 대화형 세션 ' + s + '개도 동시에 실행 중이에요.',
    explicitInject: (req, to, why, marker) => 'Token Stamina: 사용 속도가 빨라서(' + why + ') 지정한 ' + req + ' 대신 model="' + to + '" 을 넣었어요. 꼭 필요하면 설명에 \''
      + marker + '\' 를 붙이거나 같은 작업을 다시 띄우세요.',
    explicitSuggest: (req, to, why, marker) => 'Token Stamina: 사용 속도가 빨라요(' + why + '). 지정한 ' + req + ' 대신 model="' + to + '" 을 고려하세요. 꼭 필요하면 설명에 \''
      + marker + '\' 를 붙이세요.',
    explicitKept: (req, w) => 'Token Stamina: 판단이 필요한 작업으로 보여(' + w + ') 지정한 ' + req + ' 을 그대로 뒀어요.',
    escalationKept: (req) => 'Token Stamina: 같은 작업을 다시 띄워 ' + req + ' 을 허용했어요.',
    agentDefault: (m) => 'Token Stamina: 하위 에이전트 기본 모델이 ' + m + ' 로 설정돼 있어서 이 하위 에이전트에 model="' + m + '" 을 지정했어요. 바꾸려면 model 을 명시해서 호출하세요.',
    explicitWhy: (g, w, n, s) => g === 'yellow'
      ? w + ' 노랑, ' + (s !== null ? '동시 세션 ' + s + ' + ' : '') + '에이전트 ' + n + '개 실행 중'
      : w + ' 빨강',
  },
};

// start_session wording (kind 'session'), mirror of scripts/agent-model.js T_SESSION: rows naming the target say "this
// new session", never "this subagent"; the keep marker goes in the session title or prompt. Other rows are T's.
export const T_SESSION: Record<string, Partial<AgentModelMsgTable>> = {
  en: {
    suggest: (w, m) => 'Token Stamina: usage is over pace (' + w + ' red). Consider model="' + m + '" for this new session.',
    inject: (w, m) => 'Token Stamina: usage is over pace (' + w + ' red), so model="' + m + '" was set for this new session. Pass an explicit model to override.',
    fleetInject: (n, m, g, w) => 'Token Stamina: ' + enPace(g, w) + ' and ' + n + ' subagents are running, so model="' + m + '" was set for this new session. Pass an explicit model to override.',
    fleetSuggest: (n, m, g, w) => 'Token Stamina: ' + enPace(g, w) + ' and ' + n + ' subagents are running. Consider model="' + m + '" for this new session.',
    explicitInject: (req, to, why, marker) => 'Token Stamina: usage is running fast (' + why + '), so model="' + to + '" was set for this new session instead of the requested ' + req
      + '. If ' + req + ' is really needed, add \'' + marker + '\' to the session title or prompt, or start the same session again.',
    explicitSuggest: (req, to, why, marker) => 'Token Stamina: usage is running fast (' + why + '). Consider model="' + to + '" for this new session instead of the requested ' + req
      + '. If ' + req + ' is really needed, add \'' + marker + '\' to the session title or prompt.',
    escalationKept: (req) => 'Token Stamina: the same session was started again, so ' + req + ' was allowed.',
  },
  ko: {
    suggest: (w, m) => 'Token Stamina: 사용 속도가 빨라요(' + w + ' 빨강). 이 새 세션은 model="' + m + '" 을 고려하세요.',
    inject: (w, m) => 'Token Stamina: 사용 속도가 빨라서(' + w + ' 빨강) 이 새 세션에 model="' + m + '" 을 지정했어요. 바꾸려면 model 을 명시해서 세션을 띄우세요.',
    fleetInject: (n, m, g, w) => 'Token Stamina: ' + koPaceBecause(g, w) + ' 하위 에이전트 ' + n + '개가 실행 중이라 이 새 세션에 model="' + m + '" 을 지정했어요. 바꾸려면 model 을 명시해서 세션을 띄우세요.',
    fleetSuggest: (n, m, g, w) => 'Token Stamina: ' + koPaceBecause(g, w) + ' 하위 에이전트 ' + n + '개가 실행 중이에요. 이 새 세션은 model="' + m + '" 을 고려하세요.',
    explicitInject: (req, to, why, marker) => 'Token Stamina: 사용 속도가 빨라서(' + why + ') 이 새 세션에 지정한 ' + req + ' 대신 model="' + to + '" 을 넣었어요. 꼭 필요하면 세션 제목이나 지시문에 \''
      + marker + '\' 를 붙이거나 같은 세션을 다시 띄우세요.',
    explicitSuggest: (req, to, why, marker) => 'Token Stamina: 사용 속도가 빨라요(' + why + '). 이 새 세션은 지정한 ' + req + ' 대신 model="' + to + '" 을 고려하세요. 꼭 필요하면 세션 제목이나 지시문에 \''
      + marker + '\' 를 붙이세요.',
    escalationKept: (req) => 'Token Stamina: 같은 세션을 다시 띄워 ' + req + ' 을 허용했어요.',
  },
};
export function textsFor(input: { kind?: string } | null | undefined, lang: string | undefined): AgentModelMsgTable {
  const base = T[lang as string] || T.en;
  if (!input || input.kind !== 'session') return base;
  return Object.assign({}, base, T_SESSION[lang as string] || T_SESSION.en) as AgentModelMsgTable;
}

// Protected new session, mirror of scripts/agent-model.js sessionProtected: decisions.ts textProtected() (the one
// protection function, not a copy) on the new session's cwd/title/prompt/background and the caller's cwd. No cwd =
// protected (where it runs is unknown).
export function sessionProtected(input: any, cfg: any): boolean {
  const ti = (input && input.tool_input) || {};
  const cwd = typeof ti.cwd === 'string' ? ti.cwd.trim() : '';
  if (!cwd) return true;
  return !!(textProtected(cwd, cfg) || textProtected(ti.title, cfg) || textProtected(ti.prompt, cfg)
    || textProtected(ti.background, cfg) || textProtected(input && input.cwd, cfg));
}

// start_session -> decide() input shape, mirror of scripts/agent-model.js adaptSession. {input} or {pass: reason}.
export function adaptSession(input: any, cfg: any): { input?: AgentModelInput; pass?: string } {
  const ti = (input && input.tool_input) || {};
  if (ti.context === 'fork') return { pass: 'fork' };
  if (sessionProtected(input, cfg)) return { pass: 'protected' };
  if (ti.initiation === 'offer' && !ti.prompt) return { pass: 'offer_waits' };
  if (ti.target === 'cloud') return { pass: 'cloud' };
  const prompt = (typeof ti.prompt === 'string' ? ti.prompt.slice(0, 600) : '') + ' ' + (typeof ti.background === 'string' ? ti.background.slice(0, 600) : '');
  const t: any = {};
  if (ti.model) t.model = ti.model;
  t.description = typeof ti.title === 'string' ? ti.title : '';
  t.prompt = prompt.trim();
  return { input: Object.assign({}, input, { kind: 'session', tool_input: t }) };
}

export interface AgentModelCfg extends PaceConfig {
  mode?: 'off' | 'suggest' | 'inject';
  lang?: string;
  judgmentKeywords?: string[];
  simpleKeywords?: string[];
  // Fleet (DESIGN-v2 §5.2). Missing -> the defaults below; a non-number threshold or <= 0 switches
  // that row off (conservative: the decision falls back to the pre-fleet one).
  fleet?: boolean;
  fleetShowAt?: number;
  fleetWarnAt?: number;
  fleetHardAt?: number;
  fleetModelFloor?: string;
  fleetAdvise?: boolean;
  // Concurrent sessions (DESIGN-v2 §9.2): thresholds on running + sessions; same off rule as above.
  fleetTotalWarnAt?: number;
  fleetTotalHardAt?: number;
  // Explicit upper-tier model (DESIGN-v2 §8.5). A missing explicitDowngrade means 'off' here, so a
  // config without the key keeps the old has_model pass; the shipped default comes from
  // config.default.json. Any other unknown value is read as 'suggest' (never mutates the input).
  explicitDowngrade?: string;
  explicitDowngradeTiers?: string[];
  explicitDowngradeTo?: string;
  keepModelMarker?: string[];
  escalateWithinSec?: number;
  explicitDowngradeVerbose?: boolean;
  // Approved default for subagent calls without a model (haiku|sonnet; anything else = off).
  agentModelDefault?: string | null;
}

export const FLEET_DEFAULTS = { fleetWarnAt: 3, fleetHardAt: 5, fleetModelFloor: 'sonnet', fleetTotalWarnAt: 4, fleetTotalHardAt: 7 } as const;
export const EXPLICIT_DEFAULTS = {
  explicitDowngradeTiers: ['opus', 'fable'],
  explicitDowngradeTo: 'sonnet',
  keepModelMarker: ['keep-model', '모델 유지'],
  escalateWithinSec: 1800,
};

// Session-scoped subagent pressure from fleet.pressure(): running excludes this call itself.
// sessions = other interactive sessions active now (fleet.scanSessions); missing/null = not known.
export interface FleetPressureInput { running: number; models?: Record<string, number>; truncated?: boolean; sessions?: number | null }

// Anything that is not {running: finite integer >= 0} is treated as "no fleet input" (null), so a
// garbage value can never change a decision. models keeps only finite integer >= 0 counts.
export function sanitizeFleet(x: unknown): FleetPressureInput | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const r = (x as { running?: unknown }).running;
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 0) return null;
  const out: FleetPressureInput = { running: r };
  const m = (x as { models?: unknown }).models;
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const models: Record<string, number> = {};
    for (const k of Object.keys(m)) {
      const v = (m as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) models[k] = v;
    }
    out.models = models;
  }
  if ((x as { truncated?: unknown }).truncated === true) out.truncated = true;
  const s = (x as { sessions?: unknown }).sessions;
  if (typeof s === 'number' && Number.isInteger(s) && s >= 0) out.sessions = s;
  return out;
}

// Is `model` one of the upper tiers? Matches the alias itself ('opus') or a full id carrying the
// tier as a separated part ('claude-opus-4-7'); 'sonnet', 'haiku', unknown ids -> false.
// tiers missing -> ['opus','fable']; [] or garbage -> nothing is upper.
export function isUpperModel(model: unknown, tiers?: unknown): boolean {
  if (typeof model !== 'string' || !model) return false;
  const list = tiers === undefined || tiers === null ? EXPLICIT_DEFAULTS.explicitDowngradeTiers : tiers;
  if (!Array.isArray(list)) return false;
  const parts = model.toLowerCase().split(/[^a-z0-9]+/);
  for (const t of list) {
    if (typeof t === 'string' && t && parts.includes(t.toLowerCase())) return true;
  }
  return false;
}

// Escalation key: sha1 of the lowercased description with runs of whitespace collapsed, 16 hex.
// Empty/blank/non-string description -> null (no key, so no escalation is ever possible).
export function descHash(desc: unknown): string | null {
  if (typeof desc !== 'string') return null;
  const norm = desc.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  return createHash('sha1').update(norm, 'utf8').digest('hex').slice(0, 16);
}

// Keep-model marker in the already-lowercased description + prompt head; returns the marker or null.
export function hasKeepMarker(text: string, markers?: unknown): string | null {
  const list = markers === undefined || markers === null ? EXPLICIT_DEFAULTS.keepModelMarker : markers;
  if (!Array.isArray(list)) return null;
  return includesAny(text, list.filter((m) => typeof m === 'string' && m));
}

export interface LedgerEntry { ts?: number; requested?: string; kind?: string }
export type ExplicitLedger = Record<string, Record<string, LedgerEntry>>;

// Was this same task (session sid, kind, hash) downgraded within the last `within` seconds?
// Ledger entries are keyed `<kind>:<hash>` or bare `<hash>` (then entry.kind, missing = 'agent').
// Anything malformed -> false (the downgrade stands).
export function escalated(ledger: unknown, sid: unknown, kind: string, hash: string | null, now: number, within: unknown): boolean {
  if (!hash || typeof sid !== 'string' || !sid) return false;
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return false;
  const win = typeof within === 'number' && isFinite(within) && within > 0 ? within : null;
  if (win === null) return false;
  const book = (ledger as Record<string, unknown>)[sid];
  if (!book || typeof book !== 'object' || Array.isArray(book)) return false;
  const b = book as Record<string, unknown>;
  const cands: [unknown, string][] = [[b[kind + ':' + hash], kind], [b[hash], '']];
  for (const [e, implied] of cands) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const ent = e as LedgerEntry;
    const ek = implied || (typeof ent.kind === 'string' ? ent.kind : 'agent');
    if (ek !== kind) continue;
    if (typeof ent.ts !== 'number' || !isFinite(ent.ts)) continue;
    const age = now - ent.ts;
    if (age >= 0 && age <= win) return true;
  }
  return false;
}

const MODEL_NAMES: Record<string, string> = { F: 'fable', O: 'opus', S: 'sonnet', H: 'haiku', '?': 'unspecified' };
// {'O':2,'S':1} -> 'opus 2 · sonnet 1' (count desc, then key), same order as the status-line token.
export function fleetDist(models: Record<string, number> | undefined): string {
  if (!models) return '';
  return Object.keys(models).filter((k) => models[k] > 0)
    .sort((a, b) => models[b] - models[a] || a.localeCompare(b))
    .map((k) => (MODEL_NAMES[k] || k) + ' ' + models[k]).join(' · ');
}

function fleetThreshold(v: unknown, dflt: number): number | null {
  if (v === undefined || v === null) return dflt;
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : null;
}
export interface AgentModelInput {
  tool_input?: { model?: string; subagent_type?: string; description?: string; prompt?: string };
  cwd?: string;
  session_id?: string;
  // 'agent' (default) or 'session' (start_session adapter, W4b-3); part of the escalation key.
  kind?: string;
}
export interface DecideOpts {
  definitionHasModel?: typeof definitionHasModel;
  homeDir?: string;
  fleet?: FleetPressureInput | null;
  ledger?: ExplicitLedger | null; // explicit-downgrade.json contents (read by run())
}
export interface DecideResult {
  action: 'pass' | 'inject' | 'suggest';
  reason: string;
  model?: string;
  grade?: string | null;
  worst?: string | null;
  message?: string;
  // Present only when a fleet row (A, C, F, G, H with suffix, J) shaped this result.
  fleet_running?: number | null;
  // Explicit rows Q, Q', Q'', R only: the model the caller asked for, and the escalation key.
  requested_model?: string;
  desc_hash?: string;
}

// Pure decision. Returns {action, reason, model?, message?}; action: pass | inject | suggest
//
// Fleet rows (DESIGN-v2 §5.3). With opts.fleet missing/null/garbage, or cfg.fleet === false /
// cfg.fleetShowAt === 0, the result is bit-identical to the pre-fleet decision. The first four
// pass branches (mode_off, has_model, fork, definition_model) never look at the fleet. no_state /
// stale_state / green only ever gain an advisory (suggest, no model): fleet pressure alone never
// downgrades when the budget pressure is unconfirmed or absent. The judgment-keyword exception is
// checked before every fleet row that could set a model (F before G, H before J).
//   A no_state|stale, running >= warn  -> suggest fleet_advise_nostate   (fleetAdvise:false -> pass)
//   C green,          running >= warn  -> suggest fleet_advise_green     (fleetAdvise:false -> pass)
//   F yellow, >= warn, judgment word   -> suggest judgment:<w> + fleet suffix
//   G yellow, >= warn, no judgment     -> inject fleet_yellow (simple -> haiku, else sonnet)
//   H red, judgment word               -> suggest judgment:<w> (+ fleet suffix when >= warn)
//   J red, >= hard, no judgment        -> inject fleet_hard_downgrade (simple -> haiku, else fleetModelFloor)
//   I red, < hard, no judgment         -> inject red_downgrade (unchanged)
//   mode 'suggest' turns G/J into suggest with the same model; truncated adds a note to fleet text.
// "running >= warn/hard" above is the fleet pressure: running >= fleetWarnAt, or running + sessions
// >= fleetTotalWarnAt when sessions is known (same shape for hard). Without sessions: as before.
//
// Explicit upper-tier model rows (DESIGN-v2 §8.2). Only the has_model branch changes: an upper-tier
// model (explicitDowngradeTiers) with explicitDowngrade != 'off' is remembered as `requested` and
// evaluation continues in the same order, so fork / definition_model / no_state / stale_state keep
// it structurally (row O: never a downgrade, and no fleet advice either).
//   M not upper tier                         -> pass has_model (unchanged)
//   N explicitDowngrade 'off' (or missing)   -> pass has_model (unchanged)
//   P no pressure (green, yellow w/o fleet)  -> pass has_model (unchanged)
//   pressure = red || (yellow && fleet pressure); then, in this order:
//   Q   judgment word                        -> pass keep_judgment:<w> (message only if verbose)
//   Q'  keep-model marker                    -> pass keep_marker
//   Q'' same session+kind+desc_hash in the ledger within escalateWithinSec -> pass keep_escalation
//   R   otherwise -> inject explicit_downgrade (explicitDowngrade 'inject' and mode 'inject'), else
//       suggest explicit_suggest; model = explicitDowngradeTo (one step: sonnet; simple words ignored)
function decideBase(
  input: AgentModelInput,
  state: PaceState | null | undefined,
  cfg: AgentModelCfg,
  now: number,
  opts?: DecideOpts,
): DecideResult {
  const o = opts || {};
  const mode = cfg.mode || 'inject';
  if (mode === 'off') return { action: 'pass', reason: 'mode_off' };
  const ti = (input && input.tool_input) || {};
  const xd = explicitMode(cfg.explicitDowngrade);
  const requested = ti.model && xd !== 'off' && isUpperModel(ti.model, cfg.explicitDowngradeTiers) ? String(ti.model) : null;
  if (ti.model && !requested) return { action: 'pass', reason: 'has_model' };
  const st = ti.subagent_type;
  if (st && String(st).toLowerCase() === 'fork') return { action: 'pass', reason: 'fork' };
  const defHas = o.definitionHasModel || definitionHasModel;
  if (st && defHas(st, input.cwd, o.homeDir)) return { action: 'pass', reason: 'definition_model' };
  const a = assess(state, now, cfg);
  const tx = textsFor(input, cfg.lang as string);
  const fl = cfg.fleet === false || cfg.fleetShowAt === 0 ? null : sanitizeFleet(o.fleet);
  const n = fl ? fl.running : 0;
  const warn = fleetThreshold(cfg.fleetWarnAt, FLEET_DEFAULTS.fleetWarnAt);
  const hard = fleetThreshold(cfg.fleetHardAt, FLEET_DEFAULTS.fleetHardAt);
  const totWarn = fleetThreshold(cfg.fleetTotalWarnAt, FLEET_DEFAULTS.fleetTotalWarnAt);
  const totHard = fleetThreshold(cfg.fleetTotalHardAt, FLEET_DEFAULTS.fleetTotalHardAt);
  const ses = fl && typeof fl.sessions === 'number' ? fl.sessions : null;
  const atWarn = !!fl && ((warn !== null && n >= warn) || (ses !== null && totWarn !== null && n + ses >= totWarn));
  const atHard = !!fl && ((hard !== null && n >= hard) || (ses !== null && totHard !== null && n + ses >= totHard));
  const advise = cfg.fleetAdvise !== false;
  const truncOnly = fl && fl.truncated ? tx.fleetTrunc() : '';
  const trunc = (ses ? tx.fleetSessions(ses) : '') + truncOnly;
  if (!a.grade || a.stale) {
    const g = !a.grade ? 'no_state' : 'stale';
    if (!requested && atWarn && advise) {
      return { action: 'suggest', reason: 'fleet_advise_nostate', message: tx.fleetAdvise(n, fleetDist(fl!.models), g) + trunc, fleet_running: n };
    }
    return { action: 'pass', reason: !a.grade ? 'no_state' : 'stale_state' };
  }
  const text = ((ti.description || '') + ' ' + String(ti.prompt || '').slice(0, 600)).toLowerCase();
  if (requested) {
    if (!(a.grade === 'red' || (a.grade === 'yellow' && atWarn))) return { action: 'pass', reason: 'has_model' }; // row P
    const hash = descHash(ti.description);
    const tag: { requested_model: string; desc_hash?: string } = { requested_model: requested };
    if (hash) tag.desc_hash = hash;
    const xjw = includesAny(text, cfg.judgmentKeywords);
    if (xjw) {
      const q: DecideResult = { action: 'pass', reason: 'keep_judgment:' + xjw, grade: a.grade, worst: a.worst, ...tag };
      if (cfg.explicitDowngradeVerbose === true) q.message = tx.explicitKept(requested, xjw);
      return q;
    }
    if (hasKeepMarker(text, cfg.keepModelMarker)) return { action: 'pass', reason: 'keep_marker', grade: a.grade, worst: a.worst, ...tag };
    const within = cfg.escalateWithinSec === undefined || cfg.escalateWithinSec === null ? EXPLICIT_DEFAULTS.escalateWithinSec : cfg.escalateWithinSec;
    if (escalated(o.ledger, input.session_id, input.kind || 'agent', hash, now, within)) {
      return { action: 'pass', reason: 'keep_escalation', grade: a.grade, worst: a.worst, message: tx.escalationKept(requested), ...tag };
    }
    const toRaw = String(cfg.explicitDowngradeTo || EXPLICIT_DEFAULTS.explicitDowngradeTo).toLowerCase();
    const to = toRaw === 'haiku' ? 'haiku' : 'sonnet'; // anything else (an upper tier, garbage): sonnet
    const marks = Array.isArray(cfg.keepModelMarker) ? cfg.keepModelMarker.filter((m) => typeof m === 'string' && m) : [];
    const marker = marks.length ? String(marks[0]) : EXPLICIT_DEFAULTS.keepModelMarker[0];
    const yellow = a.grade === 'yellow';
    const why = tx.explicitWhy(String(a.grade), a.worst, yellow ? n : null, yellow ? ses : null);
    const extra = fl ? { fleet_running: n } : {};
    if (xd === 'inject' && mode === 'inject') {
      return { action: 'inject', reason: 'explicit_downgrade', model: to, grade: a.grade, worst: a.worst,
        message: tx.explicitInject(requested, to, why, marker) + truncOnly, ...extra, ...tag };
    }
    return { action: 'suggest', reason: 'explicit_suggest', model: to, grade: a.grade, worst: a.worst,
      message: tx.explicitSuggest(requested, to, why, marker) + truncOnly, ...extra, ...tag };
  }
  if (a.grade !== 'red') {
    if (a.grade === 'green' && atWarn && advise) {
      return { action: 'suggest', reason: 'fleet_advise_green', grade: a.grade, worst: a.worst,
        message: tx.fleetAdvise(n, fleetDist(fl!.models), 'green') + trunc, fleet_running: n };
    }
    if (a.grade === 'yellow' && atWarn) {
      const yjw = includesAny(text, cfg.judgmentKeywords);
      if (yjw) {
        return { action: 'suggest', reason: 'judgment:' + yjw, grade: a.grade, worst: a.worst,
          message: tx.judgment(a.worst, 'yellow') + tx.fleetSuffix(n) + trunc, fleet_running: n };
      }
      const ym = includesAny(text, cfg.simpleKeywords) ? 'haiku' : 'sonnet';
      if (mode === 'suggest') {
        return { action: 'suggest', reason: 'fleet_yellow', model: ym, grade: a.grade, worst: a.worst,
          message: tx.fleetSuggest(n, ym, 'yellow', a.worst) + trunc, fleet_running: n };
      }
      return { action: 'inject', reason: 'fleet_yellow', model: ym, grade: a.grade, worst: a.worst,
        message: tx.fleetInject(n, ym, 'yellow', a.worst) + trunc, fleet_running: n };
    }
    return { action: 'pass', reason: 'grade_' + a.grade };
  }
  const jw = includesAny(text, cfg.judgmentKeywords);
  if (jw) {
    if (atWarn) {
      return { action: 'suggest', reason: 'judgment:' + jw, grade: a.grade, worst: a.worst,
        message: tx.judgment(a.worst) + tx.fleetSuffix(n) + trunc, fleet_running: n };
    }
    return { action: 'suggest', reason: 'judgment:' + jw, grade: a.grade, worst: a.worst, message: tx.judgment(a.worst) };
  }
  const simple = !!includesAny(text, cfg.simpleKeywords);
  if (atHard) {
    const floorRaw = String(cfg.fleetModelFloor || FLEET_DEFAULTS.fleetModelFloor).toLowerCase();
    const floor = floorRaw === 'haiku' ? 'haiku' : 'sonnet'; // anything else: sonnet (same as row I)
    const jm = simple ? 'haiku' : floor;
    if (mode === 'suggest') {
      return { action: 'suggest', reason: 'fleet_hard_downgrade', model: jm, grade: a.grade, worst: a.worst,
        message: tx.fleetSuggest(n, jm, 'red', a.worst) + trunc, fleet_running: n };
    }
    return { action: 'inject', reason: 'fleet_hard_downgrade', model: jm, grade: a.grade, worst: a.worst,
      message: tx.fleetInject(n, jm, 'red', a.worst) + trunc, fleet_running: n };
  }
  const model = simple ? 'haiku' : 'sonnet';
  if (mode === 'suggest') {
    return { action: 'suggest', reason: 'suggest_mode', model, grade: a.grade, worst: a.worst, message: tx.suggest(a.worst, model) };
  }
  return { action: 'inject', reason: 'red_downgrade', model, grade: a.grade, worst: a.worst, message: tx.inject(a.worst, model) };
}

// Approved agentModelDefault (haiku|sonnet, set by W9-1 apply): a subagent call with no model gets it, on top of decideBase.
// Skips: mode other than inject, start_session calls, fork / definition_model / mode_off, any model already chosen, judgment
// keywords (the exception stays). Against a pressure downgrade the LOWER model wins.
const AD_RANK: Record<string, number> = { haiku: 0, sonnet: 1 };
export function decide(input: AgentModelInput, state: PaceState | null | undefined, cfg: AgentModelCfg, now: number, opts?: DecideOpts): DecideResult {
  const d = decideBase(input, state, cfg, now, opts);
  const def = cfg && cfg.agentModelDefault;
  if (def !== 'haiku' && def !== 'sonnet') return d;
  if (cfg.mode && cfg.mode !== 'inject') return d;
  if (input && input.kind === 'session') return d;
  const ti: any = (input && input.tool_input) || {};
  if (ti.model || ['mode_off', 'fork', 'definition_model'].includes(d.reason)) return d;
  const text = ((ti.description || '') + ' ' + String(ti.prompt || '').slice(0, 600)).toLowerCase();
  if (includesAny(text, cfg.judgmentKeywords)) return d;
  let model: string = def;
  if (d.action === 'inject' && d.model !== undefined && AD_RANK[d.model] !== undefined && AD_RANK[d.model] < AD_RANK[def]) model = d.model;
  if (d.action === 'inject' && model === d.model) return d;
  const tx = textsFor(input, cfg.lang as string);
  return { action: 'inject', reason: 'agent_default', model, grade: d.grade || null, worst: d.worst || null, message: tx.agentDefault(model) };
}

// explicitDowngrade: missing/null/false/'off' -> 'off'; 'inject' -> 'inject'; anything else -> 'suggest'.
function explicitMode(v: unknown): 'off' | 'suggest' | 'inject' {
  if (v === undefined || v === null || v === false || v === 'off') return 'off';
  return v === 'inject' ? 'inject' : 'suggest';
}

export function output(input: AgentModelInput, d: DecideResult): Record<string, unknown> | null {
  if (d.action === 'inject') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: Object.assign({}, input.tool_input, { model: d.model }),
        additionalContext: d.message,
      },
    };
  }
  if (d.action === 'suggest') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.message } };
  }
  // pass with a message (keep_escalation, verbose keep_judgment): context only, never updatedInput.
  if (d.action === 'pass' && d.message) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.message } };
  }
  return null;
}

// Convenience re-export so register.ts's `tool.call` handler can attribute d.message the same
// way the original `run()` did (pace.attributed), without importing pacer.ts separately.
export { attributed };

// NOTE: the original module's impure `run(raw)` (reads stdin, pace.loadConfig/readState/
// appendEvent, lang.withLang) is NOT ported here -- that is register.ts's `tool.call {tool:'Agent'}`
// handler's job (desktop-only, unverified on this PC).
