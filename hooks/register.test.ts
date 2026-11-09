// claude plugin test for the mods build (copied to hooks/register.test.ts by tools/build-mod.mjs).
// Nothing sits beneath the plugin: the test's hooks stand for the engine, with the files kept in
// memory. Each test checks one feature end to end through the real register.ts.
import { expect, mock, test } from 'claude-code/testing';
import { sessionFileName, latestFileName, pendingClearName } from './core/handoff.ts';
import { SLOTS, hash, slotName, header as evHeader } from './core/events.ts';
import { estimateTokens } from './core/text.ts';

const USER = '/h';
const HOME = '/h/.claude/token-stamina';
const DIR = HOME + '/handoff';
const HOST = 'local_host1';

// The parts of config.default.json the features below read.
const DEFAULTS = {
  lang: 'en', mode: 'inject', nudge: false, yellowMargin: 10, redAt: 90,
  floors: { '5h': { yellow: 25, red: 50 }, '7d': { yellow: 0, red: 0 } },
  fiveHourShowAt: 80, stateMaxAgeSec: 21600,
  judgmentKeywords: ['design', 'review'], simpleKeywords: ['list', 'collect'],
  boundary: false, inlineCompactHint: true, compactAtTokens: 150000, newSessionAtTokens: 400000,
  handoff: true, topicGate: true, topicCheckStepTokens: 50000, gateAtTokens: 200000, idleGapSec: 3600,
  handoffMaxTokens: 1500, fleet: false, explicitDowngrade: 'off', fleetModelFloor: 'sonnet',
  sessionModelHook: true, sessionModelInject: true, agentModelDefault: null, excludeCwd: [],
};

type Files = Record<string, string>;

// The engine hands the hooks absolute paths in the platform's form (C:\h\... on Windows): compare them as /h/...
const norm = (p: string) => String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');

function world(on: any, files: Files, opts: { host?: string; usage?: any; messages?: any[]; onWrite?: (p: string, text: string) => boolean; ages?: Record<string, number>; denyWrite?: string; denyPath?: RegExp; noSid?: boolean; sidRef?: { v: string }; sizes?: Record<string, number>; tooBig?: RegExp; onRead?: (p: string) => void; env?: Record<string, string>; model?: string } = {}) {
  const mtime: Record<string, number> = {};
  for (const p of Object.keys(files)) mtime[p] = Date.now() - ((opts.ages && opts.ages[p]) || 0);
  const status: (string | undefined)[] = [];
  on('fs.read', (_: any, e: any) => {
    const p = norm(e.path);
    if (opts.onRead) opts.onRead(p);
    if (opts.tooBig && opts.tooBig.test(p)) return { deny: 'file over 4 MiB' };
    if (/config\.default\.json$/.test(p)) return { value: JSON.stringify(DEFAULTS) };
    return p in files ? { value: files[p] } : { deny: 'ENOENT: ' + p };
  });
  on('fs.write', (_: any, e: any) => {
    if (opts.denyWrite) return { deny: opts.denyWrite };
    const p = norm(e.path);
    if (opts.denyPath && opts.denyPath.test(p)) return { deny: 'EPERM: ' + p };
    if (!(opts.onWrite && opts.onWrite(p, String(e.text)))) files[p] = String(e.text);
    mtime[p] = Date.now();
    return { value: undefined };
  });
  on('fs.exists', (_: any, e: any) => ({ value: norm(e.path) in files }));
  on('fs.stat', (_: any, e: any) => {
    const p = norm(e.path);
    return p in files ? { value: { kind: 'file', size: (opts.sizes && opts.sizes[p]) || files[p]!.length, mtimeMs: mtime[p], isLink: false } } : { deny: 'ENOENT' };
  });
  // Entries of a folder, built from the files kept in memory (a child folder is a name with more path after it).
  on('fs.list', (_: any, e: any) => {
    const dir = norm(e.path).replace(/\/+$/, '');
    const seen = new Map<string, any>();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(dir + '/')) continue;
      const [first, ...more] = p.slice(dir.length + 1).split('/');
      if (more.length) seen.set(first!, { name: first, kind: 'dir', size: 0, mtimeMs: 0, isLink: false });
      else seen.set(first!, { name: first, kind: 'file', size: (opts.sizes && opts.sizes[p]) || files[p]!.length, mtimeMs: mtime[p] ?? Date.now(), isLink: false });
    }
    return seen.size ? { value: [...seen.values()] } : { deny: 'ENOENT' };
  });
  on('session.messages', () => (opts.messages ? { value: opts.messages } : { deny: 'no messages in the test' }));
  on('session.id', () => (opts.sidRef ? { value: opts.sidRef.v } : opts.noSid ? { deny: 'no session id in the test' } : { value: 'S1' }));
  on('session.cwd', () => ({ value: '/w' }));
  on('session.model', () => ({ value: opts.model || 'claude-opus-4-7' }));
  on('session.usage', () => ({ value: opts.usage || { startedAt: 0, context: { tokens: 1000, window: 200000 }, rateLimits: [] } }));
  on('ui.status', (_: any, e: any) => {
    status.push(e.text);
    return { value: undefined };
  });
  mock.env(on, { USERPROFILE: USER, TOKEN_STAMINA_HOME: HOME, ...(opts.host ? { CLAUDE_CODE_HOST_SESSION_ID: opts.host } : {}), ...(opts.env || {}) });
  return { files, status };
}

const line = (o: unknown) => JSON.stringify(o) + '\n';
// Every event line written so far: the old single file and the per-session slot files (core/events.ts).
const evText = (files: Files) => Object.keys(files).filter((p) => p === HOME + '/events.jsonl' || p.startsWith(HOME + '/events/')).sort().map((p) => files[p]).join('');
const prompt = (t: string) => line({ type: 'user', isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: t } });
const asst = (content: unknown[]) => line({ type: 'assistant', isSidechain: false, message: { model: 'm', role: 'assistant', content, usage: { input_tokens: 5000 } } });
const result = (id: string) => line({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('SessionStart compact: the session handoff note comes back as context', async ($, on) => {
  const files: Files = { [sessionFileName(DIR, 'S1')]: '# Handoff note (auto, no LLM)\n- cwd: /w\n\nkeep going on X\n' };
  world(on, files);
  on('classic.SessionStart', () => ({}));
  const r: any = await $.classic.SessionStart({ source: 'compact', session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  expect((r.additionalContext || []).join('\n')).toContain('keep going on X');
});

test('Stop records a clear_session that went through; the next startup restores the note once', async ($, on) => {
  const transcript = prompt('wrap up and clear') + asst([{ type: 'tool_use', id: 'c1', name: 'mcp__ccd_session_mgmt__clear_session', input: { session_id: 'self' } }]) + result('c1') + asst([{ type: 'text', text: 'cleared' }]);
  const files: Files = { '/t/OLD.jsonl': transcript, [sessionFileName(DIR, 'OLD', true)]: '# note by Claude\nnext: ship the mod\n' };
  world(on, files, { host: HOST });
  on('classic.Stop', () => ({}));
  on('classic.SessionStart', () => ({}));
  await $.classic.Stop({ session_id: 'OLD', cwd: '/w', transcript_path: '/t/OLD.jsonl' } as any);
  const mk = JSON.parse(files[pendingClearName(DIR, HOST)] || 'null');
  expect(mk?.from).toBe('OLD');
  expect(files[sessionFileName(DIR, 'OLD')]).toContain('wrap up and clear');
  expect(files[latestFileName(DIR, '/w')]).toBeDefined();

  const r1: any = await $.classic.SessionStart({ source: 'startup', session_id: 'NEW', cwd: '/w', transcript_path: '/t/NEW.jsonl' } as any);
  expect((r1.additionalContext || []).join('\n')).toContain('ship the mod');
  expect(files[pendingClearName(DIR, HOST)]).toBe('{}');
  const r2: any = await $.classic.SessionStart({ source: 'startup', session_id: 'NEW', cwd: '/w', transcript_path: '/t/NEW.jsonl' } as any);
  expect((r2.additionalContext || []).join('\n')).not.toContain('ship the mod');
});

test('after the clear the last turns are drawn with ui.log (not the clearing turn), outside the context', async ($, on) => {
  const transcript = prompt('fix the parser') + asst([{ type: 'text', text: 'parser fixed' }])
    + prompt('wrap up and clear') + asst([{ type: 'tool_use', id: 'c1', name: 'mcp__ccd_session_mgmt__clear_session', input: { session_id: 'self' } }]) + result('c1');
  const files: Files = { '/t/OLD.jsonl': transcript };
  world(on, files, { host: HOST });
  const logged: string[] = [];
  on('ui.log', (_: any, e: any) => {
    logged.push(String(e.text));
    return { value: undefined };
  });
  on('classic.Stop', () => ({}));
  on('classic.SessionStart', () => ({}));
  await $.classic.Stop({ session_id: 'OLD', cwd: '/w', transcript_path: '/t/OLD.jsonl' } as any);
  const r: any = await $.classic.SessionStart({ source: 'startup', session_id: 'NEW', cwd: '/w', transcript_path: '/t/NEW.jsonl' } as any);
  const shown = logged.join('\n');
  expect(shown).toContain('> fix the parser');
  expect(shown).toContain('parser fixed');
  expect(shown).not.toContain('wrap up and clear');
  expect((r.additionalContext || []).join('\n')).not.toContain('> fix the parser'); // the drawn turns stay out; the note keeps the last reply under Last conclusions
});

// Nothing draws beneath the plugin: where the band passes, this stands for the engine's own band.
const engineBand = (on: any) => on('ui.render', ($: any, e: any) => h($.ui.resolve(e).Text, null, 'engine'));
const BAND = { plugin: 'token-stamina', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 } } } as const;

test('the band above the prompt shows the last turns before the first prompt of a cleared session, then goes', async ($, on) => {
  const transcript = prompt('fix the parser') + asst([{ type: 'text', text: 'parser fixed' }])
    + prompt('wrap up and clear') + asst([{ type: 'tool_use', id: 'c1', name: 'mcp__ccd_session_mgmt__clear_session', input: { session_id: 'self' } }]) + result('c1');
  const files: Files = { '/t/OLD.jsonl': transcript };
  world(on, files, { host: HOST });
  on('classic.Stop', () => ({}));
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }));
  on('command.register', () => ({ value: { command: 'x' } }));
  on('tool.register', () => ({ value: undefined }));
  engineBand(on);
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }));
  await $.classic.Stop({ session_id: 'OLD', cwd: '/w', transcript_path: '/t/OLD.jsonl' } as any);
  // The marker stays until the first prompt: the band only reads it.
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true });
  expect(JSON.parse(files[pendingClearName(DIR, HOST)]!).from).toBe('OLD');

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' });
  expect((await ui.find({ type: 'Text', text: /last 1 turns/ }))?.text).toContain('on screen only');
  expect(await ui.find({ type: 'Text', text: /parser fixed/ })).toBeFalsy(); // collapsed: the header only
  await ui.press({ key: 'toggle' });
  expect(await ui.find({ type: 'Text', text: /parser fixed/ })).toBeTruthy();
  expect(await ui.find({ type: 'Text', text: /wrap up and clear/ })).toBeFalsy(); // not the clearing turn
  await ui.unmount();

  await $.prompt.submit({ text: 'hello' } as any);
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' });
  expect(await after.find({ type: 'Text', text: /last 1 turns/ })).toBeFalsy();
  await after.unmount();
});

test('no band without a fresh marker (an expired one, or no desktop host)', async ($, on) => {
  const files: Files = { [pendingClearName(DIR, HOST)]: JSON.stringify({ from: 'OLD', host: HOST, at: Date.now() - 61 * 60 * 1000 }), [DIR + '/OLD.json']: JSON.stringify({ recent: [{ ts: 'x', user: 'u', claude: 'c' }] }) };
  world(on, files, { host: HOST });
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }));
  on('command.register', () => ({ value: { command: 'x' } }));
  on('tool.register', () => ({ value: undefined }));
  engineBand(on);
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true });
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' });
  expect(await ui.find({ type: 'Text', text: /last/ })).toBeFalsy();
  await ui.unmount();
});

test('the first prompt restores from the marker when SessionStart did not; a marker over 60 minutes old is dropped', async ($, on) => {
  const files: Files = {
    [pendingClearName(DIR, HOST)]: JSON.stringify({ from: 'OLD', host: HOST, cwd: '/w', at: Date.now() - 1000 }),
    [sessionFileName(DIR, 'OLD')]: '# Handoff note (auto, no LLM)\nauto note body\n',
  };
  world(on, files, { host: HOST });
  on('classic.UserPromptSubmit', () => ({}));
  const r: any = await $.classic.UserPromptSubmit({ session_id: 'NEW', cwd: '/w', prompt: 'hi' } as any);
  expect((r.additionalContext || []).join('\n')).toContain('auto note body');

  files[pendingClearName(DIR, HOST)] = JSON.stringify({ from: 'OLD', host: HOST, cwd: '/w', at: Date.now() - 61 * 60 * 1000 });
  const r2: any = await $.classic.UserPromptSubmit({ session_id: 'NEW2', cwd: '/w', prompt: 'hi' } as any);
  expect((r2.additionalContext || []).join('\n')).not.toContain('auto note body');
});

test('Agent call at red usage runs on a smaller model; the status line is set', async ($, on) => {
  const resets = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
  const usage = {
    startedAt: 0,
    context: { tokens: 1000, window: 200000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 97, resetsAt: resets }, { kind: 'five_hour', percentUsed: 97, resetsAt: resets }],
  };
  const { status } = world(on, {}, { usage });
  on('classic.SessionStart', () => ({}));
  let seen: any = null;
  on('tool.call', (_: any, e: any) => {
    seen = e;
    return { result: {} };
  });
  await $.tool.call({ tool: 'Agent', description: 'do the thing', prompt: 'do the thing', subagent_type: 'general-purpose' } as any);
  expect(seen?.model).toBe('sonnet');

  await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  expect(status.some((s) => typeof s === 'string' && s.length > 0)).toBe(true);
});

// ---- slash commands: ts-fleet, ts-savings, ts-report, ts-audit (command.run answers { text }) ----

const iso = () => new Date().toISOString();
const CLAUDE = '/h/.claude';
const PROJ = CLAUDE + '/projects/-w';
const asstAt = (id: string, model: string, usage: unknown, content: unknown[] = []) =>
  line({ type: 'assistant', isSidechain: false, timestamp: iso(), message: { id, model, role: 'assistant', content, usage } });

test('session.start registers fleet, savings, report, audit, recall and selftest', async ($, on) => {
  const names: string[] = [];
  on('command.register', (_: any, e: any) => {
    names.push(e.name);
    return { value: { command: e.name } };
  });
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }));
  world(on, {});
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  expect(names.sort().join(',')).toBe('ts-advisor,ts-audit,ts-fleet,ts-recall,ts-report,ts-savings,ts-selftest');
});

// ---- 0.6.8: user Agent hooks, judgment keep-parent, require mode, mode precedence, advisor analyze ----

const AG = { tool: 'Agent', description: 'do the thing', prompt: 'do the thing', subagent_type: 'general-purpose' };
const cfgFile = (o: object) => ({ [HOME + '/config.json']: JSON.stringify(o) });
// A world with the red-usage Agent call target; `seen` is the call as the engine would run it (null: refused before the tool).
function agentWorld(on: any, files: Files, o: { settings?: object; usage?: any; env?: Record<string, string>; model?: string } = {}) {
  world(on, files, { usage: o.usage === undefined ? redUsage() : o.usage, env: o.env, model: o.model });
  if (o.settings) on('settings.read', () => ({ value: o.settings }));
  const box: { seen: any } = { seen: null };
  on('tool.call', (_: any, e: any) => {
    box.seen = e;
    return { result: {} };
  });
  return box;
}
const userHook = (matcher: string | undefined) => ({ hooks: { PreToolUse: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: 'node my-guard.js' }] }] } });
const deferCount = (files: Files) => (evText(files).match(/"event":"agent_model_defer"/g) || []).length;

test('user PreToolUse hook on Agent: red usage only suggests (input unchanged) and agent_model_defer is written once per session', async ($, on) => {
  const files: Files = {};
  const box = agentWorld(on, files, { settings: userHook('Agent') });
  const r1: any = await $.tool.call(AG as any);
  expect(box.seen.model).toBeUndefined();
  expect((r1.context || []).join(' ')).toContain('Consider model="sonnet"');
  await $.tool.call(AG as any);
  expect(box.seen.model).toBeUndefined();
  expect(deferCount(files)).toBe(1);
  expect(evText(files)).toContain('"reason":"user_hook"');
  expect(evText(files)).toContain('"action":"suggest"');
});

for (const [matcher, defers] of [['Task', true], ['Agent|Task', true], ['', true], ['*', true], ['Bash', false], ['Write|Edit', false]] as const) {
  test(`user hook matcher "${matcher}": ${defers ? 'defers (input unchanged, one defer event)' : 'does not hold the input, so red usage injects'}`, async ($, on) => {
    const files: Files = {};
    const box = agentWorld(on, files, { settings: userHook(matcher) });
    await $.tool.call(AG as any);
    expect(box.seen.model).toBe(defers ? undefined : 'sonnet');
    expect(deferCount(files)).toBe(defers ? 1 : 0);
  });
}

test('a PostToolUse hook on Agent does not hold the input: red usage injects', async ($, on) => {
  const files: Files = {};
  const box = agentWorld(on, files, { settings: { hooks: { PostToolUse: [{ matcher: 'Agent', hooks: [{ type: 'command', command: 'x' }] }] } } });
  await $.tool.call(AG as any);
  expect(box.seen.model).toBe('sonnet');
});

test('respectUserAgentHooks:false: a user hook on Agent is ignored and the call is injected', async ($, on) => {
  const files: Files = cfgFile({ respectUserAgentHooks: false });
  const box = agentWorld(on, files, { settings: userHook('Agent') });
  await $.tool.call(AG as any);
  expect(box.seen.model).toBe('sonnet');
  expect(deferCount(files)).toBe(0);
});

test('no settings at all (read refused): the Agent call is handled as before', async ($, on) => {
  const files: Files = {};
  const box = agentWorld(on, files);
  await $.tool.call(AG as any);
  expect(box.seen.model).toBe('sonnet');
});

test('judgment signal with CLAUDE_CODE_SUBAGENT_MODEL=sonnet under an opus main model: the main model is put in model', async ($, on) => {
  const files: Files = {};
  const box = agentWorld(on, files, { usage: null, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } });
  const r: any = await $.tool.call({ ...AG, description: 'design the schema', prompt: 'design review of the schema' } as any);
  expect(box.seen.model).toBe('opus');
  expect(evText(files)).toContain('"reason":"judgment_keep_parent"');
  expect((r.context || []).join(' ')).toContain('below the main model');
  // no judgment word: untouched; an explicit model: untouched
  await $.tool.call({ ...AG, description: 'collect logs', prompt: 'collect the logs' } as any);
  expect(box.seen.model).toBeUndefined();
  await $.tool.call({ ...AG, description: 'design the schema', model: 'haiku' } as any);
  expect(box.seen.model).toBe('haiku');
});

