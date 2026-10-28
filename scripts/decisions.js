'use strict';
// W9-1e: pure decision rules (DESIGN-v2-integrated.md 10.8). Mirror of hooks/core/decisions.ts. No fs, no LLM.
// Boundary: every decision / settings document comes from a page a person typed into. It is DATA only:
// kinds are an enum, params a fixed per-kind schema, targets must exist on the local board, and no string from it is ever
// used as a command, a path or a prompt. Model ids in ops come from code constants, never from the document.
const crypto = require('crypto');

const KINDS = ['session_model', 'session_clear', 'agent_default_model', 'fleet_threshold'];
const KIND_SHORT = { session_model: 'sm', session_clear: 'sc', agent_default_model: 'am', fleet_threshold: 'ft' };
// Old design-doc spelling of the agent kind; accepted on input, never emitted.
const KIND_ALIAS = { agent_model_default: 'agent_default_model' };
const normKind = (k) => (typeof k === 'string' && Object.prototype.hasOwnProperty.call(KIND_ALIAS, k) ? KIND_ALIAS[k] : k);
const LOWER = ['sonnet', 'haiku'];
const UPPER = ['opus', 'fable'];
const RANK = { haiku: 0, sonnet: 1, opus: 2, fable: 2 };
const WEIGHT = { haiku: 1, sonnet: 3, opus: 5, fable: 5 }; // same table as scripts/report.js (relative price)
// Ids handed to set_session_model. Code constants: the decision document can never choose the id string.
const MODEL_IDS = { sonnet: 'sonnet', haiku: 'haiku' };
const DECISION_DEFAULTS = {
  applyMode: 'manual', proposalTtlSec: 7200, heldTtlSec: 7200, rejectCooldownSec: 86400, applyMaxPerRun: 3, autoScope: [],
  savingTurns: 10, agentShareProposeAt: 0.3, stateMaxAgeSec: 21600,
};
const SETTINGS_KEYS = ['fleetWarnAt', 'fleetHardAt', 'fleetTotalWarnAt', 'fleetTotalHardAt', 'fleetModelFloor', 'agentModelDefault',
  'applyMode', 'autoScope', 'dashboardMaskTitles'];
// sessionRules (DESIGN 10.8.3) is NOT allowed: no code reads it yet, so accepting it would show "applied" for a rule
// that changes nothing (W7). It is rejected as not_allowed until exclude/pin are actually wired.
const AUTO_SCOPE = ['session_model', 'agent_default_model', 'fleet_threshold'];
const PID_RE = /^(sm|sc|am|ft)-[0-9a-f]{12}$/;
const SID_RE = /^[A-Za-z0-9_-]{1,80}$/;
// window codes: '10_turns' (last 10 turns of a session) | 'board_tail' (the transcript tails the board rows were measured on).
const SAVING_NOTE = { ko: '추정 — 지난 10턴과 같은 사용이 이어진다면(지난 10턴 환산)', en: 'estimate - converted from the last 10 turns, if usage continues the same way' };
const TERMINAL = ['applied', 'failed', 'refused', 'expired'];

const isNum = (x) => typeof x === 'number' && isFinite(x);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const cfgOf = (cfg) => Object.assign({}, DECISION_DEFAULTS, cfg || {});
const iso = (s) => (isNum(s) ? new Date(s * 1000).toISOString() : null);
const epoch = (t) => { const v = Date.parse(t); return isFinite(v) ? Math.floor(v / 1000) : null; };
const hash12 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
// Own-key setter: "__proto__" and friends stay plain data keys.
const put = (o, k, v) => { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); return o; };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function family(model) {
  const m = String(model || '').toLowerCase();
  for (const f of ['fable', 'opus', 'sonnet', 'haiku']) if (m.includes(f)) return f;
  return null;
}

