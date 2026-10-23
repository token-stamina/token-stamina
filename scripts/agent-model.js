'use strict';
// PreToolUse hook (matcher Agent): when usage is RED, downgrade the model of subagent calls
// that did not choose one. Never blocks; any error => exit 0 with no output.
// Note: no permissionDecision is emitted, so the user's normal permission flow is untouched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pace = require('./pace');

const BUILTIN_WITH_MODEL = new Set(['explore', 'statusline-setup', 'claude-code-guide']);

function includesAny(text, words) {
  for (const w of words || []) if (text.includes(String(w).toLowerCase())) return w;
  return null;
}

// Does the agent definition (.md frontmatter) pin a model? Searches project and user agent dirs.
function definitionHasModel(name, cwd, homeDir) {
  if (!name || /[\\/]/.test(name)) return false;
  if (BUILTIN_WITH_MODEL.has(String(name).toLowerCase())) return true;
  const dirs = [];
  if (cwd) dirs.push(path.join(cwd, '.claude', 'agents'));
  dirs.push(path.join(homeDir || os.homedir(), '.claude', 'agents'));
  for (const d of dirs) {
    let txt;
    try { txt = fs.readFileSync(path.join(d, name + '.md'), 'utf8'); } catch (e) { continue; }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt);
    if (!m) continue;
    const mm = /^model:\s*(\S+)/m.exec(m[1]);
    if (mm && mm[1].toLowerCase() !== 'inherit') return true;
  }
  return false;
}

const T = {
  en: {
    judgment: (w) => 'Token Stamina: usage is over pace (' + w + ' red). This looks like a judgment task so no model was forced; consider model="sonnet" if it does not need the strongest model.',
    suggest: (w, m) => 'Token Stamina: usage is over pace (' + w + ' red). Consider model="' + m + '" for this subagent.',
    inject: (w, m) => 'Token Stamina: usage is over pace (' + w + ' red), so model="' + m + '" was set for this subagent. Pass an explicit model to override.',
  },
  ko: {
    judgment: (w) => 'Token Stamina: 사용 속도가 빨라요(' + w + ' 빨강). 판단이 필요한 작업으로 보여 모델을 강제하지 않았어요. 가장 강한 모델이 필요 없다면 model="sonnet" 을 고려하세요.',
    suggest: (w, m) => 'Token Stamina: 사용 속도가 빨라요(' + w + ' 빨강). 이 하위 에이전트는 model="' + m + '" 을 고려하세요.',
    inject: (w, m) => 'Token Stamina: 사용 속도가 빨라서(' + w + ' 빨강) 이 하위 에이전트에 model="' + m + '" 을 지정했어요. 바꾸려면 model 을 명시해서 호출하세요.',
  },
};

// Pure decision. Returns {action, reason, model?, message?}; action: pass | inject | suggest
function decide(input, state, cfg, now, opts) {
  opts = opts || {};
  const mode = cfg.mode || 'inject';
  if (mode === 'off') return { action: 'pass', reason: 'mode_off' };
  const ti = (input && input.tool_input) || {};
  if (ti.model) return { action: 'pass', reason: 'has_model' };
  const st = ti.subagent_type;
  if (st && String(st).toLowerCase() === 'fork') return { action: 'pass', reason: 'fork' };
  const defHas = opts.definitionHasModel || definitionHasModel;
  if (st && defHas(st, input.cwd, opts.homeDir)) return { action: 'pass', reason: 'definition_model' };
  const a = pace.assess(state, now, cfg);
  if (!a.grade) return { action: 'pass', reason: 'no_state' };
  if (a.stale) return { action: 'pass', reason: 'stale_state' };
  if (a.grade !== 'red') return { action: 'pass', reason: 'grade_' + a.grade };
  const tx = T[cfg.lang] || T.en;
  const text = ((ti.description || '') + ' ' + String(ti.prompt || '').slice(0, 600)).toLowerCase();
  const jw = includesAny(text, cfg.judgmentKeywords);
  if (jw) {
    return { action: 'suggest', reason: 'judgment:' + jw, grade: a.grade, worst: a.worst,
      message: tx.judgment(a.worst) };
  }
  const model = includesAny(text, cfg.simpleKeywords) ? 'haiku' : 'sonnet';
  if (mode === 'suggest') {
    return { action: 'suggest', reason: 'suggest_mode', model, grade: a.grade, worst: a.worst,
      message: tx.suggest(a.worst, model) };
  }
  return { action: 'inject', reason: 'red_downgrade', model, grade: a.grade, worst: a.worst,
    message: tx.inject(a.worst, model) };
}

function output(input, d) {
  if (d.action === 'inject') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse',
      updatedInput: Object.assign({}, input.tool_input, { model: d.model }),
      additionalContext: d.message } };
  }
  if (d.action === 'suggest') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.message } };
  }
  return null;
}

function run(raw) {
  const input = JSON.parse(raw);
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return '';
  const cfg = require('./lang').withLang(pace.loadConfig(), input);
  const d = decide(input, pace.readState(), cfg, Math.floor(Date.now() / 1000));
  if (d.message) d.message = pace.attributed(d.message, cfg.lang, cfg._langAuto);
  pace.appendEvent({ event: 'agent_model', session: input.session_id, subagent_type: input.tool_input && input.tool_input.subagent_type,
    tool_use_id: input.tool_use_id || null, action: d.action, reason: d.reason, model: d.model || null, grade: d.grade || null });
  const out = output(input, d);
  return out ? JSON.stringify(out) : '';
}

module.exports = { decide, output, definitionHasModel, run };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try { if (!pace.skipHook(JSON.parse(raw), pace.loadConfig())) { const o = run(raw); if (o) process.stdout.write(o); } } catch (e) { /* silent */ }
    process.exit(0);
  });
}