test('judgment keep-parent reads CLAUDE_CODE_SUBAGENT_MODEL from settings env', async ($, on) => {
  const f1: Files = {};
  const b1 = agentWorld(on, f1, { usage: null, settings: { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5' } } });
  await $.tool.call({ ...AG, description: 'review the plan' } as any);
  expect(b1.seen.model).toBe('opus');
});

test('judgment keep-parent reads the model of the named agent definition', async ($, on) => {
  const f2: Files = { '/w/.claude/agents/rev.md': '---\nname: rev\nmodel: sonnet\n---\nreviewer' };
  const b2 = agentWorld(on, f2, { usage: null });
  await $.tool.call({ ...AG, subagent_type: 'rev', description: 'review the plan' } as any);
  expect(b2.seen.model).toBe('opus'); // the definition pins sonnet, below the opus main model
});

test('judgment keep-parent: a main model that is not above the default leaves the call alone', async ($, on) => {
  const b3 = agentWorld(on, {}, { usage: null, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' }, model: 'claude-sonnet-4-6' });
  await $.tool.call({ ...AG, description: 'review the plan' } as any);
  expect(b3.seen.model).toBeUndefined();
});

test('judgmentKeepParent:false: one warning line and the input is unchanged', async ($, on) => {
  const b1 = agentWorld(on, cfgFile({ judgmentKeepParent: false }), { usage: null, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } });
  const r: any = await $.tool.call({ ...AG, description: 'design the schema' } as any);
  expect(b1.seen.model).toBeUndefined();
  expect((r.context || []).join(' ')).toContain('default subagent model (sonnet) is below the main model (opus)');
});

test('a user hook on Agent gives the below-parent warning instead of an injection', async ($, on) => {
  const b2 = agentWorld(on, {}, { usage: null, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' }, settings: userHook('Agent') });
  const r2: any = await $.tool.call({ ...AG, description: 'design the schema' } as any);
  expect(b2.seen.model).toBeUndefined();
  expect((r2.context || []).join(' ')).toContain('is below the main model');
});

for (const lang of ['en', 'ko']) {
  test(`subagentMode require (${lang}): a model-less Agent call is refused with a short reason; a call with a model or a fork goes through`, async ($, on) => {
    const files: Files = cfgFile({ subagentMode: 'require', lang });
    const box = agentWorld(on, files);
    const r: any = await $.tool.call(AG as any);
    expect(typeof r.deny).toBe('string');
    expect(box.seen).toBeNull();
    expect(estimateTokens(r.deny)).toBeLessThanOrEqual(120);
    for (const m of ['haiku', 'sonnet', 'opus']) expect(r.deny).toContain(m);
    if (lang === 'en') {
      expect(r.deny).toMatch(/Pace: (7d|5h) red -> sonnet advised/);
      expect(r.deny).toContain('(1) does a fixed procedure give the answer');
      expect(r.deny).toContain('(4) is a mistake hard to undo');
      expect(r.deny).toContain('split in two');
    } else {
      expect(r.deny).toMatch(/속도: (7d|5h) 빨강 → sonnet 추천/);
      for (const q of ['①정해진 절차로 답이 나오나', '②예상 밖이면 멈춤이면 되나 해석해야 하나', '③결과가 그대로 밖으로 나가나', '④틀리면 되돌리기 어렵나', '둘로 쪼개기']) expect(r.deny).toContain(q);
    }
    expect(evText(files)).toContain('"action":"deny"');
    await $.tool.call({ ...AG, model: 'haiku' } as any);
    expect(box.seen.model).toBe('haiku');
    box.seen = null;
    await $.tool.call({ ...AG, subagent_type: 'fork' } as any);
    expect(box.seen).not.toBeNull();
  });
}

test('require with green pace says so', async ($, on) => {
  const green = { startedAt: 0, context: { tokens: 1000, window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 1, resetsAt: new Date(Date.now() + 3 * 86400000).toISOString() }] };
  agentWorld(on, cfgFile({ subagentMode: 'require' }), { usage: green });
  const r1: any = await $.tool.call(AG as any);
  expect(r1.deny).toContain('Pace: green.');
});

test('require with unknown pace stays silent about pace and within 120 tokens', async ($, on) => {
  agentWorld(on, cfgFile({ subagentMode: 'require' }), { usage: null });
  const r2: any = await $.tool.call(AG as any);
  expect(r2.deny).not.toContain('Pace:');
  expect(estimateTokens(r2.deny)).toBeLessThanOrEqual(120);
});

test('require: an agent definition that pins a model is not refused', async ($, on) => {
  const f3: Files = { ...cfgFile({ subagentMode: 'require' }), '/w/.claude/agents/pinned.md': '---\nname: pinned\nmodel: haiku\n---\nx' };
  const b3 = agentWorld(on, f3);
  await $.tool.call({ ...AG, subagent_type: 'pinned' } as any);
  expect(b3.seen).not.toBeNull();
});

test('require with a user hook on Agent still denies a model-less call (require changes no input, so no defer event)', async ($, on) => {
  const f4: Files = cfgFile({ subagentMode: 'require' });
  const b4 = agentWorld(on, f4, { settings: userHook('Agent') });
  const r4: any = await $.tool.call(AG as any);
  expect(typeof r4.deny).toBe('string');
  expect(b4.seen).toBeNull();
  expect(deferCount(f4)).toBe(0);
});

test('require with a user hook: a call that names a model goes through unchanged to the hook chain', async ($, on) => {
  const f5: Files = cfgFile({ subagentMode: 'require' });
  const b5 = agentWorld(on, f5, { settings: userHook('Agent') });
  const r5: any = await $.tool.call({ ...AG, model: 'opus' } as any);
  expect(r5.deny).toBeUndefined();
  expect(b5.seen.model).toBe('opus');
});

test('mode inject still defers to a user hook while subagentMode require does not (same hook)', async ($, on) => {
  const f6: Files = cfgFile({ mode: 'inject' });
  const b6 = agentWorld(on, f6, { settings: userHook('Agent') });
  await $.tool.call(AG as any);
  expect(b6.seen.model).toBeUndefined();
  expect(deferCount(f6)).toBe(1);
});

const SS = { tool: 'mcp__ccd_session__start_session', title: 'work', prompt: 'do the thing', cwd: '/w2', initiation: 'own_initiative' };
test('mode off + subagentMode inject: the Agent call is injected', async ($, on) => {
  const box = agentWorld(on, cfgFile({ mode: 'off', subagentMode: 'inject' }));
  await $.tool.call(AG as any);
  expect(box.seen.model).toBe('sonnet');
});
test('mode inject + subagentMode off: the Agent call is untouched', async ($, on) => {
  const box = agentWorld(on, cfgFile({ mode: 'inject', subagentMode: 'off' }));
  await $.tool.call(AG as any);
  expect(box.seen.model).toBeUndefined();
});
test('mode require alone refuses a model-less Agent call (subagentMode absent follows mode)', async ($, on) => {
  agentWorld(on, cfgFile({ mode: 'require' }));
  expect(typeof ((await $.tool.call(AG as any)) as any).deny).toBe('string');
});
test('subagentMode suggest beats mode require', async ($, on) => {
  const box = agentWorld(on, cfgFile({ mode: 'require', subagentMode: 'suggest' }));
  expect(((await $.tool.call(AG as any)) as any).deny).toBeUndefined();
  expect(box.seen.model).toBeUndefined();
});
test('sessionMode suggest + mode inject: start_session unchanged, the Agent call is still injected', async ($, on) => {
  const box = agentWorld(on, cfgFile({ mode: 'inject', sessionMode: 'suggest' }));
  const rs: any = await $.tool.call(SS as any);
  expect(box.seen.model).toBeUndefined();
  expect((rs.context || []).join(' ')).toContain('new session');
  await $.tool.call(AG as any);
  expect(box.seen.model).toBe('sonnet');
});
test('sessionMode inject + mode suggest: start_session injected, the Agent call only suggested', async ($, on) => {
  const box = agentWorld(on, cfgFile({ mode: 'suggest', sessionMode: 'inject' }));
  await $.tool.call(SS as any);
  expect(box.seen.model).toBe('sonnet');
  await $.tool.call(AG as any);
  expect(box.seen.model).toBeUndefined();
});
for (const c of [{ mode: 'require' }, { sessionMode: 'require' }]) {
  test(`require is not a session mode (${JSON.stringify(c)}): start_session is never refused`, async ($, on) => {
    const box = agentWorld(on, cfgFile(c));
    const r: any = await $.tool.call(SS as any);
    expect(r.deny).toBeUndefined();
    expect(box.seen.model).toBeUndefined();
  });
}

test('the Task tool name is handled like Agent', async ($, on) => {
  const box = agentWorld(on, {});
  await $.tool.call({ ...AG, tool: 'Task' } as any);
  expect(box.seen.model).toBe('sonnet');
});

test('advisor tool analyze: the answer is a string (an object fails the engine\'s output shape), with json off and on', async ($, on) => {
  world(on, {});
  const text: any = await $.tool.call({ tool: ATOOL, mode: 'analyze' } as any);
  expect(typeof text.result).toBe('string');
  expect(text.deny).toBeUndefined();
  expect(text.result.length).toBeGreaterThan(0);
  const js: any = await $.tool.call({ tool: ATOOL, mode: 'analyze', json: true } as any);
  expect(typeof js.result).toBe('string');
  expect(JSON.parse(js.result).windows).toBeDefined();
  const bad: any = await $.tool.call({ tool: ATOOL, mode: 'nope' } as any);
  expect(typeof bad.deny).toBe('string'); // an error answer is a deny, also a string
  const bt: any = await $.tool.call({ tool: BTOOL, mode: 'json' } as any);
  expect(typeof bt.result).toBe('string');
});

// A main transcript over 4 MiB: $.fs.read refuses it, scripts/transcript-slim.js --adv streams it, and the scan counts it as read.
const bigCall = (n: number) => JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 3600000 + n * 1000).toISOString(), sessionId: 'S1', requestId: 'r' + n,
  message: { id: 'm' + n, model: 'claude-opus-4-7', usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7, cache_creation_input_tokens: 0 } } });
test('advisor analyze reads a main transcript over 4 MiB through the streaming helper (--adv) instead of skipping it', async ($, on) => {
  const rows = Array.from({ length: 30 }, (_, i) => bigCall(i)).join('\n') + '\n';
  const files: Files = { [PROJ + '/S1.jsonl']: rows };
  world(on, files, { tooBig: /\/S1\.jsonl$/, sizes: { [PROJ + '/S1.jsonl']: 6 * 1024 * 1024 } });
  const runs: string[][] = [];
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv);
    return { value: { exitCode: 0, stdout: rows, stderr: '', isStdoutTruncated: false } };
  });
  const a: any = await $.tool.call({ tool: ATOOL, mode: 'analyze', json: true } as any);
  expect(runs.length).toBe(1);
  expect(runs[0]!.join(' ')).toContain('transcript-slim.js');
  expect(runs[0]!.join(' ')).toContain('--adv');
  const cov = JSON.parse(a.result).coverage;
  expect(cov.files).toBe(1);
  expect(cov.read).toBe(1);
  expect(cov.skipped).toBe(0);
  const t: any = await $.tool.call({ tool: ATOOL, mode: 'analyze' } as any);
  expect(t.result.split('\n')[0]).not.toMatch(/^Skipped/);
});

test('advisor analyze: a big transcript that cannot be streamed is skipped and the first line says how many and how much', async ($, on) => {
  const files: Files = { [PROJ + '/S1.jsonl']: bigCall(1) + '\n', [PROJ + '/S2.jsonl']: bigCall(2) + '\n' };
  world(on, files, { tooBig: /\/S1\.jsonl$/, sizes: { [PROJ + '/S1.jsonl']: 6 * 1024 * 1024 } });
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no node', isStdoutTruncated: false } }));
  const en: any = await $.tool.call({ tool: ATOOL, mode: 'analyze' } as any);
  expect(en.result.split('\n')[0]).toMatch(/^Skipped 1 file \(\d+% of all bytes\)\.$/);
  const ko: any = await $.tool.call({ tool: ATOOL, mode: 'analyze', lang: 'ko' } as any);
  expect(ko.result.split('\n')[0]).toMatch(/^건너뜀 1개\(전체의 \d+%\)$/);
});

test('/ts-fleet prints the running subagents of this session and the sessions line', async ($, on) => {
  const files: Files = {
    [PROJ + '/S1/subagents/agent-a1.meta.json']: JSON.stringify({ agentType: 'general-purpose', description: 'do x', model: 'claude-sonnet-4-6' }),
    [PROJ + '/S1/subagents/agent-a2.meta.json']: JSON.stringify({ agentType: 'Explore', description: 'look', model: 'claude-opus-4-7', finished: true }),
    [PROJ + '/OTHER.jsonl']: line({ type: 'user', cwd: '/o', entrypoint: 'cli' }),
  };
  world(on, files);
  const r: any = await $.command.run({ command: 'ts-fleet' } as any);
  expect(r.text).toContain('1 running · 1 finished · 0 stale');
  expect(r.text).toContain('| running | S | general-purpose | do x |');
  expect(r.text).toContain('| finished | O | Explore | look |');
  expect(r.text).toContain('sessions 1 (interactive)');
});

test('/ts-savings counts a model downgrade as an estimate', async ($, on) => {
  const events = line({ v: 5, ts: iso(), event: 'agent_model', action: 'inject', session: 'S1', tool_use_id: 't1', model: 'sonnet', requested_model: 'opus' });
  const transcript =
    asstAt('m1', 'claude-opus-4-7', { input_tokens: 10, output_tokens: 5 }, [{ type: 'tool_use', id: 't1', name: 'Agent', input: {} }]) +
    line({ type: 'user', isSidechain: false, toolUseResult: { status: 'completed', resolvedModel: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100 } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  world(on, { [HOME + '/events.jsonl']: events, [PROJ + '/S1.jsonl']: transcript });
  const r: any = await $.command.run({ command: 'ts-savings' } as any);
  expect(r.text).toContain('Model downgrade: 1 calls, 1.1k tokens, Opus-input equiv 600 (est.)');
  expect(r.text).toContain('Total: about 600 Opus input-token equivalents (est.)');
  expect(r.text).toContain('Not actual billing.');
});

test('/ts-savings reads a transcript over 4 MiB through the streaming helper instead of skipping it', async ($, on) => {
  const events = line({ v: 5, ts: iso(), event: 'agent_model', action: 'inject', session: 'S1', tool_use_id: 't1', model: 'sonnet', requested_model: 'opus' });
  const transcript =
    asstAt('m1', 'claude-opus-4-7', { input_tokens: 10, output_tokens: 5 }, [{ type: 'tool_use', id: 't1', name: 'Agent', input: {} }]) +
    line({ type: 'user', isSidechain: false, toolUseResult: { status: 'completed', resolvedModel: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100 } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  world(on, { [HOME + '/events.jsonl']: events, [PROJ + '/S1.jsonl']: transcript }, { tooBig: /\/S1\.jsonl$/ });
  const runs: string[][] = [];
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv);
    return { value: { exitCode: 0, stdout: transcript, stderr: '', isStdoutTruncated: false } };
  });
  const r: any = await $.command.run({ command: 'ts-savings' } as any);
  expect(runs.length).toBe(1);
  expect(runs[0]!.join(' ')).toContain('transcript-slim.js');
  expect(runs[0]!.join(' ')).not.toContain('--chat');
  expect(r.text).toContain('Model downgrade: 1 calls, 1.1k tokens, Opus-input equiv 600 (est.)');
  expect(r.text).not.toContain('skipped');
});

test('/ts-report totals tokens by model, main against subagent, and the unspecified Agent calls', async ($, on) => {
  const files: Files = {
    [PROJ + '/S1.jsonl']: asstAt('m1', 'claude-opus-4-7', { input_tokens: 100, output_tokens: 50 }, [{ type: 'tool_use', id: 't1', name: 'Agent', input: { prompt: 'p' } }]),
    [PROJ + '/S1/subagents/agent-a1.jsonl']: asstAt('s1', 'claude-sonnet-4-6', { input_tokens: 40, output_tokens: 10 }),
  };
  world(on, files);
  const r: any = await $.command.run({ command: 'ts-report' } as any);
  expect(r.text).toContain('| main | claude-opus-4-7 | 1 | 100 | 0 | 0 | 50 |');
  expect(r.text).toContain('| subagent | claude-sonnet-4-6 | 1 | 40 | 0 | 0 | 10 |');
  expect(r.text).toContain('Agent calls: 1, with a model 0, without 1 (unspecified 100.0%)');
  expect(r.text).toContain('Opus/Fable share of subagent tokens: total 0.0%');
});

test('/ts-audit lists always-loaded files, plugins and a turn-off candidate', async ($, on) => {
  const files: Files = {
    [CLAUDE + '/CLAUDE.md']: 'x'.repeat(400),
    '/w/CLAUDE.md': 'y'.repeat(80),
    [CLAUDE + '/plugins/installed_plugins.json']: JSON.stringify({ plugins: { 'demo@mk': [{ version: '1.0.0', installPath: CLAUDE + '/plugins/cache/demo' }] } }),
    [PROJ + '/S1.jsonl']: asstAt('m1', 'claude-opus-4-7', { input_tokens: 1 }, [{ type: 'tool_use', id: 'k1', name: 'mcp__github__list', input: {} }]),
  };
  world(on, files);
  on('settings.read', () => ({ value: { enabledPlugins: { 'demo@mk': true } } }));
  const r: any = await $.command.run({ command: 'ts-audit', args: '--days 7' } as any);
  expect(r.text).toContain('Token Stamina fixed-cost audit (last 7 days, cwd /w)');
  expect(r.text).toMatch(/CLAUDE\.md\s+400\s+~100/);
  expect(r.text).toContain('demo@mk 1.0.0');
  expect(r.text).toContain('claude plugin disable demo@mk');
  expect(r.text).toMatch(/github\s+other\/user config\s+1/);
});

// ---- fixes from the adversarial review ----

test('/ts-report: no --since/--until reads the last 30 days and says so; --since leaves the window alone', async ($, on) => {
  world(on, { [PROJ + '/S1.jsonl']: asstAt('m1', 'claude-opus-4-7', { input_tokens: 100, output_tokens: 50 }) });
  const r: any = await $.command.run({ command: 'ts-report' } as any);
  expect(r.text).toContain('Default window: the last 30 days. Widen it with --since YYYY-MM-DD.');
  const r2: any = await $.command.run({ command: 'ts-report', args: '--since 2020-01-01' } as any);
  expect(r2.text).not.toContain('Default window');
  expect(r2.text).toContain('| main | claude-opus-4-7 | 1 | 100 | 0 | 0 | 50 |');
});

test('SessionStart startup: the nudge line recorded for the session is returned beside the restored note', async ($, on) => {
  const resets = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
  const usage = { startedAt: 0, context: { tokens: 1000, window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 97, resetsAt: resets }, { kind: 'five_hour', percentUsed: 97, resetsAt: resets }] };
  const files: Files = {
    [HOME + '/config.json']: JSON.stringify({ nudge: true }),
    [pendingClearName(DIR, HOST)]: JSON.stringify({ from: 'OLD', host: HOST, cwd: '/w', at: Date.now() - 1000 }),
    [sessionFileName(DIR, 'OLD')]: '# Handoff note (auto, no LLM)\nauto note body\n',
  };
  world(on, files, { host: HOST, usage });
  on('classic.SessionStart', () => ({}));
  const r: any = await $.classic.SessionStart({ source: 'startup', session_id: 'NEW', cwd: '/w', transcript_path: '/t/NEW.jsonl' } as any);
  const ctx: string[] = r.additionalContext || [];
  expect(ctx.join('\n')).toContain('auto note body');
  expect(ctx.length).toBeGreaterThan(1); // the nudge line is not dropped
  expect(JSON.parse(files[HOME + '/nudge.json'] || '{}').NEW).toBeDefined();
});

// ---- second round: the fallback path (a transcript over 4 MiB), fleet sessions, the report window ----

const TG = HOME + '/topic-gate.json';
const SIDE = DIR + '/S1.json';
const msgs = [{ role: 'user', content: 'do the thing' }, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }]; // no timestamps
const bigUsage = { startedAt: 0, context: { tokens: 250000, window: 1000000 }, rateLimits: [] };

test('fallback Stop (session.messages rows): recent stays, lastPromptTs is the promptAt UserPromptSubmit recorded, stopAt lands in the side file', async ($, on) => {
  const prev = { commits: [], files: [], lastPromptTs: '2026-10-31T10:05:00Z', prevPromptTs: '2026-10-31T10:00:00Z', recent: [{ ts: '2026-10-31T10:05:00Z', user: 'earlier ask', claude: 'earlier answer' }] };
  const files: Files = { [SIDE]: JSON.stringify(prev) };
  world(on, files, { messages: msgs });
  on('classic.UserPromptSubmit', () => ({}));
  on('classic.Stop', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'do the thing', transcript_path: '/t/big.jsonl' } as any);
  const promptAt = JSON.parse(files[TG]!).S1.promptAt;
  expect(typeof promptAt).toBe('number');
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/t/big.jsonl' } as any);
  const note = files[sessionFileName(DIR, 'S1')]!;
  expect(note).toContain('lastPromptTs=' + new Date(promptAt).toISOString() + ' ');
  expect(note).toContain('prevPromptTs=2026-10-31T10:05:00Z');
  const side = JSON.parse(files[SIDE]!);
  expect(side.recent).toEqual(prev.recent);
  expect(typeof side.stopAt).toBe('number');
  expect(JSON.parse(files[TG]!).S1.stopAt).toBeUndefined(); // Stop never writes topic-gate.json
});

test('fallback Stop with no promptAt on record keeps the carried lastPromptTs', async ($, on) => {
  const files: Files = { [SIDE]: JSON.stringify({ commits: [], files: [], lastPromptTs: '2026-10-31T10:05:00Z' }) };
  world(on, files, { messages: msgs });
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/t/big.jsonl' } as any);
  expect(files[sessionFileName(DIR, 'S1')]).toContain('lastPromptTs=2026-10-31T10:05:00Z ');
});

test('Stop on a readable transcript leaves no stopAt in the side file', async ($, on) => {
  const files2: Files = { '/t/ok.jsonl': prompt('hello') + asst([{ type: 'text', text: 'hi' }]) };
  world(on, files2);
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S2', cwd: '/w', transcript_path: '/t/ok.jsonl' } as any);
  expect('stopAt' in JSON.parse(files2[DIR + '/S2.json']!)).toBe(false);
});