// Protection (one function for board rows and decisions). Case-insensitive.
// Shape: folders named like managerProtectSegments (default: trading) anywhere in the path protect (whole path segments,
// case-insensitive; a config list replaces the default). Lists: managerExcludeCwd + excludeCwd (bot work folders) as substrings, managerProtectKeywords
// (code default when the config has none) as substrings of the whole path.
const PROTECT_KEYWORDS_DEFAULT = ['trade', 'trading'];
const PROTECT_SEGMENTS = ['trading'];
function protectSegments(cfg) {
  const l = cfg && cfg.managerProtectSegments;
  const src = Array.isArray(l) ? l : PROTECT_SEGMENTS;
  return src.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase());
}
function protectTerms(cfg) {
  const c = cfg || {};
  const out = [];
  const lists = [c.managerExcludeCwd, c.excludeCwd, Array.isArray(c.managerProtectKeywords) ? c.managerProtectKeywords : PROTECT_KEYWORDS_DEFAULT];
  for (const l of lists) {
    if (Array.isArray(l)) for (const x of l) if (typeof x === 'string' && x.trim()) out.push(x.trim().toLowerCase());
  }
  return out;
}
function textProtected(s, cfg) {
  const low = String(s || '').toLowerCase();
  if (!low) return false;
  const segs = protectSegments(cfg);
  if (segs.length && low.split(/[\\/]+/).some((seg) => segs.includes(seg.trim()))) return true;
  return protectTerms(cfg).some((t) => low.includes(t));
}
// Board row (+ optional title / live cwd) -> protected. Shape and guard: the row flag OR any text match.
function rowProtected(row, cfg, extra) {
  if (!row) return false;
  if (row.protected === true) return true;
  const e = extra || {};
  return textProtected(row.cwd_tail, cfg) || textProtected(row.title, cfg) || textProtected(e.title, cfg) || textProtected(e.cwd, cfg);
}

const targetKey = (kind, target) => kind + '|' + (target && (target.sid || target.scope) || '');
function pidOf(kind, target, params, anchor) {
  return KIND_SHORT[kind] + '-' + hash12(targetKey(kind, target) + '|' + JSON.stringify(params) + '|' + String(anchor));
}

function ledgerRows(ledger) {
  if (Array.isArray(ledger)) return ledger.filter(isObj);
  return ledger && Array.isArray(ledger.rows) ? ledger.rows.filter(isObj) : [];
}

// Suppressed by the ledger: rejected same (kind,target) < rejectCooldownSec, held < heldTtlSec.
function suppressed(kind, target, ledger, now, c) {
  const key = targetKey(kind, target);
  for (const r of ledgerRows(ledger)) {
    if (r.key !== key) continue;
    const t = epoch(r.decided_at) || epoch(r.recorded_at);
    if (t === null) continue;
    if (r.status === 'rejected' && now - t < c.rejectCooldownSec) return true;
    if (r.status === 'held' && now - t < c.heldTtlSec) return true;
  }
  return false;
}

function saving(tokens, lang, window) {
  return { tokens: isNum(tokens) ? Math.max(0, Math.round(tokens)) : null, window: window || '10_turns', note: SAVING_NOTE[lang] || SAVING_NOTE.en };
}

