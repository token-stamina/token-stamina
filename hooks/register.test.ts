// claude plugin test for the mods build (copied to hooks/register.test.ts by tools/build-mod.mjs).
// Nothing sits beneath the plugin: the test's hooks stand for the engine, with the files kept in
// memory. Each test checks one feature end to end through the real register.ts.
import { expect, mock, test } from 'claude-code/testing';
import { sessionFileName, latestFileName, pendingClearName } from './core/handoff.ts';
import { SLOTS, hash, slotName, header as evHeader } from './core/events.ts';

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

function world(on: any, files: Files, opts: { host?: string; usage?: any; messages?: any[]; onWrite?: (p: string, text: string) => boolean; ages?: Record<string, number>; denyWrite?: string; noSid?: boolean; onRead?: (p: string) => void } = {}) {
  const mtime: Record<string, number> = {};
  for (const p of Object.keys(files)) mtime[p] = Date.now() - ((opts.ages && opts.ages[p]) || 0);
  const status: (string | undefined)[] = [];
  on('fs.read', (_: any, e: any) => {
    const p = norm(e.path);
    if (opts.onRead) opts.onRead(p);
    if (/config\.default\.json$/.test(p)) return { value: JSON.stringify(DEFAULTS) };
    return p in files ? { value: files[p] } : { deny: 'ENOENT: ' + p };
  });
  on('fs.write', (_: any, e: any) => {
    if (opts.denyWrite) return { deny: opts.denyWrite };
    const p = norm(e.path);
    if (!(opts.onWrite && opts.onWrite(p, String(e.text)))) files[p] = String(e.text);
    mtime[p] = Date.now();
    return { value: undefined };
  });
  on('fs.exists', (_: any, e: any) => ({ value: norm(e.path) in files }));
  on('fs.stat', (_: any, e: any) => {
    const p = norm(e.path);
    return p in files ? { value: { kind: 'file', size: files[p]!.length, mtimeMs: mtime[p], isLink: false } } : { deny: 'ENOENT' };
  });
  // Entries of a folder, built from the files kept in memory (a child folder is a name with more path after it).
  on('fs.list', (_: any, e: any) => {
    const dir = norm(e.path).replace(/\/+$/, '');
    const seen = new Map<string, any>();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(dir + '/')) continue;
      const [first, ...more] = p.slice(dir.length + 1).split('/');
      if (more.length) seen.set(first!, { name: first, kind: 'dir', size: 0, mtimeMs: 0, isLink: false });
      else seen.set(first!, { name: first, kind: 'file', size: files[p]!.length, mtimeMs: mtime[p] ?? Date.now(), isLink: false });
    }
    return seen.size ? { value: [...seen.values()] } : { deny: 'ENOENT' };
  });
  on('session.messages', () => (opts.messages ? { value: opts.messages } : { deny: 'no messages in the test' }));
  on('session.id', () => (opts.noSid ? { deny: 'no session id in the test' } : { value: 'S1' }));
  on('session.cwd', () => ({ value: '/w' }));
  on('session.usage', () => ({ value: opts.usage || { startedAt: 0, context: { tokens: 1000, window: 200000 }, rateLimits: [] } }));
  on('ui.status', (_: any, e: any) => {
    status.push(e.text);
    return { value: undefined };
  });
  mock.env(on, { USERPROFILE: USER, TOKEN_STAMINA_HOME: HOME, ...(opts.host ? { CLAUDE_CODE_HOST_SESSION_ID: opts.host } : {}) });
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
  expect((r.additionalContext || []).join('\n')).not.toContain('parser fixed');
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

test('session.start registers fleet, savings, report and audit', async ($, on) => {
  const names: string[] = [];
  on('command.register', (_: any, e: any) => {
    names.push(e.name);
    return { value: { command: e.name } };
  });
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }));
  world(on, {});
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any);
  expect(names.sort().join(',')).toBe('ts-advisor,ts-audit,ts-fleet,ts-report,ts-savings');
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
  return JSON.parse(r.result.content[0].text);
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
  expect(r.result.isError).toBe(true);
  const out = JSON.parse(r.result.content[0].text);
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
  return { text: r.result.content[0].text, isError: r.result.isError };
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
