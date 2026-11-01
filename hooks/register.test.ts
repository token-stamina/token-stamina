// claude plugin test for the mods build (copied to hooks/register.test.ts by tools/build-mod.mjs).
// Nothing sits beneath the plugin: the test's hooks stand for the engine, with the files kept in
// memory. Each test checks one feature end to end through the real register.ts.
import { expect, mock, test } from 'claude-code/testing';
import { sessionFileName, latestFileName, pendingClearName } from './core/handoff.ts';

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

function world(on: any, files: Files, opts: { host?: string; usage?: any; messages?: any[] } = {}) {
  const mtime: Record<string, number> = {};
  for (const p of Object.keys(files)) mtime[p] = Date.now();
  const status: (string | undefined)[] = [];
  on('fs.read', (_: any, e: any) => {
    const p = norm(e.path);
    if (/config\.default\.json$/.test(p)) return { value: JSON.stringify(DEFAULTS) };
    return p in files ? { value: files[p] } : { deny: 'ENOENT: ' + p };
  });
  on('fs.write', (_: any, e: any) => {
    const p = norm(e.path);
    files[p] = String(e.text);
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
  on('session.id', () => ({ value: 'S1' }));
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
  expect(names.sort().join(',')).toBe('ts-audit,ts-fleet,ts-report,ts-savings');
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
    return String(files[HOME + '/events.jsonl'] || '');
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
  const ev = String(files[HOME + '/events.jsonl']);
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
  const ev2 = String(files2[HOME + '/events.jsonl']);
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
  expect(String(files[HOME + '/events.jsonl'])).toContain('"reason":"fleet_hard_downgrade"');
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
  return String(files[HOME + '/events.jsonl']);
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