// Pure. rows = board rows (epoch last_user_ts, ISO updated_at); account = {grade, stale}; extra = {fleetPeak24h?}.
// Returns proposal docs (DESIGN 10.8.2). Never proposes for a stale account, never forecasts.
function proposals(rows, account, ledger, now, cfg, extra) {
  const c = cfgOf(cfg);
  const a = account || {};
  const lang = c.lang === 'ko' ? 'ko' : 'en';
  const out = [];
  // Board sids are transcript ids; the app's session tools use their own ids. A session card can only be applied when the
  // refresh command handed in an app session entry whose id field equals the board sid exactly (extra.mapped); anything
  // else is advice only (never a guess from cwd, time or title).
  const mapped = extra && extra.mapped ? new Set(extra.mapped) : new Set();
  const add = (kind, target, params, anchor, basis, est, revert, prot) => {
    if (suppressed(kind, target, ledger, now, c)) return;
    const measured = epoch(basis.measured_at);
    const unmapped = !!(target && target.sid) && !mapped.has(target.sid);
    const doc = {
      pid: pidOf(kind, target, params, anchor), kind, target, params, basis, est_saving: est, revert,
      protected: !!prot, advice_only: !!prot || unmapped, status: 'proposed',
      ttl_until: iso((measured !== null ? measured : now) + c.proposalTtlSec), created_at: iso(now),
    };
    if (unmapped) doc.unmapped = true;
    out.push(doc);
  };
  if (a.stale) return out;
  const list = Array.isArray(rows) ? rows.filter((r) => isObj(r) && SID_RE.test(String(r.sid))) : [];
  for (const r of list) {
    const prot = rowProtected(r, c);
    const fam = family(r.model);
    if ((a.grade === 'red' || a.grade === 'yellow') && UPPER.includes(fam) && r.fit === 'lower_candidate' && r.j === 0) {
      const to = 'sonnet';
      const ratio = WEIGHT[to] / WEIGHT[fam];
      add('session_model', { sid: r.sid }, { from: fam, to }, r.last_user_ts,
        { metric: 'E3,E1,E6', values: { j: r.j, fit: r.fit, in_med10: r.in_med10, grade: a.grade }, measured_at: r.updated_at },
        saving(isNum(r.in_med10) ? r.in_med10 * c.savingTurns * (1 - ratio) : null, lang),
        { how: 'set_session_model(' + fam + ')', possible: true }, prot);
    }
    if (r.clear_candidate === true) {
      add('session_clear', { sid: r.sid }, {}, r.last_user_ts,
        { metric: 'E4', values: { idle_sec: r.idle_sec, ctx_tokens: r.ctx_tokens }, measured_at: r.updated_at },
        saving(isNum(r.ctx_tokens) ? r.ctx_tokens * c.savingTurns : null, lang),
        { how: 'handoff note only', possible: false }, prot);
    }
  }
  // Agent default: the busiest unprotected upper-tier agent user, grade red/yellow, default not already lower.
  const cur = typeof c.agentModelDefault === 'string' ? c.agentModelDefault : null;
  if ((a.grade === 'red' || a.grade === 'yellow') && !LOWER.includes(cur)) {
    const cand = list.filter((r) => !rowProtected(r, c) && isNum(r.agent_share) && r.agent_share >= c.agentShareProposeAt && r.agents_upper > 0);
    if (cand.length) {
      const tok = cand.reduce((s, r) => s + (r.agent_tokens_done || 0) + (r.agent_tokens_live || 0), 0);
      const maxShare = Math.max(...cand.map((r) => r.agent_share));
      const measured = cand.map((r) => r.updated_at).filter((t) => epoch(t) !== null).sort()[0] || iso(now);
      add('agent_default_model', { scope: 'agents' }, { from: cur, to: 'sonnet' }, Math.floor(now / 86400),
        { metric: 'E5', values: { agent_share: maxShare, sessions: cand.length, agent_tokens: tok }, measured_at: measured },
        saving(tok * (1 - WEIGHT.sonnet / WEIGHT.opus), lang, 'board_tail'),
        { how: 'config.prev.json', possible: true }, false);
    }
  }
  // Fleet threshold (control, no saving number): red and the 24h peak reached the warn line -> warn one earlier.
  const peak = extra && isNum(extra.fleetPeak24h) ? extra.fleetPeak24h : null;
  const w = isNum(c.fleetWarnAt) ? c.fleetWarnAt : 3, h = isNum(c.fleetHardAt) ? c.fleetHardAt : 5;
  if (a.grade === 'red' && peak !== null && peak >= w && w > 1) {
    const nw = w - 1, nh = Math.max(nw, h - 1);
    add('fleet_threshold', { scope: 'fleet' }, { fleetWarnAt: nw, fleetHardAt: nh }, Math.floor(now / 86400),
      { metric: 'E7', values: { peak_24h: peak, fleetWarnAt: w, fleetHardAt: h }, measured_at: a.measured_at || iso(now) },
      { tokens: null, window: null, note: lang === 'ko' ? '절약 수치 없음 — 제어 제안' : 'no saving number - control proposal' },
      { how: 'config.prev.json', possible: true }, false);
  }
  return out;
}

