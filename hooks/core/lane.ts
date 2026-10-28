// Pure. Which features hooks.json already runs as command records, as "Event:script.js" strings (W7 #3: one lane per
// feature). register.ts skips every feature in this set so a runtime that runs both the command records and the mods
// module never fires the same feature twice.
export function commandLane(hooksJson: any): Set<string> {
  const out = new Set<string>();
  const hooks = hooksJson && typeof hooksJson === 'object' ? hooksJson.hooks : null;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const ev of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    for (const g of groups) {
      for (const h of g && Array.isArray(g.hooks) ? g.hooks : []) {
        if (!h || h.type !== 'command' || typeof h.command !== 'string') continue;
        const m = /scripts\/([A-Za-z0-9_-]+\.js)/.exec(h.command);
        if (m) out.add(ev + ':' + m[1]);
      }
    }
  }
  return out;
}

// Fail-closed lane for register.ts: hooks.json text -> the features the command lane owns. When the file cannot be read
// or parsed (readText throws, or the JSON is not an object), every MOD_FEATURES entry is returned, so the mods lane
// skips them all. The command records are the lane known to run; a mods lane that guesses "I do everything" when it
// cannot see hooks.json would fire each feature twice on a runtime that runs both.
export function laneOrAll(readText: () => string): Set<string> {
  let parsed: any;
  try { parsed = JSON.parse(readText()); } catch (e) { return new Set(MOD_FEATURES); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set(MOD_FEATURES);
  return commandLane(parsed);
}

// The features register.ts implements, per event (kept next to commandLane so a test can check full coverage).
export const MOD_FEATURES: string[] = [
  'SessionStart:nudge.js', 'SessionStart:handoff.js', 'SessionStart:first-run.js',
  'UserPromptSubmit:topic-gate.js', 'UserPromptSubmit:nudge.js',
  'Stop:boundary.js', 'Stop:handoff.js',
  'PreToolUse:agent-model.js',
];