const H = 3600 * 1000;
const idleRun = ($: any, on: any) => async (promptAt: number) => {
    const files: Files = {
      [SIDE]: JSON.stringify({ commits: [], files: [], stopAt: Date.now() - 2 * H }),
      [TG]: JSON.stringify({ S1: { cwd: '/w', promptAt, ts: promptAt } }),
    };
    world(on, files, { messages: [{ role: 'assistant', content: [] }], usage: bigUsage });
    on('classic.UserPromptSubmit', () => ({}));
    await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'next', transcript_path: '/t/big.jsonl' } as any);
    return evText(files);
};

test('UserPromptSubmit on the fallback path: the side file stopAt opens the idle gate', async ($, on) => {
  expect(await idleRun($, on)(Date.now() - 3 * H)).toContain('"topic_gate"');
});

test('UserPromptSubmit on the fallback path: a prompt newer than the Stop (interrupted turn) opens no gate', async ($, on) => {
  expect(await idleRun($, on)(Date.now() - 1 * H)).not.toContain('"topic_gate"');
});

const OTHERS = () => {
  const files: Files = {};
  for (const n of ['A', 'B', 'C', 'D']) files[PROJ + '/OTHER' + n + '.jsonl'] = line({ type: 'user', cwd: '/o' + n, entrypoint: 'cli' });
  return files;
};
const fleetCfg = (extra: object) => ({ [HOME + '/config.json']: JSON.stringify({ fleet: true, fleetShowAt: 1, ...extra }) });

test('Agent call with fleet on: other active sessions are counted (fleet_sessions) and reach fleetTotalWarnAt', async ($, on) => {
  const files: Files = { ...OTHERS(), ...fleetCfg({}) };
  world(on, files);
  on('classic.SessionStart', () => ({}));
  on('tool.call', () => ({ result: {} }));
  await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: PROJ + '/S1.jsonl' } as any);
  await $.tool.call({ tool: 'Agent', description: 'do the thing', prompt: 'do the thing', subagent_type: 'general-purpose' } as any);
  const ev = evText(files);
  expect(ev).toContain('"fleet_sessions":4');
  expect(ev).toContain('"reason":"fleet_advise_nostate"'); // 0 running + 4 sessions >= fleetTotalWarnAt 4
});

test('Agent call with fleetSessions:false counts no sessions (fleet_sessions null, no advice)', async ($, on) => {
  const files2: Files = { ...OTHERS(), ...fleetCfg({ fleetSessions: false }) };
  world(on, files2);
  on('classic.SessionStart', () => ({}));
  on('tool.call', () => ({ result: {} }));
  await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: PROJ + '/S1.jsonl' } as any);
  await $.tool.call({ tool: 'Agent', description: 'do the thing', prompt: 'do the thing', subagent_type: 'general-purpose' } as any);
  const ev2 = evText(files2);
  expect(ev2).toContain('"fleet_sessions":null');
  expect(ev2).not.toContain('fleet_advise_nostate');
});

test('Agent call at red usage with 4 other sessions: the total-sessions hard line sets the fleet downgrade', async ($, on) => {
  const resets = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
  const usage = { startedAt: 0, context: { tokens: 1000, window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 97, resetsAt: resets }, { kind: 'five_hour', percentUsed: 97, resetsAt: resets }] };
  const files: Files = { ...OTHERS(), ...fleetCfg({ fleetTotalHardAt: 4 }) };
  world(on, files, { usage });
  on('classic.SessionStart', () => ({}));
  let seen: any = null;
  on('tool.call', (_: any, e: any) => {
    seen = e;
    return { result: {} };
  });
  await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: PROJ + '/S1.jsonl' } as any);
  await $.tool.call({ tool: 'Agent', description: 'do the thing', prompt: 'do the thing', subagent_type: 'general-purpose' } as any);
  expect(seen?.model).toBe('sonnet');
  expect(evText(files)).toContain('"reason":"fleet_hard_downgrade"');
});

test('/ts-report default window drops rows older than 30 days; --since widens it', async ($, on) => {
  const old = line({ type: 'assistant', isSidechain: false, timestamp: new Date(Date.now() - 60 * 86400 * 1000).toISOString(), message: { id: 'o1', model: 'claude-sonnet-4-6', role: 'assistant', content: [], usage: { input_tokens: 7, output_tokens: 3 } } });
  world(on, { [PROJ + '/S1.jsonl']: old + asstAt('m1', 'claude-opus-4-7', { input_tokens: 100, output_tokens: 50 }) });
  const r: any = await $.command.run({ command: 'ts-report' } as any);
  expect(r.text).toContain('claude-opus-4-7');
  expect(r.text).not.toContain('claude-sonnet-4-6');
  const r2: any = await $.command.run({ command: 'ts-report', args: '--since 2020-01-01' } as any);
  expect(r2.text).toContain('claude-sonnet-4-6');
});

// ---- third round: prompt times on the fallback path, the sessions cache window ----

test('UserPromptSubmit for an app event (<task-notification>) keeps the typed prompt times', async ($, on) => {
  const files: Files = { [TG]: JSON.stringify({ S1: { cwd: '/w', promptAt: 1000, prevPromptAt: 500, ts: 1000 } }) };
  world(on, files, { messages: msgs });
  on('classic.UserPromptSubmit', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: '<task-notification>agent done</task-notification>', transcript_path: '/t/big.jsonl' } as any);
  const rec = JSON.parse(files[TG]!).S1;
  expect([rec.promptAt, rec.prevPromptAt]).toEqual([1000, 500]);
  expect(rec.ts).toBeGreaterThan(1000);
});

test('fallback Stop after two typed prompts (the first turn ended without a Stop): prevPromptTs is the first prompt', async ($, on) => {
  const files: Files = { [SIDE]: JSON.stringify({ commits: [], files: [], lastPromptTs: '2026-10-31T10:05:00Z' }) };
  world(on, files, { messages: msgs });
  on('classic.UserPromptSubmit', () => ({}));
  on('classic.Stop', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'first', transcript_path: '/t/big.jsonl' } as any);
  const first = JSON.parse(files[TG]!).S1.promptAt;
  await new Promise((r) => setTimeout(r, 5));
  await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'second', transcript_path: '/t/big.jsonl' } as any);
  const tg = JSON.parse(files[TG]!).S1;
  expect(tg.prevPromptAt).toBe(first);
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/t/big.jsonl' } as any);
  const note = files[sessionFileName(DIR, 'S1')]!;
  expect(note).toContain('lastPromptTs=' + new Date(tg.promptAt).toISOString() + ' ');
  expect(note).toContain('prevPromptTs=' + new Date(first).toISOString());
});

const cacheRun = async ($: any, on: any, cacheSec: number, sid: string) => {
  const files: Files = { ...OTHERS(), ...fleetCfg({ fleetSessionsCacheSec: cacheSec }) };
  world(on, files);
  on('classic.SessionStart', () => ({}));
  on('tool.call', () => ({ result: {} }));
  await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: PROJ + '/' + sid + '.jsonl' } as any);
  await $.tool.call({ tool: 'Agent', description: 'do the thing', prompt: 'do the thing', subagent_type: 'general-purpose' } as any);
  files[PROJ + '/OTHERE.jsonl'] = line({ type: 'user', cwd: '/oE', entrypoint: 'cli' });
  await $.tool.call({ tool: 'Agent', description: 'do the thing', prompt: 'do the thing', subagent_type: 'general-purpose' } as any);
  return evText(files);
};

test('fleetSessionsCacheSec 30: a session started between two Agent calls is not seen until the cache runs out', async ($, on) => {
  const ev = await cacheRun($, on, 30, 'C30');
  expect(ev.match(/"fleet_sessions":\d+/g)).toEqual(['"fleet_sessions":4', '"fleet_sessions":4']);
});

test('fleetSessionsCacheSec 0: every Agent call scans again', async ($, on) => {
  const ev = await cacheRun($, on, 0, 'C0');
  expect(ev.match(/"fleet_sessions":\d+/g)).toEqual(['"fleet_sessions":4', '"fleet_sessions":5']);
});

test('an old Node status line entry gets one on-screen line pointing to setup, once', async ($, on) => {
  const files: Files = { '/h/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 'node "/h/.claude/token-stamina/token-stamina-statusline.js"' } }) };
  world(on, files);
  const logged: string[] = [];
  on('ui.log', (_: any, e: any) => {
    logged.push(String(e.text));
    return { value: undefined };
  });
  on('classic.SessionStart', () => ({}));
  const r: any = await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  expect(logged.join(' ')).toContain('/token-stamina:setup');
  expect((r.additionalContext || []).join(' ')).not.toContain('/token-stamina:setup');
  await $.classic.SessionStart({ source: 'startup', session_id: 'S2', cwd: '/w', transcript_path: '/t/S2.jsonl' } as any);
  expect(logged.length).toBe(1);
});

// 0.6.1: each session writes its own slot file under events/, so two processes never rewrite the same file.
const EV = HOME + '/events/';
const slotFor = (sid: string, k = 0) => EV + slotName((hash(sid) % SLOTS) + k);
const agentCall = async ($: any, on: any, files: Files) => {
  world(on, files);
  on('tool.call', () => ({ result: {} }));
  await $.tool.call({ tool: 'Agent', description: 'do the thing', prompt: 'do the thing', subagent_type: 'general-purpose' } as any);
};

test('an event goes to the session slot file, which starts with its owner line', async ($, on) => {
  const files: Files = {};
  await agentCall($, on, files);
  const t = files[slotFor('S1')]!;
  expect(JSON.parse(t.split('\n')[0]!).owner).toBe('S1');
  expect(t).toContain('"event":"agent_model"');
  expect(files[HOME + '/events.jsonl']).toBeUndefined();
});

test('a slot another session holds is left alone: the event goes to the next slot', async ($, on) => {
  const other = evHeader('OTHER', Date.now()) + line({ v: 5, ts: new Date().toISOString(), event: 'nudge', session: 'OTHER' });
  const files: Files = { [slotFor('S1')]: other };
  await agentCall($, on, files);
  expect(files[slotFor('S1')]).toBe(other);
  expect(files[slotFor('S1', 1)]).toContain('"event":"agent_model"');
});

test('a slot over 3 MiB moves aside to its .old file and starts again with the owner line', async ($, on) => {
  const big = evHeader('S1', Date.now()) + (line({ v: 5, ts: new Date().toISOString(), event: 'filler', session: 'S1', pad: 'x'.repeat(1000) })).repeat(3300);
  const files: Files = { [slotFor('S1')]: big };
  await agentCall($, on, files);
  expect(files[slotFor('S1').replace(/\.jsonl$/, '.old.jsonl')]).toBe(big);
  const t = files[slotFor('S1')]!;
  expect(t.length < 10000).toBe(true);
  expect(JSON.parse(t.split('\n')[0]!).owner).toBe('S1');
  expect(t).toContain('"event":"agent_model"');
});

test('/ts-savings reads the events in the slot files', async ($, on) => {
  const events = evHeader('S1', Date.now()) + line({ v: 5, ts: iso(), event: 'agent_model', action: 'inject', session: 'S1', tool_use_id: 't1', model: 'sonnet', requested_model: 'opus' });
  const transcript =
    asstAt('m1', 'claude-opus-4-7', { input_tokens: 10, output_tokens: 5 }, [{ type: 'tool_use', id: 't1', name: 'Agent', input: {} }]) +
    line({ type: 'user', isSidechain: false, toolUseResult: { status: 'completed', resolvedModel: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100 } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  world(on, { [slotFor('S1')]: events, [PROJ + '/S1.jsonl']: transcript });
  const r: any = await $.command.run({ command: 'ts-savings' } as any);
  expect(r.text).toContain('Model downgrade: 1 calls, 1.1k tokens, Opus-input equiv 600 (est.)');
});

test('two sessions claiming the same free slot: the one whose header was overwritten moves to the next slot', async ($, on) => {
  const files: Files = {};
  let raced = false;
  world(on, files, {
    onWrite: (p, text) => {
      if (raced || p !== slotFor('S1') || !text.includes('"owner":"S1"')) return false;
      raced = true;
      files[p] = evHeader('RIVAL', Date.now()); // the rival's write lands after ours
      return true;
    },
  });
  on('tool.call', () => ({ result: {} }));
  await $.tool.call({ tool: 'Agent', description: 'do the thing', prompt: 'do the thing', subagent_type: 'general-purpose' } as any);
  expect(raced).toBe(true);
  expect(files[slotFor('S1')]).not.toContain('agent_model');
  expect(files[slotFor('S1', 1)]).toContain('"event":"agent_model"');
});

// 0.6.1: $.fs has no delete, so note files unchanged for 7 days are emptied; an empty note reads as none.
const DAY = 86400 * 1000;

test('startup empties handoff files unchanged for 7 days and leaves newer ones', async ($, on) => {
  const old = sessionFileName(DIR, 'OLD');
  const fresh = sessionFileName(DIR, 'NEW');
  const files: Files = { [old]: '# old note\nsecret plan\n', [DIR + '/OLD.json']: '{"commits":[]}', [fresh]: '# new note\n' };
  world(on, files, { ages: { [old]: 8 * DAY, [DIR + '/OLD.json']: 8 * DAY, [fresh]: 6 * DAY } });
  on('classic.SessionStart', () => ({}));
  await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  expect(files[old]).toBe('');
  expect(files[DIR + '/OLD.json']).toBe('');
  expect(files[fresh]).toBe('# new note\n');
});

test('SessionStart compact: an emptied session note reads as none, so the cwd latest note comes back instead', async ($, on) => {
  const files: Files = { [sessionFileName(DIR, 'S1')]: '', [latestFileName(DIR, '/w')]: '# Handoff note (auto, no LLM)\n- cwd: /w\n\nlatest work\n' };
  world(on, files);
  on('classic.SessionStart', () => ({}));
  const r: any = await $.classic.SessionStart({ source: 'compact', session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  expect((r.additionalContext || []).join('\n')).toContain('latest work');
});

// ---- efficiency board: the per-session row (Stop / UserPromptSubmit) and the `board` tool ----

const BOARD = HOME + '/board';
const BTOOL = 'mcp__token-stamina__board';
const boardTranscript = () => prompt('hello') + asstAt('m1', 'claude-opus-4-7', { input_tokens: 5000, cache_read_input_tokens: 100, output_tokens: 10 });
const nowIso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString();
// A board row as the Stop hook writes it, for the tool tests.
const rowDoc = (sid: string, over: Record<string, unknown> = {}) => ({
  sid, cwd_tail: 'proj', model: 'claude-opus-4-7', entrypoint: null, protected: false, last_user_ts: Math.floor(Date.now() / 1000) - 600, last_ts: Math.floor(Date.now() / 1000) - 590,
  in_last: 40000, in_med10: 40000, in_trend: 0, spark: [40000], hit: 0.9, hit_active: 0.9, miss_after_idle: 0, j: 0, fit: 'lower_candidate', estimated: true,
  ctx_tokens: 40000, clear_candidate: false, idle_sec: 600, agents_running: 0, agents_upper: 0, agent_tokens_done: null, agent_tokens_live: null, agent_share: null,
  sample_turns: 5, updated_at: nowIso(-30), ...over,
});
async function callBoard($: any, input: Record<string, unknown>): Promise<any> {
  const r: any = await $.tool.call({ tool: BTOOL, ...input } as any);
  return JSON.parse(r.deny !== undefined ? r.deny : r.result); // 0.6.8: the answer is a string; an error is a deny
}
const redUsage = () => {
  const resets = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
  return { startedAt: 0, context: { tokens: 1000, window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 97, resetsAt: resets }, { kind: 'five_hour', percentUsed: 97, resetsAt: resets }] };
};

test('board row: Stop writes board/S1.json only when dashboardUrl is set', async ($, on) => {
  const files: Files = { '/t/S1.jsonl': boardTranscript(), [HOME + '/config.json']: JSON.stringify({ dashboardUrl: 'https://claude.ai/artifact/x' }) };
  world(on, files);
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w/proj', transcript_path: '/t/S1.jsonl' } as any);
  const r = JSON.parse(files[BOARD + '/S1.json'] || 'null');
  expect(r?.sid).toBe('S1');
  expect(r?.cwd_tail).toBe('proj');
  expect(r?.in_last).toBe(5100);
});

test('board row: no row when dashboardUrl is empty', async ($, on) => {
  const files2: Files = { '/t/S1.jsonl': boardTranscript(), [HOME + '/config.json']: JSON.stringify({ dashboardUrl: '' }) };
  world(on, files2);
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w/proj', transcript_path: '/t/S1.jsonl' } as any);
  expect(files2[BOARD + '/S1.json']).toBeUndefined();
});

test('board row: an expired row file is emptied, a fresh one and the ledger stay; a row never overwrites the ledger', async ($, on) => {
  const ledger = JSON.stringify({ rows: [{ pid: 'sm-000000000000', status: 'approved' }], proposals: {} });
  const files: Files = {
    '/t/S1.jsonl': boardTranscript(), [HOME + '/config.json']: JSON.stringify({ dashboardUrl: 'https://claude.ai/artifact/x' }),
    [BOARD + '/OLD.json']: JSON.stringify(rowDoc('OLD', { updated_at: nowIso(-3 * 86400) })),
    [BOARD + '/FRESH.json']: JSON.stringify(rowDoc('FRESH')),
    [BOARD + '/decisions.json']: ledger,
  };
  world(on, files);
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w/proj', transcript_path: '/t/S1.jsonl' } as any);
  expect(files[BOARD + '/OLD.json']).toBe('');
  expect(JSON.parse(files[BOARD + '/FRESH.json']!).sid).toBe('FRESH');
  expect(files[BOARD + '/decisions.json']).toBe(ledger);
  // a session whose id is "decisions" must not clobber the ledger
  files['/t/decisions.jsonl'] = boardTranscript();
  await $.classic.Stop({ session_id: 'decisions', cwd: '/w/proj', transcript_path: '/t/decisions.jsonl' } as any);
  expect(files[BOARD + '/decisions.json']).toBe(ledger);
  // an emptied row file may be written again by its own session
  files['/t/OLD.jsonl'] = boardTranscript();
  await $.classic.Stop({ session_id: 'OLD', cwd: '/w/proj', transcript_path: '/t/OLD.jsonl' } as any);
  expect(JSON.parse(files[BOARD + '/OLD.json']!).sid).toBe('OLD');
});

test('board tool: session.start declares it', async ($, on) => {
  const tools: any[] = [];
  on('tool.register', (_: any, e: any) => {
    tools.push(e);
    return { value: { tool: 'mcp__token-stamina__' + e.name } };
  });
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }));
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }));
  world(on, {});
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  expect(tools.map((t) => t.name).join(',')).toBe('board,advisor');
  expect(tools[1].isDeferred).toBe(true);
  expect(tools[1].inputSchema.properties.mode.enum).toEqual(['analyze', 'recommend', 'plan', 'apply', 'revert', 'reject', 'review', 'check']);
  expect(tools[0].inputSchema.properties.mode.enum).toContain('record-push');
});

test('board tool rows: writes the batch files, then skips as unchanged once record-push has run', async ($, on) => {
  const files: Files = { [BOARD + '/S1.json']: JSON.stringify(rowDoc('S1')) };
  world(on, files);
  const a = await callBoard($, { mode: 'rows' });
  expect(a.skip).toBe(false);
  expect(a.rows).toBe(1);
  expect(a.writes_count).toBe(3); // account, summary, sessions/S1
  const batch = JSON.parse(files[norm(a.batch_file)]!);
  expect(batch.writes.length).toBe(3);
  const w = batch.writes.find((x: any) => x.collection === 'sessions');
  expect(w.doc_id).toBe('S1');
  expect(JSON.parse(files[norm(w.file_path)]!).sid).toBe('S1');
  expect(JSON.parse(files[HOME + '/board-push/pending.json']!).rows).toBe(1);

  const rec = await callBoard($, { mode: 'record-push', tokens: 1234, rows: 1 });
  expect(rec).toEqual({ recorded: true, rows: 1, tokens: 1234 });
  expect(evText(files)).toContain('"event":"board_push"');
  const b = await callBoard($, { mode: 'rows' });
  expect(b.skip).toBe(true);
  expect(b.reason).toBe('unchanged');

  const j = await callBoard($, { mode: 'json' });
  expect(j.count).toBe(1);
  expect(j.source).toBe('board-dir');
});

test('board tool rows: the day budget counts board_push tokens of every session slot file', async ($, on) => {
  const slot = HOME + '/events/s001.jsonl';
  const files: Files = {
    [BOARD + '/S1.json']: JSON.stringify(rowDoc('S1')),
    [slot]: evHeader('OTHER', Date.now()) + JSON.stringify({ v: 5, ts: nowIso(-3600), event: 'board_push', tokens: 200000, rows: 1 }) + '\n',
  };
  world(on, files);
  const a = await callBoard($, { mode: 'rows' });
  expect(a.skip).toBe(true);
  expect(a.reason).toBe('budget');
  expect(a.tokens_24h).toBe(200000);
  expect(a.daily_limit).toBe(150000);
});