// ---- settings (DESIGN 10.8.3 allow table) ----
const int150 = (v) => Number.isInteger(v) && v >= 1 && v <= 50;

// Pure. requested = settings/requested doc ({values:{...}} or the values themselves); cfg = effective (default+user) config.
function validateSettings(requested, cfg) {
  const c = cfgOf(cfg);
  const accepted = {}, rejected = {};
  const rej = (k, value, reason, detail) => put(rejected, k, detail ? { value, reason, detail } : { value, reason });
  const vals = isObj(requested) && isObj(requested.values) ? requested.values : (isObj(requested) ? requested : {});
  for (const k of Object.keys(vals)) {
    const v = vals[k];
    if (!SETTINGS_KEYS.includes(k)) { rej(k, v, 'not_allowed'); continue; }
    if (k.startsWith('fleet') && k.endsWith('At')) {
      if (typeof v !== 'number') rej(k, v, 'type');
      else if (!int150(v)) rej(k, v, 'range');
      else accepted[k] = v;
    } else if (k === 'fleetModelFloor' || k === 'agentModelDefault') {
      if (LOWER.includes(v)) accepted[k] = v; else rej(k, v, 'enum');
    } else if (k === 'applyMode') {
      if (v === 'auto') { rej(k, v, 'locked'); accepted.applyMode = 'approve'; } else if (v === 'manual' || v === 'approve') accepted[k] = v; else rej(k, v, 'enum');
    } else if (k === 'autoScope') {
      const n = Array.isArray(v) ? v.map(normKind) : null;
      if (n && n.length <= AUTO_SCOPE.length && n.every((x) => AUTO_SCOPE.includes(x)) && new Set(n).size === n.length) accepted[k] = n;
      else rej(k, v, 'enum');
    } else if (k === 'dashboardMaskTitles') {
      if (typeof v === 'boolean') accepted[k] = v; else rej(k, v, 'type');
    }
  }
  // Order: Hard >= Warn on the effective pair; a violating pair rejects every requested key of that pair.
  for (const [wk, hk] of [['fleetWarnAt', 'fleetHardAt'], ['fleetTotalWarnAt', 'fleetTotalHardAt']]) {
    if (!(wk in accepted) && !(hk in accepted)) continue;
    const w = wk in accepted ? accepted[wk] : c[wk], h = hk in accepted ? accepted[hk] : c[hk];
    if (isNum(w) && isNum(h) && h < w) {
      for (const k of [wk, hk]) if (k in accepted) { rej(k, accepted[k], 'order'); delete accepted[k]; }
    }
  }
  return { accepted, rejected };
}

// Pure. userCfg = the user's config.json object (not merged with defaults). Only allowed keys change.
function applyConfig(userCfg, accepted) {
  const base = isObj(userCfg) ? userCfg : {};
  const out = {};
  for (const k of Object.keys(base)) put(out, k, base[k]);
  for (const k of Object.keys(accepted || {})) {
    if (!SETTINGS_KEYS.includes(k)) continue;
    put(out, k, accepted[k]);
  }
  return out;
}

const configHash = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);

// ---- decisions (DESIGN 10.8.4) ----
const SAFE_STR = /^[a-z]{1,16}$/;

// Fixed per-kind params schema. Returns null when the shape is exactly right, else 'schema'.
function paramsBad(kind, target, params) {
  if (!isObj(target) || !isObj(params)) return true;
  const tk = Object.keys(target), pk = Object.keys(params).sort();
  if (kind === 'session_model') {
    if (tk.length !== 1 || typeof target.sid !== 'string' || !SID_RE.test(target.sid)) return true;
    if (pk.join() !== 'from,to') return true;
    if (!SAFE_STR.test(params.from) || !SAFE_STR.test(params.to)) return true;
    return !(UPPER.includes(params.from) && LOWER.includes(params.to) && RANK[params.to] < RANK[params.from]);
  }
  if (kind === 'session_clear') return tk.length !== 1 || typeof target.sid !== 'string' || !SID_RE.test(target.sid) || pk.length !== 0;
  if (kind === 'agent_default_model') {
    if (tk.length !== 1 || target.scope !== 'agents' || pk.join() !== 'from,to') return true;
    if (!(params.from === null || (typeof params.from === 'string' && SAFE_STR.test(params.from)))) return true;
    return !LOWER.includes(params.to);
  }
  if (kind === 'fleet_threshold') {
    if (tk.length !== 1 || target.scope !== 'fleet' || pk.join() !== 'fleetHardAt,fleetWarnAt') return true;
    return !(int150(params.fleetWarnAt) && int150(params.fleetHardAt) && params.fleetHardAt >= params.fleetWarnAt);
  }
  return true;
}

