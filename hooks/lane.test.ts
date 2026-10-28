import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
// W7 #3: one lane per feature. hooks.json command records are the lane that runs (the terminal CLI rejects a
// modules-only hooks.json); register.ts skips every feature that has a command record, so nothing fires twice.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandLane, laneOrAll, MOD_FEATURES } from './core/lane.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HJ = JSON.parse(readFileSync(join(HERE, 'hooks.json'), 'utf8'));

function commandCounts(hj: any): Map<string, number> {
  const n = new Map<string, number>();
  for (const ev of Object.keys(hj.hooks || {})) for (const g of hj.hooks[ev]) for (const h of g.hooks || []) {
    const m = /scripts\/([A-Za-z0-9_-]+\.js)/.exec(h.command || '');
    if (m) n.set(ev + ':' + m[1], (n.get(ev + ':' + m[1]) || 0) + 1);
  }
  return n;
}

test('W7 #3 lane: hooks.json is a record (not modules-only) and every command script exists', () => {
  assert.equal(typeof HJ.hooks, 'object');
  assert.ok(Object.keys(HJ.hooks).length >= 4);
  for (const f of commandLane(HJ)) assert.ok(existsSync(join(HERE, '..', 'scripts', f.split(':')[1])), f);
});

test('W7 #3 lane: each (event, feature) fires exactly once across both lanes', () => {
  const cmd = commandCounts(HJ);
  const lane = commandLane(HJ);
  const features = new Set([...MOD_FEATURES, ...cmd.keys()]);
  for (const f of features) {
    const viaCommand = cmd.get(f) || 0;
    const viaMod = MOD_FEATURES.includes(f) && !lane.has(f) ? 1 : 0;
    assert.equal(viaCommand + viaMod, 1, f);
  }
  // the sync hint (nudge.js on SessionStart) and the board run on the command lane
  for (const f of ['SessionStart:nudge.js', 'UserPromptSubmit:board.js', 'Stop:board.js', 'PreToolUse:agent-model.js']) assert.ok(lane.has(f), f);
});

test('W7 #3 lane: register.ts onAgentToolCall passes the call through untouched when the command lane owns agent-model', async () => {
  const m = await import('./register.ts');
  const e = { input: { subagent_type: 'general-purpose', description: 'x' }, session_id: 's1' };
  let got: any = null;
  const r = await m.onAgentToolCall(e, async (x: any) => { got = x; return 'next'; });
  assert.equal(r, 'next');
  assert.equal(got, e, 'same object, no model injected');
  assert.ok(!existsSync(join(process.env.TOKEN_STAMINA_HOME as string, 'events.jsonl')), 'no agent_model event from the mods lane');
});

test('W7 #3 lane: commandLane ignores non-command entries and garbage', () => {
  assert.deepEqual([...commandLane(null)], []);
  assert.deepEqual([...commandLane({ modules: ['./register.ts'] })], []);
  assert.deepEqual([...commandLane({ hooks: { Stop: [{ hooks: [{ type: 'prompt', command: 'scripts/boundary.js' }] }] } })], []);
});

test('M2 lane: hooks.json read/parse failure is fail-closed - every mods feature belongs to the command lane', () => {
  const failing = [() => { throw new Error('ENOENT'); }, () => '{not json', () => 'null', () => '[]', () => '"x"'];
  for (const rd of failing) {
    const lane = laneOrAll(rd);
    assert.deepEqual([...lane].sort(), [...MOD_FEATURES].sort());
    for (const f of MOD_FEATURES) assert.ok(lane.has(f), f); // mods lane skips all of them
  }
  // a readable hooks.json keeps the exact command-lane set
  assert.deepEqual([...laneOrAll(() => JSON.stringify(HJ))].sort(), [...commandLane(HJ)].sort());
  // register.ts uses laneOrAll (no private fail-open copy left)
  const src = readFileSync(join(import.meta.dirname, 'register.ts'), 'utf8');
  assert.ok(src.includes('laneOrAll(') && !/catch \(e\) \{\s*return new Set<string>\(\);/.test(src));
});

test('first-run.js owns the startup question: command lane has it, the mods setup-nudge is skipped, and no setup-nudge.js record remains', () => {
  const lane = commandLane(HJ);
  assert.ok(lane.has('SessionStart:first-run.js'));
  assert.ok(!lane.has('SessionStart:setup-nudge.js'));
  assert.ok(MOD_FEATURES.includes('SessionStart:first-run.js') && !MOD_FEATURES.includes('SessionStart:setup-nudge.js'));
  const src = readFileSync(join(import.meta.dirname, 'register.ts'), 'utf8');
  assert.ok(src.includes("inLane('SessionStart:first-run.js')"));
  const sess = HJ.hooks.SessionStart.find((g: any) => g.hooks.some((h: any) => /first-run\.js/.test(h.command)));
  assert.equal(sess.matcher, 'startup');
});