test('board tool apply: an approved decision becomes a set_session_model op and is kept in the ledger', async ($, on) => {
  const live = [{ sessionId: 'S1', model: 'claude-opus-4-7', cwd: '/w/proj', title: 'proj work' }];
  const files: Files = {
    [BOARD + '/S1.json']: JSON.stringify(rowDoc('S1')),
    [HOME + '/config.json']: JSON.stringify({ applyMode: 'approve' }),
    '/t/live.json': JSON.stringify(live),
  };
  world(on, files, { usage: redUsage() });
  // rows remembers the proposal card locally; apply reads proposal content only from there
  const a = await callBoard($, { mode: 'rows', titles: '/t/live.json' });
  expect(a.skip).toBe(false);
  expect(a.proposals).toBeGreaterThan(0);
  const pid = Object.keys(JSON.parse(files[BOARD + '/decisions.json']!).proposals).find((k) => k.startsWith('sm-'))!;
  expect(pid).toBeDefined();
  files['/t/dec.json'] = JSON.stringify([{ pid, status: 'approved', decided_by: 'owner', decided_at: nowIso(-60) }]);
  const r = await callBoard($, { mode: 'apply', decisions: '/t/dec.json', live: '/t/live.json' });
  expect(r.ops.length).toBe(1);
  expect(r.ops[0].tool).toBe('set_session_model');
  expect(r.ops[0].args).toEqual({ session_id: 'S1', model: 'sonnet' });
  expect(r.apply_mode).toBe('approve');
  const led = JSON.parse(files[BOARD + '/decisions.json']!);
  expect(led.rows.some((x: any) => x.pid === pid)).toBe(true);
  expect(Object.keys(led.proposals)).toContain(pid);
  expect(evText(files)).toContain('"event":"decision_apply"');
  // the runner's result is recorded
  const rr = await callBoard($, { mode: 'record-apply', results: JSON.stringify([{ pid, ok: true }]) });
  expect(rr.results[0].status).toBe('applied');
  expect(JSON.parse(files[BOARD + '/decisions.json']!).rows.find((x: any) => x.pid === pid).status).toBe('applied');
});

test('board tool: an unknown mode and a failing mode answer in the Node error shapes', async ($, on) => {
  world(on, {}, { denyWrite: 'disk full' });
  const bad = await callBoard($, { mode: 'nope' });
  expect(bad.error).toContain('unknown mode');
  const rp = await callBoard($, { mode: 'record-push' });
  expect(rp.recorded).toBe(false);
  expect(rp.error).toContain('disk full');
});

test('board tool apply: a config.json that cannot be parsed is left as it is, and the answer is an error', async ($, on) => {
  const broken = '{ "lang": "ko", oops';
  const files: Files = { [HOME + '/config.json']: broken, '/t/dec.json': '[]' };
  world(on, files);
  const r: any = await $.tool.call({ tool: BTOOL, mode: 'apply', decisions: '/t/dec.json' } as any);
  expect(typeof r.deny).toBe('string');
  const out = JSON.parse(r.deny);
  expect(out.ops).toEqual([]);
  expect(out.error).toContain('config.json');
  expect(files[HOME + '/config.json']).toBe(broken);
  expect(files[HOME + '/config.prev.json']).toBeUndefined();
});

test('board row: a prompt writes no row (rows are written at Stop only)', async ($, on) => {
  const files: Files = { '/t/S1.jsonl': boardTranscript(), [HOME + '/config.json']: JSON.stringify({ dashboardUrl: 'https://claude.ai/artifact/x' }) };
  world(on, files);
  on('classic.UserPromptSubmit', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w/proj', prompt: 'next', transcript_path: '/t/S1.jsonl' } as any);
  expect(files[BOARD + '/S1.json']).toBeUndefined();
});

test('an event without a session id is not written (it would share one slot across processes)', async ($, on) => {
  const files: Files = {};
  world(on, files, { noSid: true });
  await callBoard($, { mode: 'record-push', tokens: 5, rows: 1 });
  expect(evText(files)).toBe('');
});

// ---- Usage Advisor: the tool, /ts-advisor, the SessionStart weekly run and card, the hook-side keys ----

const ATOOL = 'mcp__token-stamina__advisor';
const ADV = HOME + '/advisor';
const callAdvisor = async ($: any, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
  const r: any = await $.tool.call({ tool: ATOOL, ...input } as any);
  // 0.6.8: a string result, or a deny for an error (an object result fails the engine's output-shape check)
  return r.deny !== undefined ? { text: r.deny, isError: true } : { text: r.result, isError: false };
};
// Plays the person at the AskUserQuestion dialog: answers every question with `label` and keeps the question texts.
const answer: { label: string | null } = { label: null };
const seenQuestions: any[] = [];
const person = (on: any, label: string | null, asked: string[] = []) => {
  answer.label = label;
  seenQuestions.length = 0;
  on('session.surfaces', () => ({ value: answer.label === null ? [] : ['terminal'] })); // the tool asks only when someone is at a surface
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    for (const q of e.questions || []) { asked.push(q.question); seenQuestions.push(q); }
    const label = answer.label;
    if (label === null) return { deny: 'dismissed' };
    const answers: Record<string, string> = {};
    for (const q of e.questions || []) answers[q.question] = label;
    return { result: { questions: e.questions, answers } };
  });
  return asked;
};
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};
const planDoc = (over: Record<string, unknown> = {}) => JSON.stringify({
  id: 'pl-abc123', created: Date.now(), expires: Date.now() + 600000, settingsPath: CLAUDE + '/settings.json',
  items: [{ id: 'R2', rule: 'R2', file: 'config', key: 'advisorMinEffectUsd', before: 5, after: 8, hadKey: true }],
  notes: [], titles: { R2: 'Effect threshold' }, risks: { R2: 'A' }, follow: {}, ...over,
});

test('advisor tool: with too little data recommend says so, and plan hands out no planId', async ($, on) => {
  const files: Files = {};
  world(on, files);
  const rec = await callAdvisor($, { mode: 'recommend' });
  expect(rec.isError).toBe(false);
  expect(rec.text).toContain('Not enough records yet');
  const pl = await callAdvisor($, { mode: 'plan', ids: ['R1'] });
  expect(JSON.parse(pl.text).planId).toBe(null);
  expect(files[ADV + '/plan.json'] ?? '').toBe('');
});

test('advisor tool: apply refuses a missing, unknown or expired planId and ids that were not in the plan, and changes nothing', async ($, on) => {
  const cfg = JSON.stringify({ advisorMinEffectUsd: 5 });
  const files: Files = { [HOME + '/config.json']: cfg, [ADV + '/plan.json']: planDoc() };
  world(on, files);
  const none = await callAdvisor($, { mode: 'apply', ids: ['R2'] });
  expect(none.isError).toBe(true);
  expect(none.text).toContain('Nothing changed');
  const wrong = await callAdvisor($, { mode: 'apply', planId: 'pl-other', ids: ['R2'] });
  expect(wrong.isError).toBe(true);
  const extra = await callAdvisor($, { mode: 'apply', planId: 'pl-abc123', ids: ['R2', 'R4'] });
  expect(extra.isError).toBe(true);
  expect(extra.text).toContain('Not in the plan: R4');
  files[ADV + '/plan.json'] = planDoc({ expires: Date.now() - 1000 });
  const old = await callAdvisor($, { mode: 'apply', planId: 'pl-abc123', ids: ['R2'] });
  expect(old.isError).toBe(true);
  expect(old.text).toContain('older than 10 minutes');
  expect(files[HOME + '/config.json']).toBe(cfg);
});

test('advisor tool: apply writes the planned value with a backup, a second apply of the same plan is refused, revert puts the old value back', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ advisorMinEffectUsd: 5 }), [ADV + '/plan.json']: planDoc() };
  world(on, files);
  person(on, 'Apply');
  const ok = await callAdvisor($, { mode: 'apply', planId: 'pl-abc123', ids: ['R2'] });
  expect(ok.isError).toBe(false);
  const res = JSON.parse(ok.text);
  expect(res.applied).toEqual([{ id: 'R2', key: 'advisorMinEffectUsd' }]);
  expect(JSON.parse(files[HOME + '/config.json']!).advisorMinEffectUsd).toBe(8);
  expect(Object.keys(files).some((p) => p.startsWith(ADV + '/backups/config-'))).toBe(true);
  const again = await callAdvisor($, { mode: 'apply', planId: 'pl-abc123', ids: ['R2'] });
  expect(again.isError).toBe(true);
  const back = await callAdvisor($, { mode: 'revert', last: true });
  expect(back.isError).toBe(false);
  expect(JSON.parse(files[HOME + '/config.json']!).advisorMinEffectUsd).toBe(5);
});

test('advisor tool: revert does nothing when the value is no longer what apply wrote', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ advisorMinEffectUsd: 5 }), [ADV + '/plan.json']: planDoc() };
  world(on, files);
  person(on, 'Apply');
  await callAdvisor($, { mode: 'apply', planId: 'pl-abc123', ids: ['R2'] });
  files[HOME + '/config.json'] = JSON.stringify({ advisorMinEffectUsd: 11 });
  const back = await callAdvisor($, { mode: 'revert', last: true });
  expect(back.isError).toBe(true);
  expect(JSON.parse(files[HOME + '/config.json']!).advisorMinEffectUsd).toBe(11);
});

test('advisor tool: an unknown mode is an error answer', async ($, on) => {
  world(on, {});
  const r = await callAdvisor($, { mode: 'explode' });
  expect(r.isError).toBe(true);
  expect(r.text).toContain('unknown mode');
});

test('/ts-advisor prints the recommendation screen without a model, and --json is JSON', async ($, on) => {
  world(on, {});
  const r: any = await $.command.run({ command: 'ts-advisor' } as any);
  expect(r.text).toContain('Not enough records yet');
  const j: any = await $.command.run({ command: 'ts-advisor', args: '--json --days 7' } as any);
  expect(JSON.parse(j.text).schema).toBe(1);
});

test('SessionStart: the first start seeds next_due a week ahead; the weekly run does not start before it', async ($, on) => {
  const files: Files = {};
  world(on, files);
  on('classic.SessionStart', () => ({}));
  await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  const sch = JSON.parse(files[ADV + '/schedule.json']!);
  expect(Date.parse(sch.next_due) - Date.now()).toBeGreaterThan(6 * 86400000);
  expect(sch.checked).toBeUndefined();
  expect(files[ADV + '/weekly.lock']).toBeUndefined();
});

test('SessionStart: a due weekly run goes in the background, marks the day tried and finishes into schedule.json; it does not run twice a day', async ($, on) => {
  const files: Files = { [ADV + '/schedule.json']: JSON.stringify({ next_due: new Date(Date.now() - 1000).toISOString() }) };
  world(on, files);
  on('classic.SessionStart', () => ({}));
  const r: any = await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  expect(r).toBeDefined(); // the hook answered without waiting for the run
  expect(typeof JSON.parse(files[ADV + '/schedule.json']!).checked).toBe('number');
  await until(() => !!JSON.parse(files[ADV + '/schedule.json']!).last_run);
  const sch = JSON.parse(files[ADV + '/schedule.json']!);
  expect(sch.last_result).toBe('insufficient');
  expect(Date.parse(sch.next_due)).toBeGreaterThan(Date.now());
  await until(() => files[ADV + '/weekly.lock'] === '');
  expect(files[ADV + '/weekly.lock']).toBe(''); // released
  const before = sch.last_run;
  await $.classic.SessionStart({ source: 'startup', session_id: 'S2', cwd: '/w', transcript_path: '/t/S2.jsonl' } as any);
  expect(JSON.parse(files[ADV + '/schedule.json']!).last_run).toBe(before);
});

test('SessionStart: advisor false never reads or writes advisor files', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ advisor: false }) };
  world(on, files);
  on('classic.SessionStart', () => ({}));
  await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  expect(Object.keys(files).filter((p) => p.startsWith(ADV))).toEqual([]);
});

test('SessionStart: a pending suggestion becomes one card line for Claude, once per 7 days', async ($, on) => {
  const pend = { id: 'pd-1', created: new Date().toISOString(), items: [{ id: 'R2', rule: 'R2', title: 't', risk: 'A', effect: { lo: 1, hi: 2, unit: 'usd_per_week' } }], shownAt: null, auto: [] };
  const files: Files = { [ADV + '/pending.json']: JSON.stringify(pend), [ADV + '/schedule.json']: JSON.stringify({ next_due: new Date(Date.now() + 86400000).toISOString() }) };
  world(on, files);
  on('session.surfaces', () => ({ value: ['terminal'] }));
  on('classic.SessionStart', () => ({}));
  const r1: any = await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  const ctx1 = (r1.additionalContext || []).join('\n');
  expect(ctx1).toContain('1 usage suggestion');
  expect(ctx1).toContain('mode "review"');
  expect(JSON.parse(files[ADV + '/pending.json']!).shownAt).not.toBe(null);
  const r2: any = await $.classic.SessionStart({ source: 'startup', session_id: 'S2', cwd: '/w', transcript_path: '/t/S2.jsonl' } as any);
  expect((r2.additionalContext || []).join('\n')).not.toContain('usage suggestion');
});

const bashTool = ($: any, over: Record<string, unknown>) => $.tool.call({ tool: 'Bash', command: 'echo hi', ...over } as any);

test('sub-wait: a long Bash command inside a subagent gets one note per agent; the call itself is not touched', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ subagentLongCmdAdvice: true }) };
  world(on, files);
  let seen: any = null;
  on('tool.call', (_: any, e: any) => {
    seen = e;
    return { result: { ok: true } };
  });
  const a = await bashTool($, { agentId: 'a1', timeout: 400000 });
  expect(seen.command).toBe('echo hi');
  expect((a.context || []).join('\n')).toContain('may have run over 5 minutes');
  const b = await bashTool($, { agentId: 'a1', timeout: 400000 });
  expect(b.context || []).toEqual([]);
  const c = await bashTool($, { agentId: 'a2', command: 'npm test' });
  expect((c.context || []).join('\n')).toContain('command: npm test');
});

test('sub-wait: no note on the main loop, for a background command, a short command, or when the key is off', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ subagentLongCmdAdvice: true }) };
  world(on, files);
  on('tool.call', () => ({ result: {} }));
  expect(((await bashTool($, { timeout: 400000 })).context || []).length).toBe(0);
  expect(((await bashTool($, { agentId: 'a1', timeout: 400000, run_in_background: true })).context || []).length).toBe(0);
  expect(((await bashTool($, { agentId: 'a1', timeout: 1000 })).context || []).length).toBe(0);
  files[HOME + '/config.json'] = JSON.stringify({ subagentLongCmdAdvice: false });
  expect(((await bashTool($, { agentId: 'a3', timeout: 400000 })).context || []).length).toBe(0);
});

test('subagentWaitAdvice: the first Agent call of a session carries one idle-wait sentence, the second none', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ subagentWaitAdvice: true }) };
  world(on, files);
  on('tool.call', () => ({ result: {} }));
  const agent = () => $.tool.call({ tool: 'Agent', description: 'do the thing', prompt: 'do the thing', subagent_type: 'general-purpose' } as any);
  const a: any = await agent();
  expect((a.context || []).join('\n')).toContain('idle for more than 5 minutes');
  const b: any = await agent();
  expect((b.context || []).join('\n')).not.toContain('idle for more than 5 minutes');
});

const gotHint = async ($: any, on: any, cfg: Record<string, unknown>) => {
  const usage = { startedAt: 0, context: { tokens: 160000, window: 1000000 }, rateLimits: [] };
  const files: Files = { [HOME + '/config.json']: JSON.stringify(cfg) };
  world(on, files, { usage });
  on('classic.UserPromptSubmit', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'next', transcript_path: '/t/S1.jsonl' } as any);
  return evText(files).includes('"event":"inline_hint"');
};

test('the inline hint comes by default at 160k tokens', async ($, on) => {
  expect(await gotHint($, on, {})).toBe(true);
});

test('hintTrigger gap: the inline hint waits for an idle gap', async ($, on) => {
  expect(await gotHint($, on, { hintTrigger: 'gap' })).toBe(false);
});

test('hintMinEffectTokens with no computable card: the hint is not suppressed', async ($, on) => {
  expect(await gotHint($, on, { hintMinEffectTokens: 999999999 })).toBe(true); // no profile here (unknown card): not suppressed
});

test('oldModelWarn: a session on an older model generation gets one on-screen notice, once', async ($, on) => {
  const old = line({ type: 'assistant', isSidechain: false, timestamp: new Date().toISOString(), message: { id: 'm1', model: 'claude-opus-4-6-20250805', role: 'assistant', content: [], usage: { input_tokens: 10 } } });
  const files: Files = { '/t/S1.jsonl': old, [HOME + '/config.json']: JSON.stringify({ oldModelWarn: true }) };
  world(on, files);
  const notes: string[] = [];
  on('session.append', (_: any, e: any, next: any) => {
    notes.push(JSON.stringify(e.message));
    return next(e);
  });
  on('classic.UserPromptSubmit', () => ({}));
  const go = () => $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'next', transcript_path: '/t/S1.jsonl' } as any);
  await go();
  expect(notes.length).toBe(1);
  expect(notes[0]).toContain('older model generation');
  await go();
  expect(notes.length).toBe(1);
});

// ---- review fixes (mod side)
const settingsPlan = () => planDoc({ items: [
  { id: 'R3', rule: 'R3', file: 'settings', key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', before: null, after: '300000', hadKey: false },
  { id: 'R2', rule: 'R2', file: 'config', key: 'advisorMinEffectUsd', before: 5, after: 8, hadKey: true }] });

test('H1: with no one to ask (the dialog is dismissed or it is a -p run) apply writes nothing and says an interactive session is needed', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ advisorMinEffectUsd: 5 }), [ADV + '/plan.json']: settingsPlan(), [CLAUDE + '/settings.json']: '{}' };
  world(on, files);
  person(on, null);
  const r = await callAdvisor($, { mode: 'apply', planId: 'pl-abc123', ids: ['R3', 'R2'] });
  expect(r.isError).toBe(true);
  expect(r.text).toContain('interactive session needed; nothing changed');
  expect(files[CLAUDE + '/settings.json']).toBe('{}');
  expect(JSON.parse(files[HOME + '/config.json']!).advisorMinEffectUsd).toBe(5);
});

test('H1: the person is asked per item as "file key: before -> after"; Skip writes nothing, Apply writes settings.json', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ advisorMinEffectUsd: 5 }), [ADV + '/plan.json']: settingsPlan(), [CLAUDE + '/settings.json']: '{}' };
  world(on, files);
  const asked: string[] = [];
  person(on, 'Skip', asked);
  const skip = await callAdvisor($, { mode: 'apply', planId: 'pl-abc123', ids: ['R3', 'R2'] });
  expect(skip.isError).toBe(true);
  expect(asked.some((q) => q.includes('R3 settings env.CLAUDE_CODE_AUTO_COMPACT_WINDOW: (unset) -> 300000'))).toBe(true);
  expect(asked.some((q) => q.includes('R2 config advisorMinEffectUsd: 5 -> 8'))).toBe(true);
  expect(files[CLAUDE + '/settings.json']).toBe('{}');
  answer.label = 'Apply';
  const yes = await callAdvisor($, { mode: 'apply', planId: 'pl-abc123', ids: ['R3', 'R2'] });
  expect(yes.isError).toBe(false);
  expect(JSON.parse(files[CLAUDE + '/settings.json']!).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('300000');
});

const compactPlan = () => planDoc({ items: [
  { id: 'R3', rule: 'R3', file: 'settings', key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', before: null, after: '300000', hadKey: false },
  { id: 'R3', rule: 'R3', file: 'config', key: 'compactWindowTokens', before: null, after: 300000, hadKey: false },
  { id: 'R2', rule: 'R2', file: 'config', key: 'advisorMinEffectUsd', before: 5, after: 8, hadKey: true }] });

test('R1 rule-level ask: one question per rule listing all its file lines, Skip is the first option, the question ends with ?; Skip writes neither half, Apply writes both and revert restores both', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ advisorMinEffectUsd: 5 }), [ADV + '/plan.json']: compactPlan(), [CLAUDE + '/settings.json']: '{\n  "a": 1\n}\n' };
  world(on, files);
  const asked: string[] = [];
  person(on, 'Skip', asked);
  const skip = await callAdvisor($, { mode: 'apply', planId: 'pl-abc123', ids: ['R3', 'R2'] });
  expect(skip.isError).toBe(true);
  expect(asked.length).toBe(2); // R3 (two values) and R2: one question per rule, not per item
  const r3 = asked.find((q) => q.includes('rule R3'))!;
  expect(r3).toContain('R3 settings env.CLAUDE_CODE_AUTO_COMPACT_WINDOW: (unset) -> 300000');
  expect(r3).toContain('R3 config compactWindowTokens: (unset) -> 300000');
  for (const q of asked) expect(q.trimEnd().endsWith('?')).toBe(true);
  for (const q of seenQuestions) expect(String(q.options[0].label ?? q.options[0])).toBe('Skip');
  expect(files[CLAUDE + '/settings.json']).toBe('{\n  "a": 1\n}\n');
  expect(JSON.parse(files[HOME + '/config.json']!).compactWindowTokens).toBeUndefined();
  answer.label = 'Apply';
  const yes = await callAdvisor($, { mode: 'apply', planId: 'pl-abc123', ids: ['R3', 'R2'] });
  expect(yes.isError).toBe(false);
  expect(JSON.parse(files[CLAUDE + '/settings.json']!).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('300000');
  expect(JSON.parse(files[HOME + '/config.json']!).compactWindowTokens).toBe(300000);
  answer.label = 'Restore';
  const back = await callAdvisor($, { mode: 'revert', last: true });
  expect(back.isError).toBe(false);
  expect(seenQuestions[seenQuestions.length - 1].options[0].label ?? seenQuestions[seenQuestions.length - 1].options[0]).toBe('Keep');
  expect(JSON.parse(files[CLAUDE + '/settings.json']!).env).toBeUndefined();
  expect(JSON.parse(files[HOME + '/config.json']!).compactWindowTokens).toBeUndefined();
  expect(JSON.parse(files[HOME + '/config.json']!).advisorMinEffectUsd).toBe(5);
});