// Pure. row = merged decision doc {pid, status, kind, target, params, basis:{measured_at}, decided_by?, decided_at?}.
// board = {rows, now, stateStale, grade, selfSid?}; liveModel = the app session entry whose id equals the target sid
// exactly ({model, cwd?, title?} or a model string), or null/undefined when none maps (-> refused unmapped).
// Returns {ok:true, op?|config?|button?} | {ok:false, status:'refused'|'expired', reason}.
function validateDecision(row, board, cfg, liveModel) {
  const c = cfgOf(cfg);
  const b = board || {};
  const now = isNum(b.now) ? b.now : Math.floor(Date.now() / 1000);
  const no = (status, reason) => ({ ok: false, status, reason });
  if (!isObj(row) || typeof row.pid !== 'string' || !PID_RE.test(row.pid)) return no('refused', 'schema');
  row = Object.assign({}, row, { kind: normKind(row.kind) });
  if (row.status !== 'approved') return no('refused', 'not_approved');
  if (!KINDS.includes(row.kind)) return no('refused', 'schema');
  if (row.pid.slice(0, 2) !== KIND_SHORT[row.kind]) return no('refused', 'schema');
  if (paramsBad(row.kind, row.target, row.params)) return no('refused', 'schema');
  const measured = isObj(row.basis) ? epoch(row.basis.measured_at) : null;
  if (measured === null) return no('refused', 'schema');
  const sessionKind = row.kind === 'session_model' || row.kind === 'session_clear';
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const br = sessionKind ? rows.find((r) => isObj(r) && r.sid === row.target.sid) : null;
  if (sessionKind && !br) return no('refused', 'unknown_target');
  if (sessionKind && b.selfSid && row.target.sid === b.selfSid) return no('refused', 'self');
  const live = typeof liveModel === 'string' ? { model: liveModel } : (isObj(liveModel) ? liveModel : null);
  if (sessionKind && (row.unmapped === true || !live)) return no('refused', 'unmapped');
  // Protection needs the title or folder of the live session; when neither is known the session counts as protected.
  const liveKnown = !!live && (typeof live.title === 'string' || typeof live.cwd === 'string');
  if (row.protected === true || row.advice_only === true || (br && rowProtected(br, c, { cwd: live && live.cwd, title: live && live.title }))
    || (sessionKind && !liveKnown)) {
    return no('refused', 'protected');
  }
  if (c.applyMode !== 'approve') return no('refused', 'manual_mode');
  // a basis time more than 120 s ahead (clock went backwards) would never expire: treat it as expired too
  if (now - measured > c.proposalTtlSec || measured - now > 120) return no('expired', 'ttl');
  // Re-check the conditions the proposal was made under (DESIGN 10.8.2): budget grade now, judgment exception now.
  const gradeNeeded = row.kind === 'fleet_threshold' ? ['red'] : (row.kind === 'session_clear' ? null : ['red', 'yellow']);
  if (gradeNeeded && b.stateStale) return no('refused', 'stale_state');
  if (gradeNeeded && !gradeNeeded.includes(b.grade)) return no('refused', 'grade_changed');
  if (row.kind === 'session_model') {
    if (br.j !== 0) return no('refused', 'judgment');
    if (family(br.model) !== row.params.from) return no('refused', 'target_changed');
    const lf = live ? family(live.model) : null;
    if (!lf) return no('refused', 'live_unknown');
    if (lf === row.params.to) return { ok: true, already: true };
    if (lf !== row.params.from) return no('refused', 'target_changed');
    return { ok: true, op: { tool: 'set_session_model', args: { session_id: row.target.sid, model: MODEL_IDS[row.params.to] } } };
  }
  if (row.kind === 'session_clear') {
    if (br.clear_candidate !== true) return no('refused', 'target_changed');
    return { ok: true, button: { kind: 'offer_clear', sid: row.target.sid, button_only: true } };
  }
  if (row.kind === 'agent_default_model') {
    const cur = typeof c.agentModelDefault === 'string' ? c.agentModelDefault : null;
    if (cur !== row.params.from) return no('refused', 'target_changed');
    return { ok: true, config: { agentModelDefault: row.params.to } };
  }
  // fleet_threshold: the values still pass the settings allow table (order checked against the pair itself).
  const v = validateSettings({ values: { fleetWarnAt: row.params.fleetWarnAt, fleetHardAt: row.params.fleetHardAt } }, c);
  if (Object.keys(v.rejected).length) return no('refused', 'schema');
  return { ok: true, config: v.accepted };
}

// Pure. Page query results -> plain docs. Input docs may be {doc_id,data} wrappers.
function unwrap(list) {
  const arr = Array.isArray(list) ? list : (isObj(list) ? (list.documents || list.docs || list.items || list.rows || list.results || []) : []);
  const out = [];
  for (const d of Array.isArray(arr) ? arr : []) {
    if (!isObj(d)) continue;
    const data = isObj(d.data) ? Object.assign({}, d.data) : Object.assign({}, d);
    if (!data.pid && typeof d.doc_id === 'string') data.pid = d.doc_id;
    out.push(data);
  }
  return out;
}
// Pure. Merge decision docs with the LOCAL proposal copies (board/decisions.json "proposals", written by --rows).
// Content (kind, target, params, basis, protected, advice_only, unmapped) comes ONLY from the local copy; from a decision
// doc only status, decided_by and decided_at are read. A pid with no local copy is marked unknown (refused later).
const STATUSES = ['proposed', 'approved', 'rejected', 'held'];
function mergeDocs(decisions, localProps) {
  const byPid = new Map();
  for (const p of unwrap(localProps)) if (typeof p.pid === 'string') byPid.set(p.pid, p);
  return unwrap(decisions).map((d) => {
    const m = { pid: d.pid, status: STATUSES.includes(d.status) ? d.status : null };
    if (typeof d.decided_by === 'string') m.decided_by = d.decided_by.slice(0, 80);
    if (typeof d.decided_at === 'string') m.decided_at = d.decided_at;
    const p = typeof d.pid === 'string' ? byPid.get(d.pid) : null;
    if (!p) { m.unknown = true; return m; }
    for (const k of ['target', 'params', 'basis', 'protected', 'advice_only', 'unmapped']) if (own(p, k)) m[k] = p[k];
    m.kind = normKind(p.kind);
    return m;
  });
}

// Live map: {sid: model} | {sid: {model,cwd}} | [{session_id|sessionId|sid|id, model, cwd?}] | single object.
function liveMap(x) {
  const m = new Map();
  const one = (it) => {
    if (!isObj(it)) return;
    const id = it.session_id || it.sessionId || it.sid || it.id;
    if (typeof id === 'string') m.set(id, { model: it.model, cwd: it.cwd || it.worktreePath || it.path, title: it.title });
  };
  if (Array.isArray(x)) x.forEach(one);
  else if (isObj(x)) {
    if (x.session_id || x.sessionId || x.sid || x.id) one(x);
    else for (const k of Object.keys(x)) { const v = x[k]; if (typeof v === 'string') m.set(k, { model: v }); else if (isObj(v)) m.set(k, { model: v.model, cwd: v.cwd, title: v.title }); }
  }
  return m;
}