test('R4 nobody at a surface: the tool does not even ask (an auto-answering host cannot approve), nothing is written', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ advisorMinEffectUsd: 5 }), [ADV + '/plan.json']: compactPlan(), [CLAUDE + '/settings.json']: '{}' };
  world(on, files);
  let asks = 0;
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    asks++;
    const answers: Record<string, string> = {};
    for (const q of e.questions || []) answers[q.question] = 'Apply';
    return { result: { questions: e.questions, answers } };
  });
  on('session.surfaces', () => ({ value: [] }));
  const r = await callAdvisor($, { mode: 'apply', planId: 'pl-abc123', ids: ['R3', 'R2'] });
  expect(r.isError).toBe(true);
  expect(r.text).toContain('interactive session needed; nothing changed');
  expect(asks).toBe(0);
  expect(files[CLAUDE + '/settings.json']).toBe('{}');
  expect(JSON.parse(files[HOME + '/config.json']!).advisorMinEffectUsd).toBe(5);
});

test('M5: the weekly run and the pending card come only at startup or resume, and the card is not recorded as shown when no one is there', async ($, on) => {
  const pend = { id: 'pd-1', created: new Date().toISOString(), items: [{ id: 'R2', rule: 'R2', title: 't', risk: 'A', effect: { lo: 1, hi: 2, unit: 'usd_per_week' } }], shownAt: null, auto: [] };
  const files: Files = { [ADV + '/pending.json']: JSON.stringify(pend), [ADV + '/schedule.json']: JSON.stringify({ next_due: new Date(Date.now() - 1000).toISOString() }) };
  world(on, files);
  const surfaces: { list: string[] } = { list: [] };
  on('session.surfaces', () => ({ value: surfaces.list }));
  on('classic.SessionStart', () => ({}));
  const call = (source: string, sid: string) => $.classic.SessionStart({ source, session_id: sid, cwd: '/w', transcript_path: '/t/' + sid + '.jsonl' } as any);
  const c: any = await call('compact', 'S1');
  expect((c.additionalContext || []).join('\n')).not.toContain('usage suggestion');
  expect(JSON.parse(files[ADV + '/schedule.json']!).checked).toBeUndefined();
  const c2: any = await call('clear', 'S2');
  expect((c2.additionalContext || []).join('\n')).not.toContain('usage suggestion');
  const noHuman: any = await call('startup', 'S3'); // no surface: a -p / SDK run
  expect((noHuman.additionalContext || []).join('\n')).not.toContain('usage suggestion');
  expect(JSON.parse(files[ADV + '/pending.json']!).shownAt).toBe(null);
  surfaces.list = ['terminal'];
  const withHuman: any = await call('resume', 'S4');
  expect((withHuman.additionalContext || []).join('\n')).toContain('1 usage suggestion');
  expect(JSON.parse(files[ADV + '/pending.json']!).shownAt).not.toBe(null);
});

test('L7: sub-wait files untouched for 2 days are emptied (once per process); fresh ones stay', async ($, on) => {
  const old = HOME + '/sub-wait/old.json';
  const fresh = HOME + '/sub-wait/fresh.json';
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ subagentLongCmdAdvice: true }), [old]: '{"ids":["a"]}', [fresh]: '{"ids":["b"]}' };
  world(on, files, { ages: { [old]: 3 * 86400000 } });
  on('tool.call', () => ({ result: {} }));
  await bashTool($, { agentId: 'a1', timeout: 400000 });
  expect(files[old]).toBe('');
  expect(files[fresh]).toBe('{"ids":["b"]}');
});

test('L8: oldModelWarn does not read the transcript once the session was told', async ($, on) => {
  const old = line({ type: 'assistant', isSidechain: false, timestamp: new Date().toISOString(), message: { id: 'm1', model: 'claude-opus-4-6-20250805', role: 'assistant', content: [], usage: { input_tokens: 10 } } });
  const files: Files = { '/t/S1.jsonl': old, [HOME + '/config.json']: JSON.stringify({ oldModelWarn: true }), [HOME + '/old-model-warn.json']: JSON.stringify({ S1: Date.now() }) };
  let transcriptReads = 0;
  world(on, files, { onRead: (p) => { if (/S1\.jsonl$/.test(p)) transcriptReads++; } });
  on('classic.UserPromptSubmit', () => ({}));
  const go = () => $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'next', transcript_path: '/t/S1.jsonl' } as any);
  await go();
  const told = transcriptReads; // other hooks read the transcript too: compare with a session that was not told yet
  transcriptReads = 0;
  files[HOME + '/old-model-warn.json'] = '{}';
  await go();
  expect(transcriptReads).toBeGreaterThan(told);
});

// ---- 0.6.6 WP4: clear handoff reproductions, nudge machine-wide stamp, line_tokens ----

const evList = (files: Files): any[] => evText(files).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x && x.event);
const evOf = (files: Files, name: string) => evList(files).filter((x) => x.event === name);
const MIN = 60 * 1000;
const marker = (from: string, ageMs: number, extra: object = {}) => JSON.stringify({ from, host: HOST, cwd: '/w', at: Date.now() - ageMs, ...extra });
const autoNote = (body: string) => '# Handoff note (auto, no LLM)\n' + body + '\n';
const ctxOf = (r: any) => (r.additionalContext || []).join('\n');
const clearTranscript = () => prompt('wrap up and clear') + asst([{ type: 'tool_use', id: 'c1', name: 'mcp__ccd_session_mgmt__clear_session', input: { session_id: 'self' } }]) + result('c1');

test('repro 1: Stop -> startup restores once -> the first prompt of the new session injects nothing again', async ($, on) => {
  const files: Files = { '/t/S1.jsonl': clearTranscript(), [sessionFileName(DIR, 'S1', true)]: '# note by Claude\nship the mod\n' };
  world(on, files, { host: HOST });
  on('classic.Stop', () => ({}));
  on('classic.SessionStart', () => ({}));
  on('classic.UserPromptSubmit', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  const r1: any = await $.classic.SessionStart({ source: 'startup', session_id: 'S2', cwd: '/w', transcript_path: '/t/S2.jsonl' } as any);
  expect(ctxOf(r1)).toContain('ship the mod');
  const r2: any = await $.classic.UserPromptSubmit({ session_id: 'S2', cwd: '/w', prompt: 'hi' } as any);
  expect(ctxOf(r2)).not.toContain('ship the mod');
  expect(evOf(files, 'handoff_restore').length).toBe(1);
});

test('repro 2: startup before the marker exists -> the first prompt restores, the second prompt is silent', async ($, on) => {
  const files: Files = { '/t/S1.jsonl': clearTranscript(), [sessionFileName(DIR, 'S1', true)]: '# note by Claude\nship the mod\n' };
  world(on, files, { host: HOST });
  on('classic.Stop', () => ({}));
  on('classic.SessionStart', () => ({}));
  on('classic.UserPromptSubmit', () => ({}));
  const r0: any = await $.classic.SessionStart({ source: 'startup', session_id: 'S2', cwd: '/w', transcript_path: '/t/S2.jsonl' } as any);
  expect(ctxOf(r0)).not.toContain('ship the mod');
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  const p1: any = await $.classic.UserPromptSubmit({ session_id: 'S2', cwd: '/w', prompt: 'hi' } as any);
  expect(ctxOf(p1)).toContain('ship the mod');
  const p2: any = await $.classic.UserPromptSubmit({ session_id: 'S2', cwd: '/w', prompt: 'again' } as any);
  expect(ctxOf(p2)).not.toContain('ship the mod');
});

test('repro 3: the marker consume write fails -> the next prompt does not inject the note again, one handoff_restore event', async ($, on) => {
  const files: Files = {
    [pendingClearName(DIR, HOST)]: marker('OLD', 1000),
    [sessionFileName(DIR, 'OLD')]: autoNote('auto note body'),
  };
  world(on, files, { host: HOST, denyPath: /pending-clear-/ });
  on('classic.UserPromptSubmit', () => ({}));
  const p1: any = await $.classic.UserPromptSubmit({ session_id: 'NEW', cwd: '/w', prompt: 'hi' } as any);
  expect(ctxOf(p1)).toContain('auto note body');
  expect(files[pendingClearName(DIR, HOST)]).not.toBe('{}'); // the write really failed
  const p2: any = await $.classic.UserPromptSubmit({ session_id: 'NEW', cwd: '/w', prompt: 'again' } as any);
  expect(ctxOf(p2)).not.toContain('auto note body');
  expect(evOf(files, 'handoff_restore').length).toBe(1);
});

test('repro 4: a marker 61 minutes old is dropped at startup and the drop is recorded as expired', async ($, on) => {
  const files: Files = {
    [pendingClearName(DIR, HOST)]: marker('OLD', 61 * MIN),
    [sessionFileName(DIR, 'OLD')]: autoNote('auto note body'),
  };
  world(on, files, { host: HOST });
  on('classic.SessionStart', () => ({}));
  const r: any = await $.classic.SessionStart({ source: 'startup', session_id: 'S2', cwd: '/w', transcript_path: '/t/S2.jsonl' } as any);
  expect(ctxOf(r)).not.toContain('auto note body');
  const drops = evOf(files, 'handoff_drop');
  expect(drops.length).toBe(1);
  expect(drops[0].reason).toBe('expired');
  expect(drops[0].source).toBe('clear_start');
  expect(drops[0].from_session).toBe('OLD');
  expect(typeof drops[0].age_sec).toBe('number');
});

test('handoff_drop: a marker from the session itself is recorded as own', async ($, on) => {
  const f1: Files = { [pendingClearName(DIR, HOST)]: marker('S2', 1000), [sessionFileName(DIR, 'S2')]: autoNote('x') };
  world(on, f1, { host: HOST });
  on('classic.UserPromptSubmit', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'S2', cwd: '/w', prompt: 'hi' } as any);
  expect(evOf(f1, 'handoff_drop').map((x) => x.reason)).toEqual(['not_cleared']); // 0.6.13: the marker is kept, not spent as own
});

test('handoff_drop: a marker whose session left no memo is recorded as no_note', async ($, on) => {
  const f2: Files = { [pendingClearName(DIR, HOST)]: marker('NONOTE', 2000) };
  world(on, f2, { host: HOST });
  on('classic.UserPromptSubmit', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'S3', cwd: '/w', prompt: 'hi' } as any);
  expect(evOf(f2, 'handoff_drop').map((x) => x.reason)).toEqual(['no_note']);
});

test('repro 5: a Claude memo 2h older than the marker is not used; the auto memo comes back (kind auto)', async ($, on) => {
  const cf = sessionFileName(DIR, 'OLD', true);
  const files: Files = {
    [pendingClearName(DIR, HOST)]: marker('OLD', 1000),
    [cf]: '# note by Claude\nstale claude memo\n',
    [sessionFileName(DIR, 'OLD')]: autoNote('fresh auto memo'),
  };
  world(on, files, { host: HOST, ages: { [cf]: 2 * H } });
  on('classic.UserPromptSubmit', () => ({}));
  const r: any = await $.classic.UserPromptSubmit({ session_id: 'NEW', cwd: '/w', prompt: 'hi' } as any);
  expect(ctxOf(r)).toContain('fresh auto memo');
  expect(ctxOf(r)).not.toContain('stale claude memo');
  expect(evOf(files, 'handoff_restore')[0].kind).toBe('auto');
});

test('repro 6: successive clears S1 -> S2 -> S3: S3 gets the S2 memo only', async ($, on) => {
  const files: Files = {
    [pendingClearName(DIR, HOST)]: marker('S1', 20 * MIN),
    [sessionFileName(DIR, 'S1')]: autoNote('memo of S1'),
    [sessionFileName(DIR, 'S2')]: autoNote('memo of S2'),
  };
  world(on, files, { host: HOST });
  on('classic.SessionStart', () => ({}));
  const a: any = await $.classic.SessionStart({ source: 'startup', session_id: 'S2', cwd: '/w', transcript_path: '/t/S2.jsonl' } as any);
  expect(ctxOf(a)).toContain('memo of S1');
  files[pendingClearName(DIR, HOST)] = marker('S2', 10 * MIN); // S2 cleared itself 10 minutes later
  const b: any = await $.classic.SessionStart({ source: 'startup', session_id: 'S3', cwd: '/w', transcript_path: '/t/S3.jsonl' } as any);
  expect(ctxOf(b)).toContain('memo of S2');
  expect(ctxOf(b)).not.toContain('memo of S1');
});

test('handoff_restore carries tokens_at_clear (from the marker) and hinted (a hint recorded within 3h before the marker)', async ($, on) => {
  const f1: Files = {
    [pendingClearName(DIR, HOST)]: marker('OLD', 1000, { tokens: 210000 }),
    [sessionFileName(DIR, 'OLD')]: autoNote('body'),
    [TG]: JSON.stringify({ OLD: { cwd: '/w', hintAt: 160000, ts: Date.now() - 20 * MIN } }),
  };
  world(on, f1, { host: HOST });
  on('classic.UserPromptSubmit', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'N1', cwd: '/w', prompt: 'hi' } as any);
  const e1 = evOf(f1, 'handoff_restore')[0];
  expect(e1.tokens_at_clear).toBe(210000);
  expect(e1.hinted).toBe(true);
});

test('handoff_restore without a hint on record: hinted false and no tokens_at_clear for a marker that has no size', async ($, on) => {
  const f2: Files = { [pendingClearName(DIR, HOST)]: marker('OLD', 1000), [sessionFileName(DIR, 'OLD')]: autoNote('body') };
  world(on, f2, { host: HOST });
  on('classic.UserPromptSubmit', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'N2', cwd: '/w', prompt: 'hi' } as any);
  const e2 = evOf(f2, 'handoff_restore')[0];
  expect(e2.hinted).toBe(false);
  expect('tokens_at_clear' in e2).toBe(false);
});

test('Stop writes the context size into the clear marker (tokens)', async ($, on) => {
  const files: Files = { '/t/S1.jsonl': clearTranscript() };
  world(on, files, { host: HOST, usage: { startedAt: 0, context: { tokens: 123456, window: 1000000 }, rateLimits: [] } });
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  expect(JSON.parse(files[pendingClearName(DIR, HOST)]!).tokens).toBe(123456);
});

const redUsage66 = () => {
  const resets = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
  return { startedAt: 0, context: { tokens: 1000, window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 97, resetsAt: resets }, { kind: 'five_hour', percentUsed: 97, resetsAt: resets }] };
};

test('nudge machine-wide stamp: a second session starting at the same red stays silent; _global is saved', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ nudge: true }) };
  world(on, files, { usage: redUsage66() });
  on('classic.SessionStart', () => ({}));
  await $.classic.SessionStart({ source: 'startup', session_id: 'A', cwd: '/w', transcript_path: '/t/A.jsonl' } as any);
  await $.classic.SessionStart({ source: 'startup', session_id: 'B', cwd: '/w', transcript_path: '/t/B.jsonl' } as any);
  expect(evOf(files, 'nudge').map((x) => x.session)).toEqual(['A']);
  const book = JSON.parse(files[HOME + '/nudge.json']!);
  expect(book._global.grade).toBe('red');
  expect(typeof book._global.ts).toBe('number');
});

test('nudge book: the _global stamp survives the 50-session trim and is not counted in it', async ($, on) => {
  const old: Record<string, unknown> = { _global: { grade: 'yellow', ts: 1 } };
  for (let i = 0; i < 60; i++) old['s' + i] = { grade: 'green', ts: 1000 + i };
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ nudge: true }), [HOME + '/nudge.json']: JSON.stringify(old) };
  world(on, files, { usage: redUsage66() });
  on('classic.SessionStart', () => ({}));
  await $.classic.SessionStart({ source: 'startup', session_id: 'NEWEST', cwd: '/w', transcript_path: '/t/N.jsonl' } as any);
  const book = JSON.parse(files[HOME + '/nudge.json']!);
  expect(book._global.grade).toBe('red');
  expect(Object.keys(book).filter((k) => !k.startsWith('_')).length).toBe(50);
  expect(book.NEWEST).toBeDefined();
});

test('line_tokens: the nudge event carries the size of the injected line', async ($, on) => {
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ nudge: true }) };
  world(on, files, { usage: redUsage66() });
  on('classic.SessionStart', () => ({}));
  await $.classic.SessionStart({ source: 'startup', session_id: 'A', cwd: '/w', transcript_path: '/t/A.jsonl' } as any);
  const n = evOf(files, 'nudge')[0];
  expect(typeof n.line_tokens).toBe('number');
  expect(n.line_tokens).toBeGreaterThan(10);
});

test('line_tokens: topic_gate and inline_hint events (first hint is the full line)', async ($, on) => {
  const files: Files = {
    [SIDE]: JSON.stringify({ commits: [], files: [], stopAt: Date.now() - 2 * H }),
    [TG]: JSON.stringify({ S1: { cwd: '/w', promptAt: Date.now() - 3 * H, ts: Date.now() - 3 * H } }),
  };
  world(on, files, { messages: [{ role: 'assistant', content: [] }], usage: bigUsage });
  on('classic.UserPromptSubmit', () => ({}));
  const r: any = await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'next', transcript_path: '/t/big.jsonl' } as any);
  const g = evOf(files, 'topic_gate')[0];
  const h = evOf(files, 'inline_hint')[0];
  expect(typeof g.line_tokens).toBe('number');
  expect(typeof h.line_tokens).toBe('number');
  expect(ctxOf(r)).toContain('clear_session'); // first hint: the full instructions
});

test('inline hint after the first one is the short line without the full instructions', async ($, on) => {
  const usage = { startedAt: 0, context: { tokens: 270000, window: 1000000 }, rateLimits: [] };
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ topicGate: false, topicCheck: false }), [TG]: JSON.stringify({ S1: { cwd: '/w', hintAt: 150000, ts: Date.now() } }) };
  world(on, files, { usage, host: HOST });
  on('classic.UserPromptSubmit', () => ({}));
  const r: any = await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'next', transcript_path: '/t/S1.jsonl' } as any);
  const ev = evOf(files, 'inline_hint')[0];
  expect(ev).toBeDefined();
  expect(ctxOf(r)).not.toContain('Good time to /compact'); // the full instructions went out with the first hint
  expect(ev.line_tokens).toBeLessThanOrEqual(90);
});

test('line_tokens: the topic_check event', async ($, on) => {
  const usage = { startedAt: 0, context: { tokens: 215000, window: 1000000 }, rateLimits: [] };
  const files: Files = { [TG]: JSON.stringify({ S1: { cwd: '/w', hintAt: 190000, ts: Date.now() } }) };
  world(on, files, { usage });
  on('classic.UserPromptSubmit', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'next', transcript_path: '/t/S1.jsonl' } as any);
  const t = evOf(files, 'topic_check')[0];
  expect(typeof t.line_tokens).toBe('number');
  expect(t.line_tokens).toBeGreaterThan(0);
});

// ---- 0.6.7: repeat hints, pace_sample, transcript line, /ts-recall, the Clear button ----

const hintRun = async ($: any, on: any, tokens: number, rec: Record<string, unknown> | null, cfg: Record<string, unknown>) => {
  const usage = { startedAt: 0, context: { tokens, window: 1000000 }, rateLimits: [] };
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ topicGate: false, topicCheck: false, ...cfg }) };
  if (rec) files[TG] = JSON.stringify({ S1: { cwd: '/w', ts: Date.now(), ...rec } });
  world(on, files, { usage });
  on('classic.UserPromptSubmit', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'next', transcript_path: '/t/S1.jsonl' } as any);
  return { files, hints: evOf(files, 'inline_hint'), book: JSON.parse(files[TG] || '{}').S1 };
};

test('0.6.7 repeat hints: a 1M window needs 100k of growth since the last hint (too early: none)', async ($, on) => {
  const near = await hintRun($, on, 240000, { hintAt: 160000, hintCount: 1 }, { compactWindowTokens: 1000000 });
  expect(near.hints.length).toBe(0);
});