// Pure. Ids of an app session list / get_session results (exact id fields only). Used to tell which board rows map.
// Only session ENTRIES count (the app's list_sessions / get_session output saved unchanged: an array, {sessions:[..]} or
// one entry), each matched on its own id field. A hand-built {"<id>": "<title>"} map is not a mapping (W7 #4: no guessing).
function mappedIds(x, rows) {
  const list = Array.isArray(x) ? x : (isObj(x) && Array.isArray(x.sessions) ? x.sessions : (isObj(x) && Array.isArray(x.items) ? x.items : (isObj(x) && (x.sessionId || x.session_id || x.id) ? [x] : [])));
  const ids = liveMap(list.filter((it) => isObj(it)));
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) if (isObj(r) && typeof r.sid === 'string' && ids.has(r.sid)) out.push(r.sid);
  return out;
}

// Pure. One run: decisions (merged) -> results in order of decided_at. ledger = board/decisions.json.
// Returns {ops, buttons, config, results, ledgerRows}. ops carry only code-built args.
function planApply(merged, board, cfg, live, ledger) {
  const c = cfgOf(cfg);
  const b = board || {};
  const now = isNum(b.now) ? b.now : Math.floor(Date.now() / 1000);
  const lm = live instanceof Map ? live : liveMap(live);
  const led = new Map(ledgerRows(ledger).map((r) => [r.pid, r]));
  const ops = [], buttons = [], results = [], recs = [];
  let config = {};
  let used = 0;
  const list = (merged || []).filter(isObj).slice().sort((x, y) => String(x.decided_at || '').localeCompare(String(y.decided_at || '')));
  const seen = new Set();
  const sidsUsed = new Set();
  for (const d of list) {
    const pid = typeof d.pid === 'string' && PID_RE.test(d.pid) ? d.pid : null;
    if (!pid) { results.push({ pid: null, status: 'refused', reason: 'schema' }); continue; }
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (d.unknown) { results.push({ pid, status: 'refused', reason: 'unknown_proposal' }); continue; }
    const prev = led.get(pid);
    if (prev && (TERMINAL.includes(prev.status) || (prev.status === 'approved' && prev.issued_at))) { results.push({ pid, status: 'skip', reason: 'idempotent', was: prev.status }); continue; }
    const base = { pid, kind: KINDS.includes(d.kind) ? d.kind : null, key: KINDS.includes(d.kind) && isObj(d.target) ? targetKey(d.kind, d.target) : null,
      decided_at: typeof d.decided_at === 'string' && epoch(d.decided_at) !== null ? d.decided_at : null, recorded_at: iso(now) };
    if (d.status === 'rejected' || d.status === 'held') {
      if (!prev || prev.status !== d.status) recs.push(Object.assign({}, base, { status: d.status }));
      results.push({ pid, status: 'noted', was: d.status });
      continue;
    }
    if (d.status !== 'approved') { results.push({ pid, status: 'skip', reason: 'not_approved' }); continue; }
    const sid = isObj(d.target) && typeof d.target.sid === 'string' ? d.target.sid : null;
    const v = validateDecision(d, Object.assign({}, b, { now }), Object.assign({}, c, config), sid ? lm.get(sid) : null);
    if (!v.ok) {
      recs.push(Object.assign({}, base, { status: v.status, reason: v.reason }));
      results.push({ pid, status: v.status, reason: v.reason });
      continue;
    }
    if (used >= c.applyMaxPerRun) { results.push({ pid, status: 'deferred', reason: 'max_per_run' }); continue; }
    if (sid && sidsUsed.has(sid)) { results.push({ pid, status: 'deferred', reason: 'one_per_sid' }); continue; }
    used++;
    if (sid) sidsUsed.add(sid);
    if (v.already) {
      recs.push(Object.assign({}, base, { status: 'applied', applied_at: iso(now), applied_as: 'already_at_target' }));
      results.push({ pid, status: 'applied', reason: 'already_at_target' });
    } else if (v.op) {
      ops.push({ pid, tool: v.op.tool, args: v.op.args });
      recs.push(Object.assign({}, base, { status: 'approved', issued_at: iso(now), op: v.op.tool }));
      results.push({ pid, status: 'issued', tool: v.op.tool });
    } else if (v.button) {
      buttons.push(Object.assign({ pid }, v.button));
      recs.push(Object.assign({}, base, { status: 'approved', issued_at: iso(now), op: 'offer_clear' }));
      results.push({ pid, status: 'button_only', tool: 'offer_clear' });
    } else if (v.config) {
      config = Object.assign({}, config, v.config);
      recs.push(Object.assign({}, base, { status: 'applied', applied_at: iso(now), applied_as: 'config' }));
      results.push({ pid, status: 'applied', config: Object.keys(v.config) });
    }
  }
  return { ops, buttons, config, results, ledgerRows: recs };
}