test('0.6.7 repeat hints: after 100k of growth the repeat comes and the counter is stored', async ($, on) => {
  const far = await hintRun($, on, 265000, { hintAt: 160000, hintCount: 1 }, { compactWindowTokens: 1000000 });
  expect(far.hints.length).toBe(1);
  expect(far.book.hintCount).toBe(2);
  expect(far.book.hintAt).toBe(265000);
});

test('0.6.7 repeat hints: at most 5 per context', async ($, on) => {
  const capped = await hintRun($, on, 900000, { hintAt: 700000, hintCount: 5 }, { compactWindowTokens: 1000000 });
  expect(capped.hints.length).toBe(0);
});

test('0.6.7 repeat hints: after a drop the counter starts over with a first hint', async ($, on) => {
  const reset = await hintRun($, on, 170000, { hintAt: 700000, hintCount: 5 }, { compactWindowTokens: 1000000 });
  expect(reset.hints.length).toBe(1);
  expect(reset.book.hintCount).toBe(1);
});

test('0.6.7 pace_sample: one event per hour, numbers and the grade only', async ($, on) => {
  const resets = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
  const usage = { startedAt: 0, context: { tokens: 1000, window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 60, resetsAt: resets }, { kind: 'five_hour', percentUsed: 30, resetsAt: resets }] };
  const files: Files = {};
  world(on, files, { usage });
  on('classic.UserPromptSubmit', () => ({}));
  await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'a', transcript_path: '/t/S1.jsonl' } as any);
  await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'b', transcript_path: '/t/S1.jsonl' } as any);
  const ps = evOf(files, 'pace_sample');
  expect(ps.length).toBe(1);
  expect(Object.keys(ps[0]).filter((k) => !['v', 'ts', 'event', 'session'].includes(k)).sort().join(',')).toBe('five_h_pct,five_h_reset_at,grade,week_pct,week_reset_at');
  expect(ps[0].week_pct).toBe(60);
  expect(typeof ps[0].week_reset_at).toBe('number');
  expect(typeof ps[0].grade).toBe('string');
  // an hour later a second one is allowed
  files[HOME + '/pace-sample.json'] = JSON.stringify({ ts: Date.now() - 61 * MIN });
  await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'c', transcript_path: '/t/S1.jsonl' } as any);
  expect(evOf(files, 'pace_sample').length).toBe(2);
});

test('0.6.7 the handoff note carries the transcript line (home shortened to ~)', async ($, on) => {
  const files: Files = { '/h/.claude/projects/p/S1.jsonl': prompt('hello') + asst([{ type: 'text', text: 'hi' }]) };
  world(on, files);
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/h/.claude/projects/p/S1.jsonl' } as any);
  expect(files[sessionFileName(DIR, 'S1')] || '').toContain('- transcript: ~/.claude/projects/p/S1.jsonl');
  expect(files[latestFileName(DIR, '/w')] || '').toContain('- transcript: ~/.claude/projects/p/S1.jsonl');
});

test('0.6.7 the handoff note has no transcript line when the Stop event has no path', async ($, on) => {
  const files: Files = {};
  world(on, files);
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S2', cwd: '/w' } as any);
  expect(files[sessionFileName(DIR, 'S2')] || '').not.toContain('transcript:');
});

// -- /ts-recall and the "previous chat" button --

const PREV = '/h/.claude/projects/p/OLD.jsonl';
const chatLog = (n: number) => Array.from({ length: n }, (_, i) => prompt(`question ${i} about ${i % 2 ? 'parser' : 'lexer'}`) + asst([{ type: 'text', text: `answer ${i}` }, { type: 'tool_use', id: 't' + i, name: 'Bash', input: {} }]) + result('t' + i)).join('');
const recallWorld = (on: any, files: Files, sizes?: Record<string, number>) => {
  world(on, files, { sizes });
  const logged: string[] = [];
  on('ui.log', (_: any, e: any) => { logged.push(String(e.text)); return { value: undefined }; });
  const appended: any[] = [];
  on('session.append', (_: any, e: any) => { appended.push(e); return { value: undefined }; });
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }));
  on('command.register', () => ({ value: { command: 'x' } }));
  on('tool.register', () => ({ value: undefined }));
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }));
  on('command.run', { command: 'ts-recall' }, () => ({}));
  engineBand(on);
  return { logged, appended };
};
const recFile = (from = 'OLD', transcript: string | null = PREV, ageMs = 1000, extra: object = {}) => JSON.stringify({ from, ...(transcript ? { transcript } : {}), at: Date.now() - ageMs, ...extra });

test('/ts-recall shows the last 6 turns of the previous chat on screen only (no tool text)', async ($, on) => {
  const files: Files = { [PREV]: chatLog(9), [HOME + '/recall.json']: recFile() };
  const { logged, appended } = recallWorld(on, files);
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  await $.command.run({ command: 'ts-recall' } as any);
  const shown = logged.join('\n');
  expect(shown).toContain('last 6 turns');
  expect(shown).toContain('> question 8 about lexer');
  expect(shown).toContain('answer 8');
  expect(shown).not.toContain('question 2 about');
  expect(shown).not.toContain('Bash');
  expect(appended.length).toBe(0); // nothing was added to the conversation
});

test('/ts-recall with words searches the previous chat', async ($, on) => {
  const files: Files = { [PREV]: chatLog(9), [HOME + '/recall.json']: recFile() };
  const { logged } = recallWorld(on, files);
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  await $.command.run({ command: 'ts-recall', args: 'parser' } as any);
  const hits = logged.join('\n');
  expect(hits).toContain('4 match');
  expect(hits).toContain('question 7 about parser');
  expect(hits).not.toContain('about lexer');
});

test('/ts-recall: a search shows at most 10 matches', async ($, on) => {
  const files: Files = { [PREV]: chatLog(30), [HOME + '/recall.json']: recFile() };
  const { logged } = recallWorld(on, files);
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  await $.command.run({ command: 'ts-recall', args: 'question' } as any);
  expect(logged.filter((l) => l.startsWith('> ')).length).toBe(10);
});

test('/ts-recall: a search with no hit is one line', async ($, on) => {
  const files: Files = { [PREV]: chatLog(5), [HOME + '/recall.json']: recFile() };
  const { logged } = recallWorld(on, files);
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  await $.command.run({ command: 'ts-recall', args: 'zzzz' } as any);
  expect(logged.length).toBe(1);
  expect(logged[0]).toContain('no turn');
});

test('/ts-recall with no previous session prints one line', async ($, on) => {
  const w = recallWorld(on, {});
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  await $.command.run({ command: 'ts-recall' } as any);
  expect(w.logged.length).toBe(1);
  expect(w.logged[0]).toContain('no just-cleared');
});

test('/ts-recall reads a transcript over 4 MiB through the streaming helper (node, --chat, only its end)', async ($, on) => {
  const files: Files = { [PREV]: chatLog(2), [HOME + '/recall.json']: recFile() };
  const { logged } = recallWorld(on, files, { [PREV]: 6 * 1024 * 1024 });
  const runs: string[][] = [];
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv);
    const rows = [{ type: 'user', message: { role: 'user', content: 'huge session question' } }, { type: 'assistant', message: { role: 'assistant', content: 'huge session answer' } }];
    return { value: { exitCode: 0, stdout: rows.map((r) => JSON.stringify(r)).join('\n') + '\n', stderr: '', isStdoutTruncated: false } };
  });
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  await $.command.run({ command: 'ts-recall' } as any);
  expect(runs.length).toBe(1);
  expect(runs[0]!.join(' ')).toContain('--chat');
  expect(runs[0]!.join(' ')).toContain('--tail');
  expect(logged.join('\n')).toContain('huge session answer');
});

const recallButtonOnce = async ($: any, on: any, surface: 'terminal' | 'desktop') => {
  const files: Files = { [PREV]: chatLog(3), [HOME + '/recall.json']: recFile() };
  const { logged, appended } = recallWorld(on, files);
  const asked = person(on, 'Close');
  await $.session.start({ cwd: '/w', surface, isInteractive: true } as any);
  const ui = await $.ui.mount({ ...BAND, surface });
  expect(await ui.find({ type: 'Button', key: 'recall' })).toBeTruthy();
  await ui.press({ key: 'recall' });
  if (surface === 'terminal') {
    await until(() => logged.join('\n').includes('question 2 about lexer'));
    expect(asked.length).toBe(0);
  } else {
    // The desktop draws no $.ui.log row: the turns come in one dialog instead.
    await until(() => asked.length > 0);
    expect(asked[0]).toContain('question 2 about lexer');
    expect(logged.join('\n')).not.toContain('question 2 about lexer');
  }
  await ui.unmount();
  const again = await $.ui.mount({ ...BAND, surface });
  expect(await again.find({ type: 'Button', key: 'recall' })).toBeFalsy();
  await again.unmount();
  expect(appended.length).toBe(0);
};
test('the "Previous chat" button (terminal): one press shows the turns and it is gone; no model context', async ($, on) => recallButtonOnce($, on, 'terminal'));
test('the "Previous chat" button (desktop): one press shows the turns and it is gone; no model context', async ($, on) => recallButtonOnce($, on, 'desktop'));

test('the "Previous chat" button goes after 5 prompts', async ($, on) => {
  const files: Files = { [PREV]: chatLog(3), [HOME + '/recall.json']: recFile() };
  recallWorld(on, files);
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  const seen = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
    const found = !!(await ui.find({ type: 'Button', key: 'recall' }));
    await ui.unmount();
    return found;
  };
  expect(await seen()).toBe(true);
  for (let i = 0; i < 4; i++) await $.prompt.submit({ text: 'p' + i } as any);
  expect(await seen()).toBe(true);
  await $.prompt.submit({ text: 'p5' } as any);
  expect(await seen()).toBe(false);
});

test('no previous session: no "Previous chat" button', async ($, on) => {
  recallWorld(on, {});
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Button', key: 'recall' })).toBeFalsy();
  await ui.unmount();
});

const noRecallButton = async ($: any, on: any, rec: string) => {
  const files: Files = { [PREV]: chatLog(3), [HOME + '/recall.json']: rec };
  recallWorld(on, files);
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  expect(await ui.find({ type: 'Button', key: 'recall' })).toBeFalsy();
  await ui.unmount();
};
test('a recall record over 60 minutes old gives no button', async ($, on) => noRecallButton($, on, recFile('OLD', PREV, 61 * MIN)));
test('a recall record of this very session gives no button', async ($, on) => noRecallButton($, on, recFile('S1', PREV)));

// -- the Clear button --

const clearWorld = (on: any, files: Files, cfg: Record<string, unknown> = {}, tokens = 209000, host?: string, rateLimits: any[] = []) => {
  world(on, files, { host, usage: { startedAt: 0, context: { tokens, window: 1000000 }, rateLimits } });
  files[HOME + '/config.json'] = JSON.stringify(cfg);
  const logged: string[] = [];
  on('ui.log', (_: any, e: any) => { logged.push(String(e.text)); return { value: undefined }; });
  const appended: any[] = [];
  on('session.append', (_: any, e: any) => { appended.push(e); return { value: undefined }; });
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }));
  on('command.register', () => ({ value: { command: 'x' } }));
  on('tool.register', () => ({ value: undefined }));
  on('classic.Stop', () => ({}));
  on('clock.sleep', () => ({ value: undefined }));
  engineBand(on);
  return { logged, appended };
};

const clearLabel = async ($: any, on: any, surface: any, cfg: Record<string, unknown>) => {
  clearWorld(on, {}, cfg);
  await $.session.start({ cwd: '/w', surface, isInteractive: true } as any);
  const ui = await $.ui.mount({ ...BAND, surface });
  const b = await ui.find({ type: 'Button', key: 'clear' });
  await ui.unmount();
  return b ? ((b as any).props ? (b as any).props.label : (b as any).label) : null;
};
test('the Clear button shows the context size (terminal)', async ($, on) => {
  expect(await clearLabel($, on, 'terminal', {})).toBe('Clear (209k)');
});
test('the Clear button shows the context size (desktop, Korean, status line style)', async ($, on) => {
  expect(await clearLabel($, on, 'desktop', { lang: 'ko' })).toBe('비우기 (20.9만)');
});
test('the Clear button: none on mobile', async ($, on) => {
  expect(await clearLabel($, on, 'mobile', {})).toBe(null);
});
test('the Clear button: none when clearButton is false', async ($, on) => {
  expect(await clearLabel($, on, 'terminal', { clearButton: false })).toBe(null);
});

// -- the Compact button and the usage chip (0.6.9) --

const weekRl = (pct: number, days = 4) => [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(Date.now() + days * 86400000).toISOString() }];
const mountBand = async ($: any, on: any, surface: any, cfg: Record<string, unknown>, rl: any[] = []) => {
  const w = clearWorld(on, {}, cfg, 209000, undefined, rl);
  await $.session.start({ cwd: '/w', surface, isInteractive: true } as any);
  const ui = await $.ui.mount({ ...BAND, surface });
  return { ui, ...w };
};
const mountChip = async ($: any, on: any, surface: any, cfg: Record<string, unknown>, rl: any[] = []) => {
  const files: Files = {};
  const w = clearWorld(on, files, cfg, 209000, undefined, rl);
  const compacted: any[] = [];
  on('session.compact', (_: any, e: any) => { compacted.push(e); return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 209000, tokensAfter: 20000 }; });
  await $.session.start({ cwd: '/w', surface, isInteractive: true } as any);
  const ui = await $.ui.mount({ ...BAND, surface });
  return { ui, compacted, files, ...w };
};
const labelOf = (b: any) => (b ? (b.props ? b.props.label : b.label) : null);
const keyLabel = async (ui: any, key: string) => labelOf(await ui.find({ type: 'Button', key }));

test('Compact button: shown next to Clear on the terminal (en)', async ($, on) => {
  const m = await mountBand($, on, 'terminal', {});
  expect(await keyLabel(m.ui, 'compact')).toBe('Compact');
  expect(await keyLabel(m.ui, 'clear')).toBe('Clear (209k)');
  await m.ui.unmount();
});
test('Compact button: desktop in Korean', async ($, on) => {
  const m = await mountBand($, on, 'desktop', { lang: 'ko' });
  expect(await keyLabel(m.ui, 'compact')).toBe('압축');
  expect(await keyLabel(m.ui, 'clear')).toBe('비우기 (20.9만)');
  await m.ui.unmount();
});
test('Compact button and usage chip: none on mobile', async ($, on) => {
  const m = await mountBand($, on, 'mobile', {}, weekRl(46));
  expect(await keyLabel(m.ui, 'compact')).toBe(null);
  expect(await keyLabel(m.ui, 'usage')).toBe(null);
  await m.ui.unmount();
});

test('Compact button: none when compactButton is false (Clear stays)', async ($, on) => {
  const m = await mountBand($, on, 'terminal', { compactButton: false });
  expect(await keyLabel(m.ui, 'compact')).toBe(null);
  expect(await keyLabel(m.ui, 'clear')).toBe('Clear (209k)');
  await m.ui.unmount();
});

const pressCompact = async ($: any, on: any, files: Files, label: string | null, compactAnswer: () => any, surface: any = 'terminal', cfg: Record<string, unknown> = {}) => {
  const w = clearWorld(on, files, cfg, 209000);
  const compacted: any[] = [];
  on('session.compact', (_: any, e: any) => { compacted.push(e); return compactAnswer(); });
  const asked = person(on, label);
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: S1T } as any);
  delete files[sessionFileName(DIR, 'S1')]; // the button writes the note again
  delete files[latestFileName(DIR, '/w')];
  await $.session.start({ cwd: '/w', surface, isInteractive: true } as any);
  const ui = await $.ui.mount({ ...BAND, surface });
  await ui.press({ key: 'compact' });
  await ui.unmount();
  return { ...w, compacted, asked };
};

test('Compact button: Cancel saves the note, compacts nothing, records no event', async ($, on) => {
  const files = S1_FILES();
  const r = await pressCompact($, on, files, 'Cancel', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 209000, tokensAfter: 20000 }));
  expect(r.asked.length).toBe(1);
  expect(r.asked[0]).toContain('Compact now?');
  expect(seenQuestions[0].options.map((o: any) => o.label)).toEqual(['Compact', 'Cancel']); // the first option is the default: pressing the button means compact
  expect(r.compacted.length).toBe(0);
  expect(evOf(files, 'compact_button').length).toBe(0);
  expect(files[sessionFileName(DIR, 'S1')]).toContain('work on x');
});

test('Compact button: Korean question names the summary and puts Cancel first', async ($, on) => {
  const files = S1_FILES();
  const r = await pressCompact($, on, files, '취소', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 209000, tokensAfter: 20000 }), 'desktop', { lang: 'ko' });
  expect(r.asked[0]).toContain('지금 압축할까요? 대화가 요약으로 바뀌어요');
  expect(seenQuestions[0].options.map((o: any) => o.label)).toEqual(['압축', '취소']);
  expect(r.compacted.length).toBe(0);
});

test('Compact button: a dismissed question compacts nothing', async ($, on) => {
  const files = S1_FILES();
  const r = await pressCompact($, on, files, null, () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 209000, tokensAfter: 20000 }));
  expect(r.compacted.length).toBe(0);
  expect(evOf(files, 'compact_button').length).toBe(0);
});

test('Compact button: Compact saves the note first, calls session.compact once, records compact_button, no model context', async ($, on) => {
  const files = S1_FILES();
  const r = await pressCompact($, on, files, 'Compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 209000, tokensAfter: 20000 }));
  expect(files[sessionFileName(DIR, 'S1')]).toContain('- transcript: ~/.claude/projects/p/S1.jsonl');
  expect(files[latestFileName(DIR, '/w')]).toContain('work on x');
  expect(r.compacted.length).toBe(1);
  const ev = evOf(files, 'compact_button');
  expect(ev.length).toBe(1);
  expect(ev[0].tokens_at_compact).toBe(209000);
  expect(JSON.stringify(ev[0])).not.toContain('work on x');
  expect(r.appended.length).toBe(0);
});

test('Compact button: a skipped compact prints the reason and records nothing', async ($, on) => {
  const files = S1_FILES();
  const r = await pressCompact($, on, files, 'Compact', () => ({ skip: 'off' }));
  expect(r.compacted.length).toBe(1);
  expect(r.logged.join('\n')).toContain('compact was skipped (off)');
  expect(evOf(files, 'compact_button').length).toBe(0);
});

test('Compact button: a refused compact (a turn is running) prints one line and records nothing', async ($, on) => {
  const files = S1_FILES();
  const r = await pressCompact($, on, files, 'Compact', () => { throw new Error('a turn is running'); });
  expect(r.logged.join('\n')).toContain('cannot compact right now');
  expect(evOf(files, 'compact_button').length).toBe(0);
});

test('usage chip: label (en), press opens a dialog that says what the chip is; Close does nothing else', async ($, on) => {
  const asked = person(on, 'Close');
  const { ui, appended, compacted } = await mountChip($, on, 'terminal', {}, weekRl(46));
  expect(await keyLabel(ui, 'usage')).toMatch(/^week 46% · today \d+(\.\d)?%$/);
  await ui.press({ key: 'usage' });
  await until(() => asked.length > 0);
  await ui.unmount();
  expect(asked.length).toBe(1);
  expect(asked[0]).toMatch(/^Token Stamina usage - how much of the weekly limit is used/);
  expect(asked[0]).toMatch(/Weekly limit 46% used/);
  expect(asked[0]).toContain('resets');
  expect(asked[0]).toMatch(/Use at most \d+(\.\d)?% a day/);
  expect(seenQuestions[0].options.map((o: any) => o.label)).toEqual(['Close', 'Compact now', 'Clear now']); // Close first = the default
  expect(asked[0]).toContain('left until the reset');
  expect(asked[0]).toContain('see /ts-report'); // no model split here: a transcript scan is too slow for a press
  expect(asked[0]).not.toContain('Recent days'); // no pace_sample history: no trend line
  expect(asked[0]).not.toMatch(/\nToday /);
  expect(asked[0]).toContain('This chat is about 209k tokens');
  expect(compacted.length).toBe(0);
  expect(appended.length).toBe(0);
});

test('usage chip: "Compact now" compacts once with no second question', async ($, on) => {
  const asked = person(on, 'Compact now');
  const { ui, compacted, files } = await mountChip($, on, 'terminal', {}, weekRl(46));
  await ui.press({ key: 'usage' });
  await until(() => compacted.length > 0);
  await ui.unmount();
  expect(asked.length).toBe(1);
  expect(compacted.length).toBe(1);
  expect(evOf(files, 'compact_button').length).toBe(1);
});

test('usage chip: "Clear now" saves the note, clears once with no second question, records clear_button', async ($, on) => {
  const asked = person(on, 'Clear now');
  const cleared: any[] = [];
  on('command.run', { command: 'clear' }, (_: any, e: any) => { cleared.push(e); return {}; });
  const { ui, files } = await mountChip($, on, 'terminal', {}, weekRl(46));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: S1T } as any);
  Object.assign(files, { [S1T]: prompt('work on x') + asst([{ type: 'text', text: 'ok' }]) });
  delete files[sessionFileName(DIR, 'S1')];
  delete files[latestFileName(DIR, '/w')];
  await ui.press({ key: 'usage' });
  await until(() => cleared.length > 0);
  await ui.unmount();
  expect(asked.length).toBe(1);
  expect(asked[0]).toMatch(/^Token Stamina usage/);
  expect(cleared.length).toBe(1);
  expect(evOf(files, 'clear_button').length).toBe(1);
  expect(files[sessionFileName(DIR, 'S1')]).toContain('work on x'); // the handoff note is saved first, as for the Clear button
});

test('usage chip: today and the recent days come from pace_sample events; days without a pair are left out', async ($, on) => {
  const asked = person(on, 'Close');
  const rl = weekRl(46);
  const { ui, files } = await mountChip($, on, 'terminal', {}, rl);
  const reset = Math.floor(Date.parse(rl[0].resetsAt) / 1000);
  const mid = new Date(); mid.setHours(0, 0, 0, 0);
  const at = (hOff: number, pct: number) => JSON.stringify({ v: 5, ts: new Date(mid.getTime() + hOff * 3600000).toISOString(), event: 'pace_sample', week_pct: pct, week_reset_at: reset }) + '\n';
  files[HOME + '/events.jsonl'] = at(-50, 20) + at(-26, 30) + at(-2, 40);
  await ui.press({ key: 'usage' });
  await until(() => asked.length > 0);
  await ui.unmount();
  expect(asked[0]).toMatch(/\nToday so far: 6% used \/ today's share \d+(\.\d)?%\n/);
  expect(asked[0]).toMatch(/Recent days \(weekly limit %\): \d\d\/\d\d 10 · \d\d\/\d\d 10\n/);
  // order: summary, today, reset, trend, report pointer, chat size
  const i = (t: string) => asked[0]!.indexOf(t);
  const left = asked[0]!.search(/\d+d \d+h left until the reset/);
  expect(i('Use at most')).toBeLessThan(i('Today so far'));
  expect(i('Today so far')).toBeLessThan(left);
  expect(left).toBeLessThan(i('Recent days'));
  expect(i('Recent days')).toBeLessThan(i('see /ts-report'));
  expect(i('see /ts-report')).toBeLessThan(i('This chat is about'));
  expect(asked[0]!.split('\n').length).toBeLessThanOrEqual(15);
});

test('usage chip: Korean today and trend lines; a reading from another week is not counted', async ($, on) => {
  const asked = person(on, '닫기');
  const rl = weekRl(46);
  const { ui, files } = await mountChip($, on, 'desktop', { lang: 'ko' }, rl);
  const reset = Math.floor(Date.parse(rl[0].resetsAt) / 1000);
  const mid = new Date(); mid.setHours(0, 0, 0, 0);
  const at = (hOff: number, pct: number, r = reset) => JSON.stringify({ v: 5, ts: new Date(mid.getTime() + hOff * 3600000).toISOString(), event: 'pace_sample', week_pct: pct, week_reset_at: r }) + '\n';
  files[HOME + '/events.jsonl'] = at(-50, 20) + at(-26, 30) + at(-2, 40) + at(-1, 99, reset - 7 * 86400);
  await ui.press({ key: 'usage' });
  await until(() => asked.length > 0);
  await ui.unmount();
  expect(asked[0]).toMatch(/오늘 지금까지 6% 사용 \/ 오늘 몫 \d+(\.\d)?%/);
  expect(asked[0]).toMatch(/최근 하루별 사용\(주간 한도 %\): \d\d\/\d\d 10 · \d\d\/\d\d 10/);
});

test('usage chip: the text is coloured by the pace grade (green on pace, red when far over)', async ($, on) => {
  let m = await mountBand($, on, 'terminal', {}, weekRl(5, 3.5));
  const g: any = await m.ui.find({ type: 'Text', text: /week 5%/ });
  expect((g.props || g).color).toBe('green');
  await m.ui.unmount();
});
test('usage chip: red when the week is far ahead of the pace', async ($, on) => {
  const m = await mountBand($, on, 'terminal', {}, weekRl(95, 3.5));
  const r: any = await m.ui.find({ type: 'Text', text: /week 95%/ });
  expect((r.props || r).color).toBe('red');
  await m.ui.unmount();
});
test('usage chip: Korean label and dialog on the desktop', async ($, on) => {
  const asked = person(on, '닫기');
  const { ui } = await mountChip($, on, 'desktop', { lang: 'ko' }, weekRl(46));
  expect(await keyLabel(ui, 'usage')).toMatch(/^주간 한도 46% · 오늘 몫 \d+(\.\d)?%$/);
  await ui.press({ key: 'usage' });
  await until(() => asked.length > 0);
  await ui.unmount();
  expect(asked[0]).toContain('주간 한도를 얼마나 썼는지');
  expect(asked[0]).toContain('주간 한도 46% 사용');
  expect(asked[0]).toContain('리셋');
  expect(seenQuestions[0].options.map((o: any) => o.label)).toEqual(['닫기', '지금 압축', '지금 비우기']);
  expect(asked[0]).toMatch(/리셋까지 \d+일 \d+시간 남았어요/);
  expect(asked[0]).toContain('/ts-report 로 자세히');
  expect(asked[0]).toContain('지금 대화 크기 약 20.9만 토큰');
});

test('usage chip: the 5-hour window joins the block when it is read', async ($, on) => {
  const rl = [...weekRl(46), { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(Date.now() + 2 * 3600000).toISOString() }];
  const asked = person(on, 'Close');
  const { ui } = await mountChip($, on, 'terminal', {}, rl);
  await ui.press({ key: 'usage' });
  await until(() => asked.length > 0);
  await ui.unmount();
  expect(asked[0]).toContain('5-hour window 30%');
});

test('usage chip: a reading with no weekly window gives the no-limit chip (0.6.14)', async ($, on) => {
  const m = await mountBand($, on, 'terminal', {}, []);
  expect(await keyLabel(m.ui, 'usage')).toMatch(/^no weekly limit/);
  expect(await keyLabel(m.ui, 'compact')).toBe('Compact');
  await m.ui.unmount();
});
test('usage chip: none when usageChip is false (Compact and Clear stay)', async ($, on) => {
  const m = await mountBand($, on, 'terminal', { usageChip: false }, weekRl(46));
  expect(await keyLabel(m.ui, 'usage')).toBe(null);
  expect(await keyLabel(m.ui, 'compact')).toBe('Compact');
  expect(await keyLabel(m.ui, 'clear')).toBe('Clear (209k)');
  await m.ui.unmount();
});

test('band: redrawing the buttons writes no event; only a confirmed press does', async ($, on) => {
  const files: Files = {};
  const w = clearWorld(on, files, {}, 209000, undefined, weekRl(46));
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  for (let i = 0; i < 3; i++) {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
    expect(await keyLabel(ui, 'usage')).toBeTruthy();
    await ui.unmount();
  }
  expect(evList(files).filter((x) => x.event === 'compact_button' || x.event === 'clear_button').length).toBe(0);
  expect(w.appended.length).toBe(0);
});

const S1T = '/h/.claude/projects/p/S1.jsonl';
const pressClear = async ($: any, on: any, files: Files, surface: 'terminal' | 'desktop', label: string | null, clearAnswer: (e: any) => any, host?: string) => {
  const w = clearWorld(on, files, {}, 209000, host);
  const cleared: any[] = [];
  on('command.run', { command: 'clear' }, (_: any, e: any) => { cleared.push(e); return clearAnswer(e); });
  const asked = person(on, label);
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: S1T } as any);
  delete files[sessionFileName(DIR, 'S1')]; // the button writes the note again
  delete files[latestFileName(DIR, '/w')];
  await $.session.start({ cwd: '/w', surface, isInteractive: true } as any);
  const ui = await $.ui.mount({ ...BAND, surface });
  await ui.press({ key: 'clear' });
  await ui.unmount();
  return { ...w, cleared, asked };
};
const S1_FILES = (): Files => ({ [S1T]: prompt('work on x') + asst([{ type: 'text', text: 'ok' }]) });

test('Clear button: Cancel saves the note but clears nothing and records no event', async ($, on) => {
  const files = S1_FILES();
  const r = await pressClear($, on, files, 'terminal', 'Cancel', () => ({}));
  expect(r.asked.length).toBe(1);
  expect(r.asked[0]).toContain('The handoff note is saved. Clear now?');
  expect(seenQuestions[0].options.map((o: any) => o.label)).toEqual(['Clear', 'Cancel']); // the first option is the default: pressing the button means clear
  expect(r.cleared.length).toBe(0);
  expect(evOf(files, 'clear_button').length).toBe(0);
  expect(r.appended.length).toBe(0);
  expect(files[sessionFileName(DIR, 'S1')]).toContain('work on x');
});

test('Clear button: a dismissed question clears nothing', async ($, on) => {
  const files = S1_FILES();
  const r = await pressClear($, on, files, 'terminal', null, () => ({}));
  expect(r.cleared.length).toBe(0);
  expect(evOf(files, 'clear_button').length).toBe(0);
});

test('Clear button: Clear saves the note (with the transcript line), records clear_button and runs the built-in clear', async ($, on) => {
  const files = S1_FILES();
  const r = await pressClear($, on, files, 'desktop', 'Clear', () => ({}));
  expect(files[sessionFileName(DIR, 'S1')]).toContain('- transcript: ~/.claude/projects/p/S1.jsonl');
  expect(files[latestFileName(DIR, '/w')]).toContain('work on x');
  const ev = evOf(files, 'clear_button');
  expect(ev.length).toBe(1);
  expect(ev[0].tokens_at_clear).toBe(209000);
  expect(r.cleared.length).toBe(1);
  expect(r.cleared[0].command).toBe('clear');
  expect(r.appended.length).toBe(0); // no model context
  expect(JSON.parse(files[HOME + '/recall.json']!).from).toBe('S1');
});

test('Clear button: the same session id still answering after the clear gives one "did not run" toast', async ($, on) => {
  const files = S1_FILES();
  const toasts: string[] = [];
  on('ui.toast', (_: any, e: any) => { toasts.push(String(e && (e.text ?? e.message ?? e))); return { value: undefined }; });
  await pressClear($, on, files, 'desktop', 'Clear', () => ({}));
  expect(toasts.filter((t) => t.includes('/clear did not run')).length).toBe(1);
});

test('Clear button: a new session id after the press means no "did not run" toast', async ($, on) => {
  const files = S1_FILES();
  const toasts: string[] = [];
  let sid = 'S1';
  on('ui.toast', (_: any, e: any) => { toasts.push(String(e && (e.text ?? e.message ?? e))); return { value: undefined }; });
  await pressClear($, on, files, 'desktop', 'Clear', () => { sid = 'S2'; on('session.id', () => ({ value: sid })); return {}; });
  expect(toasts.filter((t) => t.includes('/clear did not run')).length).toBe(0);
});

test('Clear button: a refused built-in clear puts /clear in the prompt box', async ($, on) => {
  const files = S1_FILES();
  const filled: string[] = [];
  on('prompt.fill', (_: any, e: any) => { filled.push(e.text); return { isFilled: true }; });
  const r = await pressClear($, on, files, 'terminal', 'Clear', () => { throw new Error('a built-in is not runnable here'); });
  expect(filled).toEqual(['/clear']);
  expect(r.logged.join('\n')).toContain('/clear is in the prompt box');
  expect(evOf(files, 'clear_button').length).toBe(1);
});

test('Clear button: refused clear and no prompt box: one on-screen line, the note is saved', async ($, on) => {
  const files = S1_FILES();
  on('prompt.fill', () => ({ isFilled: false, reason: 'no_composer' }));
  const r = await pressClear($, on, files, 'terminal', 'Clear', () => { throw new Error('refused'); });
  expect(r.logged.join('\n')).toContain('type /clear - handoff note saved');
  expect(files[sessionFileName(DIR, 'S1')]).toContain('work on x');
});

test('savings section C counts a restore tagged clear_button (CLEAR_SOURCES)', async ($, on) => {
  // /clear restores only a note Claude wrote (the auto note is for the model to open when asked)
  const files: Files = { ...S1_FILES(), [latestFileName(DIR, '/w', true)]: '# note by Claude\nnext: ship it\n', [latestFileName(DIR, '/w', true) + '.from']: 'S1' };
  on('classic.SessionStart', () => ({}));
  await pressClear($, on, files, 'terminal', 'Clear', () => ({}));
  await $.classic.SessionStart({ source: 'clear', session_id: 'S2', cwd: '/w', transcript_path: '/t/S2.jsonl' } as any);
  const rs = evOf(files, 'handoff_restore');
  expect(rs.length).toBe(1);
  expect(rs[0].source).toBe('clear_button');
  expect(rs[0].tokens_at_clear).toBe(209000);
});

// -- after the Clear button: the auto note comes back once, even with no Claude note --

const pressThenNew = async ($: any, on: any, files: Files, host: string | undefined) => {
  on('classic.SessionStart', () => ({}));
  on('classic.UserPromptSubmit', () => ({}));
  await pressClear($, on, files, 'terminal', 'Clear', () => ({}), host);
};

test('Clear button then the new session starts: the auto note is restored once as clear_button; the prompts add nothing', async ($, on) => {
  const files = S1_FILES();
  await pressThenNew($, on, files, HOST);
  const mk = JSON.parse(files[pendingClearName(DIR, HOST)]!);
  expect(mk.button).toBe(true); expect(mk.from).toBe('S1'); expect(mk.tokens).toBe(209000); expect(typeof mk.at).toBe('number');
  const start: any = await $.classic.SessionStart({ source: 'clear', session_id: 'S2', cwd: '/w', transcript_path: '/t/S2.jsonl' } as any);
  expect(ctxOf(start)).toContain('work on x');
  const p1: any = await $.classic.UserPromptSubmit({ session_id: 'S2', cwd: '/w', prompt: 'first' } as any);
  const p2: any = await $.classic.UserPromptSubmit({ session_id: 'S2', cwd: '/w', prompt: 'second' } as any);
  expect(ctxOf(p1)).not.toContain('work on x');
  expect(ctxOf(p2)).not.toContain('work on x');
  const rs = evOf(files, 'handoff_restore');
  expect(rs.length).toBe(1);
  expect(rs[0].source).toBe('clear_button'); expect(rs[0].kind).toBe('auto'); expect(rs[0].tokens_at_clear).toBe(209000);
});

test('Clear button with SessionStart missing: the first prompt restores once, the second does not (no host id)', async ($, on) => {
  const files = S1_FILES();
  await pressThenNew($, on, files, undefined);
  const p1: any = await $.classic.UserPromptSubmit({ session_id: 'S2', cwd: '/w', prompt: 'first' } as any);
  const p2: any = await $.classic.UserPromptSubmit({ session_id: 'S2', cwd: '/w', prompt: 'second' } as any);
  expect(ctxOf(p1)).toContain('work on x');
  expect(ctxOf(p2)).not.toContain('work on x');
  const rs = evOf(files, 'handoff_restore');
  expect(rs.length).toBe(1);
  expect(rs[0].source).toBe('clear_button');
});

test('Clear button: a Claude note written in the last hour wins over the auto note (existing rule)', async ($, on) => {
  const files: Files = { ...S1_FILES(), [sessionFileName(DIR, 'S1', true)]: '# note by Claude\nnext: ship it\n' };
  await pressThenNew($, on, files, HOST);
  const p1: any = await $.classic.UserPromptSubmit({ session_id: 'S2', cwd: '/w', prompt: 'first' } as any);
  expect(ctxOf(p1)).toContain('next: ship it');
  expect(ctxOf(p1)).not.toContain('work on x');
  expect(evOf(files, 'handoff_restore')[0].kind).toBe('claude');
});

test('Clear button: an expired marker (over 60 minutes) is dropped; a plain /clear marker stays untagged', async ($, on) => {
  const files = S1_FILES();
  await pressThenNew($, on, files, HOST);
  const k = pendingClearName(DIR, HOST);
  files[k] = JSON.stringify({ ...JSON.parse(files[k]!), at: Date.now() - 61 * 60 * 1000 });
  const p1: any = await $.classic.UserPromptSubmit({ session_id: 'S2', cwd: '/w', prompt: 'first' } as any);
  expect(ctxOf(p1)).not.toContain('work on x');
  expect(evOf(files, 'handoff_restore').length).toBe(0);
});

// ---- 0.6.12: the clear_session tool.call hook leaves the marker beside the call ----

const CLEAR = 'mcp__ccd_session_mgmt__clear_session';

test('clear_session on self that went through: note and marker are written at the call, without a Stop', async ($, on) => {
  const files: Files = { '/t/S1.jsonl': prompt('clear it') + asst([{ type: 'tool_use', id: 'c1', name: CLEAR, input: { session_id: 'self' } }]) };
  world(on, files, { host: HOST });
  on('classic.SessionStart', () => ({}));
  on('tool.call', () => ({ result: {}, text: 'queued' }));
  await $.classic.SessionStart({ source: 'startup', session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  await $.tool.call({ tool: CLEAR, session_id: 'self' } as any);
  const mk = JSON.parse(files[pendingClearName(DIR, HOST)] || 'null');
  expect(mk?.from).toBe('S1');
  expect(mk?.transcript).toBe('/t/S1.jsonl');
  expect(files[sessionFileName(DIR, 'S1')]).toContain('clear it');
});

test('clear_session denied, errored or aimed at another session leaves no marker', async ($, on) => {
  const files: Files = {};
  world(on, files, { host: HOST });
  let mode = 'deny';
  on('tool.call', () => (mode === 'deny' ? { deny: 'no' } : { result: {}, text: 'boom', isError: true }));
  await $.tool.call({ tool: CLEAR, session_id: 'self' } as any);
  mode = 'error';
  await $.tool.call({ tool: CLEAR, session_id: 'self' } as any);
  mode = 'ok';
  await $.tool.call({ tool: CLEAR, session_id: 'someone_else' } as any);
  expect(files[pendingClearName(DIR, HOST)]).toBeUndefined();
});

test('a Stop after the hook marker keeps the marker the hook wrote (same from)', async ($, on) => {
  const transcript = prompt('wrap up') + asst([{ type: 'tool_use', id: 'c1', name: CLEAR, input: { session_id: 'self' } }]) + result('c1');
  const files: Files = { '/t/S1.jsonl': transcript, [pendingClearName(DIR, HOST)]: JSON.stringify({ from: 'S1', host: HOST, at: Date.now() - 1000, hook: true }) };
  world(on, files, { host: HOST });
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/t/S1.jsonl' } as any);
  expect(JSON.parse(files[pendingClearName(DIR, HOST)]!).hook).toBe(true);
});

test('fallback Stop on API rows: a request typed beside a tool_result and a Waiting on section reach the note', async ($, on) => {
  const files: Files = {};
  const messages = [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'look up 4 things', prompt: 'x' } }] },
    { role: 'user', content: [{ type: 'text', text: 'also fix the footer' }] },
  ];
  world(on, files, { messages });
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/t/big.jsonl' } as any);
  const note = files[sessionFileName(DIR, 'S1')]!;
  expect(note).toContain('also fix the footer');
  expect(note).toContain('## Waiting on');
  expect(note).toContain('agent: look up 4 things');
});

// ---- 0.6.13: restore and auto-save without any classic hook (a managed plugin sends the classic events past this one) ----
// Only prompt.context / prompt.submit / turn.complete are raised below; no classic.* event reaches the plugin.