// Pure. Ledger merge: new records replace same pid; keep 7 days, at most 500 rows.
function mergeLedger(ledger, recs, now) {
  const m = new Map();
  for (const r of ledgerRows(ledger)) if (typeof r.pid === 'string') m.set(r.pid, r);
  for (const r of recs) m.set(r.pid, Object.assign({}, m.get(r.pid) || {}, r));
  const keep = [...m.values()].filter((r) => { const t = epoch(r.recorded_at) || epoch(r.decided_at); return t === null || now - t <= 7 * 86400; });
  return { rows: keep.slice(-500) };
}

const FAIL_REASONS = ['tool_error', 'unexpected_tool_result', 'not_found', 'declined'];
// Pure. results = [{pid, ok, reason?}] from the runner. Only pids issued in the ledger count; reasons are an enum.
function recordResults(ledger, results, now) {
  const led = new Map(ledgerRows(ledger).map((r) => [r.pid, r]));
  const recs = [], out = [];
  for (const x of Array.isArray(results) ? results : []) {
    const pid = isObj(x) && typeof x.pid === 'string' ? x.pid : null;
    const prev = pid ? led.get(pid) : null;
    if (!prev || prev.status !== 'approved' || !prev.issued_at) { out.push({ pid, status: 'skip', reason: 'unknown_pid' }); continue; }
    if (x.ok === true) {
      recs.push({ pid, status: 'applied', applied_at: iso(now), applied_as: prev.op, recorded_at: iso(now) });
      out.push({ pid, status: 'applied' });
    } else {
      const reason = FAIL_REASONS.includes(x.reason) ? x.reason : 'unexpected_tool_result';
      recs.push({ pid, status: 'failed', reason, recorded_at: iso(now) });
      out.push({ pid, status: 'failed', reason });
    }
  }
  return { results: out, ledgerRows: recs };
}

// Pure. Page batch: decisions/<pid> updates + settings/applied. host is sanitized by the caller.
function batchFor(recs, settingsApplied) {
  const writes = [];
  for (const r of recs) {
    if (!['applied', 'failed', 'refused', 'expired', 'approved'].includes(r.status)) continue;
    const data = { status: r.status === 'approved' ? 'approved' : r.status, applied_by: 'sync' };
    if (r.reason) data.reason = r.reason;
    if (r.applied_at) data.applied_at = r.applied_at;
    if (r.issued_at) data.issued_at = r.issued_at;
    data.result_at = r.recorded_at;
    writes.push({ op: 'update', collection: 'decisions', doc_id: r.pid, data });
  }
  if (settingsApplied) writes.push({ op: 'set', collection: 'settings', doc_id: 'applied', data: settingsApplied });
  return { writes: writes.slice(0, 50) };
}

// Fixed value: a host name never goes into the page database (privacy). The host argument is ignored on purpose.
const safeHost = () => 'sync';

module.exports = { PROTECT_KEYWORDS_DEFAULT, PROTECT_SEGMENTS, KINDS, MODEL_IDS, DECISION_DEFAULTS, SETTINGS_KEYS, PID_RE, family, rowProtected, textProtected, pidOf, targetKey,
  proposals, validateSettings, applyConfig, configHash, validateDecision, mergeDocs, unwrap, liveMap, planApply, mergeLedger,
  recordResults, batchFor, safeHost, mappedIds };