const asSession = (on: any, files: Files, id: { v: string }, opts: object = {}) => {
  world(on, files, { host: HOST, noSid: true, sidRef: id, ...opts });
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }));
  on('prompt.submit', (_: any, e: any) => ({ text: e.text, context: e.context }));
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }));
};
const blocksText = (r: any) => JSON.stringify((r && r.blocks) || []);
const completeArgs = (extra: object = {}) => ({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', ...extra }) as any;

test('no classic hook: prompt.context restores the Clear button note into the first message, once', async ($, on) => {
  const files: Files = { [sessionFileName(DIR, 'OLD1')]: autoNote('work on x'), [pendingClearName(DIR, HOST)]: marker('OLD1', 2000, { button: true }) };
  const sid = { v: 'NEW1' };
  asSession(on, files, sid);
  const r: any = await $.prompt.context({ blocks: [] } as any);
  expect(r.blocks.map((b: any) => b.name)).toContain('tokenStaminaHandoff');
  expect(blocksText(r)).toContain('work on x');
  const again: any = await $.prompt.context({ blocks: [] } as any);
  expect(blocksText(again)).not.toContain('work on x');
  const rs = evOf(files, 'handoff_restore');
  expect(rs.length).toBe(1);
  expect(rs[0].source).toBe('clear_button');
  expect(rs[0].from_session).toBe('OLD1');
});

test('no classic hook: prompt.submit attaches the note beside the first prompt; prompt.context then adds nothing', async ($, on) => {
  const files: Files = { [sessionFileName(DIR, 'OLD2')]: autoNote('ship the parser'), [pendingClearName(DIR, HOST)]: marker('OLD2', 2000, { button: true }) };
  const sid = { v: 'NEW2' };
  asSession(on, files, sid);
  const s: any = await $.prompt.submit({ text: 'continue' } as any);
  expect((s.context || []).join('\n')).toContain('ship the parser');
  const c: any = await $.prompt.context({ blocks: [] } as any);
  expect(blocksText(c)).not.toContain('ship the parser');
  expect(evOf(files, 'handoff_restore').length).toBe(1);
});

test('classic SessionStart restored the clear note: prompt.context does not add it a second time', async ($, on) => {
  const files: Files = { [latestFileName(DIR, '/w', true)]: '# note by Claude\nnext: ship it\n', [latestFileName(DIR, '/w', true) + '.from']: 'OLD3' };
  const sid = { v: 'NEW3' };
  asSession(on, files, sid);
  on('classic.SessionStart', () => ({}));
  const start: any = await $.classic.SessionStart({ source: 'clear', session_id: 'NEW3', cwd: '/w', transcript_path: '/t/NEW3.jsonl' } as any);
  expect(ctxOf(start)).toContain('next: ship it');
  const c: any = await $.prompt.context({ blocks: [] } as any);
  expect(blocksText(c)).not.toContain('next: ship it');
  expect(evOf(files, 'handoff_restore').length).toBe(1);
});

test('no classic hook: turn.complete saves the note with the derived transcript path and the prompt times', async ($, on) => {
  const tp = '/h/.claude/projects/-w/AUTO1.jsonl'; // <config>/projects/<encoded cwd>/<session>.jsonl
  const files: Files = { [tp]: prompt('wire up the saver') + asst([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/w/a.ts' } }]) + result('e1') };
  const sid = { v: 'AUTO1' };
  asSession(on, files, sid);
  await $.turn.complete(completeArgs());
  const note = files[sessionFileName(DIR, 'AUTO1')]!;
  expect(note).toContain('wire up the saver');
  expect(note).toContain('- transcript: ~/.claude/projects/-w/AUTO1.jsonl');
  expect(note).toMatch(/lastPromptTs=\d{4}-/);
  expect(note).toContain('/w/a.ts');
  expect(files[latestFileName(DIR, '/w')]).toContain('wire up the saver');
});

test('turn.complete of a subagent writes no note; a run after classic.Stop leaves the saving to the Stop', async ($, on) => {
  const tp = '/h/.claude/projects/-w/AUTO2.jsonl';
  const files: Files = { [tp]: prompt('main work') + asst([{ type: 'text', text: 'ok' }]) };
  const sid = { v: 'AUTO2' };
  asSession(on, files, sid);
  on('classic.Stop', () => ({}));
  await $.turn.complete(completeArgs({ agentId: 'sub1' }));
  expect(files[sessionFileName(DIR, 'AUTO2')]).toBeUndefined();
  await $.classic.Stop({ session_id: 'AUTO2', cwd: '/w', transcript_path: tp } as any);
  delete files[sessionFileName(DIR, 'AUTO2')];
  await $.turn.complete(completeArgs());
  expect(files[sessionFileName(DIR, 'AUTO2')]).toBeUndefined(); // the classic Stop ran for this session: it saves
});

test('classic events absent while turns run: classic_bypassed is recorded once per session and the Clear question says so', async ($, on) => {
  const files = S1_FILES();
  const w = clearWorld(on, files, {}, 209000, HOST);
  on('prompt.submit', (_: any, e: any) => ({ text: e.text, context: e.context }));
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }));
  on('command.run', { command: 'clear' }, () => ({}));
  const asked = person(on, 'Clear');
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  await $.prompt.submit({ text: 'hello' } as any);
  await $.turn.complete(completeArgs());
  await $.turn.complete(completeArgs({ turnId: 't2' }));
  expect(evOf(files, 'classic_bypassed').length).toBe(1);
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  await ui.press({ key: 'clear' });
  await ui.unmount();
  expect(asked[0]).toContain('The handoff note is saved. Clear now?');
  expect(asked[0]).toContain('A managed plugin switches off some features');
  expect(asked[0]).not.toContain('prompt.context');
  expect(evOf(files, 'classic_bypassed').length).toBe(1);
  expect(w.appended.length).toBe(0);
});

test('a button marker is not spent by a prompt of the session that pressed it: kept, not_cleared once, restored for the next session', async ($, on) => {
  const files: Files = { [sessionFileName(DIR, 'S1')]: autoNote('keep me'), [pendingClearName(DIR, HOST)]: marker('S1', 2000, { button: true }) };
  world(on, files, { host: HOST });
  on('classic.UserPromptSubmit', () => ({}));
  const a: any = await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'still here' } as any);
  const b: any = await $.classic.UserPromptSubmit({ session_id: 'S1', cwd: '/w', prompt: 'and again' } as any);
  expect(ctxOf(a)).not.toContain('keep me');
  expect(ctxOf(b)).not.toContain('keep me');
  expect(JSON.parse(files[pendingClearName(DIR, HOST)]!).from).toBe('S1');
  expect(evOf(files, 'handoff_drop').map((x) => x.reason)).toEqual(['not_cleared']);
  const c: any = await $.classic.UserPromptSubmit({ session_id: 'S2', cwd: '/w', prompt: 'first of the new one' } as any);
  expect(ctxOf(c)).toContain('keep me');
  expect(evOf(files, 'handoff_restore').length).toBe(1);
});

test('fallback rows: injected user text is not listed as a request; started sessions are listed under Waiting on', async ($, on) => {
  const files: Files = {};
  const messages = [
    { role: 'user', content: 'build the thing' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'ss1', name: 'mcp__ccd_session__start_session', input: { title: 'worker A', prompt: 'do x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ss1', content: '{"session_id":"local_abc123","name":"worker A"}' }] },
    { role: 'user', content: '<task-notification><task-id>t9</task-id><status>completed</status></task-notification>' },
    { role: 'user', content: 'Tool loaded.' },
    { role: 'user', content: 'Another Claude session sent a message: <cross-session-message from="x">hi</cross-session-message>' },
    { role: 'user', content: '[SYSTEM NOTIFICATION - not from the user] something' },
    { role: 'user', content: 'a real follow up' },
  ];
  world(on, files, { messages });
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/t/big.jsonl' } as any);
  const note = files[sessionFileName(DIR, 'S1')]!;
  expect(note).toContain('build the thing');
  expect(note).toContain('a real follow up');
  expect(note).not.toContain('Tool loaded');
  expect(note).not.toContain('cross-session');
  expect(note).not.toContain('task-notification');
  expect(note).not.toContain('SYSTEM NOTIFICATION');
  expect(note).toContain('session local_abc123: worker A');
});

// ---- 0.6.14: follow-up to the 0.6.13 review ----

test('A1: the transcript is found by one look through projects/* when the cwd of the session moved, and under its first cwd', async ($, on) => {
  const tp = '/h/.claude/projects/-elsewhere/MOVE1.jsonl'; // the session started elsewhere; session.cwd now says /w
  const files: Files = { [tp]: prompt('moved around') + asst([{ type: 'text', text: 'ok' }]) };
  const sid = { v: 'MOVE1' };
  asSession(on, files, sid);
  await $.turn.complete(completeArgs());
  expect(files[sessionFileName(DIR, 'MOVE1')]).toContain('- transcript: ~/.claude/projects/-elsewhere/MOVE1.jsonl');
});

test('A2: prompt.submit stamps the prompt time into topic-gate.json (the format fallbackPromptTs reads)', async ($, on) => {
  const files: Files = {};
  const sid = { v: 'STAMP1' };
  asSession(on, files, sid);
  await $.prompt.submit({ text: 'first question' } as any);
  const rec = JSON.parse(files[TG]!).STAMP1;
  expect(typeof rec.promptAt).toBe('number');
  await $.prompt.submit({ text: 'second question' } as any);
  const rec2 = JSON.parse(files[TG]!).STAMP1;
  expect(rec2.promptAt).toBeGreaterThanOrEqual(rec.promptAt);
  expect(typeof rec2.prevPromptAt).toBe('number');
});

test('A3: without a classic hook prompt.submit carries the context-size hint once; the classic prompt for the same text adds none', async ($, on) => {
  const usage = { startedAt: 0, context: { tokens: 270000, window: 1000000 }, rateLimits: [] };
  const tp = '/h/.claude/projects/-w/HINT1.jsonl';
  const files: Files = { [HOME + '/config.json']: JSON.stringify({ topicGate: false, topicCheck: false }), [tp]: prompt('x') + asst([{ type: 'text', text: 'ok' }]) };
  const sid = { v: 'HINT1' };
  asSession(on, files, sid, { usage });
  on('classic.UserPromptSubmit', () => ({}));
  const s: any = await $.prompt.submit({ text: 'next step' } as any);
  expect((s.context || []).join('\n')).toContain('clear_session');
  expect(evOf(files, 'inline_hint').length).toBe(1);
  const c: any = await $.classic.UserPromptSubmit({ session_id: 'HINT1', cwd: '/w', prompt: 'next step', transcript_path: tp } as any);
  expect(ctxOf(c)).not.toContain('clear_session');
  expect(evOf(files, 'inline_hint').length).toBe(1);
});

test('A3: turn.complete writes the pace sample without a classic hook', async ($, on) => {
  const tp = '/h/.claude/projects/-w/PACE1.jsonl';
  const files: Files = { [tp]: prompt('work') + asst([{ type: 'text', text: 'ok' }]) };
  const sid = { v: 'PACE1' };
  asSession(on, files, sid, { usage: { startedAt: 0, context: { tokens: 1000, window: 200000 }, rateLimits: weekRl(30) } });
  await $.turn.complete(completeArgs());
  expect(evOf(files, 'pace_sample').length).toBe(1);
});

test('A4: proposals, dismissed and idle-reported sessions are not waited on; the rest are labelled started', async ($, on) => {
  const files: Files = {};
  const use = (id: string, input: object) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__ccd_session__start_session', input }] });
  const res = (id: string, text: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] });
  const messages = [
    { role: 'user', content: 'coordinate' },
    use('p1', { title: 'only a card', prompt: 'x', initiation: 'own_initiative' }),
    res('p1', '{"task_id":"task_p1","proposed":true}'),
    use('a1', { title: 'worker alpha', prompt: 'x' }),
    res('a1', '{"session_id":"local_alpha1","name":"worker alpha"}'),
    use('b1', { title: 'worker beta', prompt: 'x' }),
    res('b1', '{"session_id":"local_beta22","name":"worker beta"}'),
    { role: 'user', content: '<side-sessions-event>session local_alpha1 is now idle</side-sessions-event>' },
    { role: 'user', content: 'go on' },
  ];
  world(on, files, { messages });
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/t/big.jsonl' } as any);
  const note = files[sessionFileName(DIR, 'S1')]!;
  expect(note).not.toContain('only a card');
  expect(note).not.toContain('local_alpha1');
  expect(note).toContain('session local_beta22: worker beta');
  expect(note).toContain('## Sessions started');
});

test('B16: update_plan items fill the task list and advance/done calls change it; the last replies are listed', async ($, on) => {
  const files: Files = {};
  const plan = (id: string, input: object) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__ccd_turn__update_plan', input }] });
  const messages = [
    { role: 'user', content: 'plan it' },
    plan('u1', { items: [{ content: 'step one', status: 'in_progress' }, { content: 'step two', status: 'pending' }] }),
    plan('u2', { advance: true }),
    { role: 'assistant', content: [{ type: 'text', text: 'Step one is finished, moving on to step two.' }] },
  ];
  world(on, files, { messages });
  on('classic.Stop', () => ({}));
  await $.classic.Stop({ session_id: 'S1', cwd: '/w', transcript_path: '/t/big.jsonl' } as any);
  const note = files[sessionFileName(DIR, 'S1')]!;
  expect(note).toMatch(/step one/);
  expect(note).toMatch(/step two/);
  expect(note).toContain('## Last conclusions');
  expect(note).toContain('Step one is finished');
});

test('A6: turn.complete saves on the first turn, then once 5 turns have passed since the save', async ($, on) => {
  const tp = '/h/.claude/projects/-w/THR1.jsonl';
  const files: Files = { [tp]: prompt('throttle me') + asst([{ type: 'text', text: 'ok' }]) };
  const sid = { v: 'THR1' };
  asSession(on, files, sid);
  const f = sessionFileName(DIR, 'THR1');
  await $.turn.complete(completeArgs());
  expect(files[f]).toContain('throttle me');
  files[tp] += prompt('second prompt') + asst([{ type: 'text', text: 'ok' }]);
  for (let i = 2; i <= 5; i++) await $.turn.complete(completeArgs({ turnId: 't' + i }));
  expect(files[f]).not.toContain('second prompt'); // turns 2 to 5: no save
  await $.turn.complete(completeArgs({ turnId: 't6' }));
  expect(files[f]).toContain('second prompt'); // the 5th turn since the save saves
});

test('B10: no 5-hour or weekly window: the chip shows no percentage and says there is no weekly limit', async ($, on) => {
  const { ui } = await mountChip($, on, 'terminal', {}, []);
  const label = await keyLabel(ui, 'usage');
  await ui.unmount();
  expect(label).toMatch(/^no weekly limit · 209k tokens/);
  expect(label).not.toMatch(/%/);
});

test('B12: an old json tmp file is emptied; B13: /ts-report names where the events are', async ($, on) => {
  const files: Files = { [HOME + '/lang.json.123.tmp']: '{"x":1}', [HOME + '/events/s0a1.jsonl']: '{}\n', [HOME + '/events/s0b2.jsonl']: '{}\n' };
  asSession(on, files, { v: 'TMP1' }, { ages: { [HOME + '/lang.json.123.tmp']: 3 * 86400 * 1000 } });
  const r: any = await $.command.run({ command: 'ts-report' } as any);
  expect(r.text).toContain('events: events/s???.jsonl (2 files)');
  const sid = { v: 'TMP1' };
  files['/h/.claude/projects/-w/TMP1.jsonl'] = prompt('x') + asst([{ type: 'text', text: 'ok' }]);
  await $.turn.complete(completeArgs());
  expect(files[HOME + '/lang.json.123.tmp']).toBe('');
});

// ---- 0.6.15: prompt.context can be skipped too; prompt.submit is the restore path, /ts-selftest, the host-id marker fallback ----

const submitText = (r: any) => ((r && r.context) || []).join('\n');

test('0.6.15 compact: after a compaction that stood, the next prompt carries the note once (no classic hook, no prompt.context)', async ($, on) => {
  const files: Files = { [sessionFileName(DIR, 'CMP1')]: autoNote('finish the parser') };
  asSession(on, files, { v: 'CMP1' });
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 209000, tokensAfter: 20000 }));
  const first: any = await $.prompt.submit({ text: 'hello' } as any); // a plain first prompt: nothing to restore
  expect(submitText(first)).not.toContain('finish the parser');
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any);
  const s: any = await $.prompt.submit({ text: 'continue' } as any);
  expect(submitText(s)).toContain('finish the parser');
  const again: any = await $.prompt.submit({ text: 'and more' } as any);
  expect(submitText(again)).not.toContain('finish the parser');
  const rs = evOf(files, 'handoff_restore');
  expect(rs.length).toBe(1);
  expect(rs[0].source).toBe('compact');
});

test('0.6.15 compact: a vetoed compaction restores nothing', async ($, on) => {
  const files: Files = { [sessionFileName(DIR, 'CMP2')]: autoNote('keep quiet') };
  asSession(on, files, { v: 'CMP2' });
  on('session.compact', () => ({ skip: 'off' }));
  await $.prompt.submit({ text: 'hello' } as any);
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any);
  const s: any = await $.prompt.submit({ text: 'continue' } as any);
  expect(submitText(s)).not.toContain('keep quiet');
  expect(evOf(files, 'handoff_restore').length).toBe(0);
});

test('0.6.15 compact: the classic SessionStart(compact) restore made after the compaction is not repeated by prompt.submit', async ($, on) => {
  const files: Files = { [sessionFileName(DIR, 'CMP3')]: autoNote('already back') };
  asSession(on, files, { v: 'CMP3' });
  on('classic.SessionStart', () => ({}));
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }));
  await $.prompt.submit({ text: 'hello' } as any);
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any);
  const st: any = await $.classic.SessionStart({ source: 'compact', session_id: 'CMP3', cwd: '/w', transcript_path: '/t/CMP3.jsonl' } as any);
  expect(ctxOf(st)).toContain('already back');
  const s: any = await $.prompt.submit({ text: 'continue' } as any);
  expect(submitText(s)).not.toContain('already back');
  expect(evOf(files, 'handoff_restore').length).toBe(1);
});

test('0.6.15 startup: a new session with no session.end clear report gets no restore from prompt.submit', async ($, on) => {
  const files: Files = { [latestFileName(DIR, '/w')]: autoNote('older work') };
  asSession(on, files, { v: 'ST1' });
  const s: any = await $.prompt.submit({ text: 'hello' } as any);
  expect(submitText(s)).not.toContain('older work');
  expect(evOf(files, 'handoff_restore').length).toBe(0);
});

test('0.6.15 marker fallback: a session with a host id does not take the terminal button marker', async ($, on) => {
  const files: Files = { [sessionFileName(DIR, 'TERM1')]: autoNote('terminal note'), [pendingClearName(DIR, 'button')]: marker('TERM1', 2000, { button: true, host: 'button' }) };
  asSession(on, files, { v: 'DESK1' }); // asSession gives the world a host id
  const s: any = await $.prompt.submit({ text: 'hello' } as any);
  expect(submitText(s)).not.toContain('terminal note');
  expect(JSON.parse(files[pendingClearName(DIR, 'button')]!).from).toBe('TERM1'); // left in place
  expect(evOf(files, 'handoff_restore').length).toBe(0);
});

test('0.6.15 marker fallback: a terminal session (no host id) still takes the button marker', async ($, on) => {
  const files: Files = { [sessionFileName(DIR, 'TERM2')]: autoNote('terminal note two'), [pendingClearName(DIR, 'button')]: marker('TERM2', 2000, { button: true, host: 'button' }) };
  world(on, files, { noSid: true, sidRef: { v: 'TERMNEW' } });
  on('prompt.submit', (_: any, e: any) => ({ text: e.text, context: e.context }));
  const s: any = await $.prompt.submit({ text: 'hello' } as any);
  expect(submitText(s)).toContain('terminal note two');
  expect(files[pendingClearName(DIR, 'button')]).toBe('{}');
});

test('0.6.15 Clear question under a bypass says what a typed /clear brings back', async ($, on) => {
  const files = S1_FILES();
  clearWorld(on, files, {}, 209000, HOST);
  on('prompt.submit', (_: any, e: any) => ({ text: e.text, context: e.context }));
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }));
  on('command.run', { command: 'clear' }, () => ({}));
  const asked = person(on, 'Clear');
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  await $.prompt.submit({ text: 'hello' } as any);
  await $.turn.complete(completeArgs());
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' });
  await ui.press({ key: 'clear' });
  await ui.unmount();
  expect(asked[0]).toContain('Clear with this button');
  expect(asked[0]).toContain('A typed /clear may bring back the latest note of this folder');
});

test('0.6.15 /ts-selftest: counts, the bypass verdict, PASS on the canary restore, and the scratch files are emptied', async ($, on) => {
  const files: Files = {};
  asSession(on, files, { v: 'SELF1' }, { env: { TEMP: '/tmp/x' } });
  await $.prompt.submit({ text: 'hello' } as any);
  await $.turn.complete(completeArgs());
  const r: any = await $.command.run({ command: 'ts-selftest' } as any);
  expect(r.text).toMatch(/prompt\.submit\s+1/);
  expect(r.text).toMatch(/turn\.complete\s+1/);
  expect(r.text).toMatch(/classic\.SessionStart\s+0/);
  expect(r.text).toContain('bypass: yes');
  expect(r.text.split('\n').pop()).toBe('PASS');
  const scratch = Object.keys(files).filter((p) => p.startsWith('/tmp/x/ts-selftest-'));
  expect(scratch.length).toBeGreaterThan(0);
  for (const p of scratch) expect(files[p]).toBe('');
  expect(Object.keys(files).filter((p) => p.startsWith(HOME) && /SELFOLD|SELFNEW/.test(p)).length).toBe(0); // nothing of the canary in the real data folder
});

test('0.6.15 /ts-selftest: with no temp folder it uses selftest/ under the data folder and leaves it empty', async ($, on) => {
  const files: Files = {};
  asSession(on, files, { v: 'SELF2' });
  const r: any = await $.command.run({ command: 'ts-selftest' } as any);
  expect(r.text.split('\n').pop()).toBe('PASS');
  const mine = Object.keys(files).filter((p) => p.startsWith(HOME + '/selftest/'));
  expect(mine.length).toBeGreaterThan(0);
  for (const p of mine) expect(files[p]).toBe('');
});
