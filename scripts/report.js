'use strict';
// Local transcript aggregation (no LLM). Streams ~/.claude/projects/**/*.jsonl.
// Usage: node report.js [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--dir <projects dir>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// Rough relative price weights per model family (output-equivalent tokens are NOT billing; for trend only).
const WEIGHT = { haiku: 1, sonnet: 3, opus: 5, fable: 5 };

function family(model) {
  const m = String(model || '').toLowerCase();
  for (const k of Object.keys(WEIGHT)) if (m.includes(k)) return k;
  return 'other';
}

function parseArgs(argv) {
  const o = { since: null, until: null, dir: path.join(os.homedir(), '.claude', 'projects') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') o.since = argv[++i];
    else if (argv[i] === '--until') o.until = argv[++i];
    else if (argv[i] === '--dir') o.dir = argv[++i];
  }
  return o;
}

function* walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

const blank = () => ({ input: 0, cache_read: 0, cache_creation: 0, output: 0, messages: 0 });
const total = (u) => u.input + u.cache_read + u.cache_creation + u.output;

async function aggregate(opts) {
  const sinceMs = opts.since ? Date.parse(opts.since + 'T00:00:00') : 0;
  const untilMs = opts.until ? Date.parse(opts.until + 'T00:00:00') + 86400000 : Infinity;
  // message.id -> {sidechain, model, usage, day}. Streaming writes the same id repeatedly; keep the max per field.
  const msgs = new Map();
  const toolCalls = new Map(); // tool_use id -> {sidechain, hasModel}
  let files = 0, lines = 0;
  for (const file of walk(opts.dir)) {
    let st;
    try { st = fs.statSync(file); } catch (e) { continue; }
    if (st.mtimeMs < sinceMs) continue;
    files++;
    const fileSub = file.split(path.sep).includes('subagents');
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.indexOf('"usage"') < 0 && line.indexOf('"tool_use"') < 0) continue;
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      if (o.type !== 'assistant' || !o.message) continue;
      const ts = Date.parse(o.timestamp);
      if (isFinite(ts) && (ts < sinceMs || ts >= untilMs)) continue;
      lines++;
      const side = !!o.isSidechain || fileSub;
      const m = o.message;
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c && c.type === 'tool_use' && (c.name === 'Agent' || c.name === 'Task') && c.id && !toolCalls.has(c.id)) {
            toolCalls.set(c.id, { sidechain: side, hasModel: !!(c.input && c.input.model) });
          }
        }
      }
      const u = m.usage;
      if (!u || !m.model || m.model === '<synthetic>') continue;
      const key = m.id || (o.uuid || String(lines));
      const cur = msgs.get(key) || { side, model: m.model, u: blank(), day: isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : null };
      cur.u.input = Math.max(cur.u.input, u.input_tokens || 0);
      cur.u.cache_read = Math.max(cur.u.cache_read, u.cache_read_input_tokens || 0);
      cur.u.cache_creation = Math.max(cur.u.cache_creation, u.cache_creation_input_tokens || 0);
      cur.u.output = Math.max(cur.u.output, u.output_tokens || 0);
      if (side) cur.side = true;
      msgs.set(key, cur);
    }
  }
  const out = { since: opts.since, until: opts.until, generated: new Date().toISOString(), files_scanned: files,
    unique_messages: msgs.size, main: {}, subagent: {}, by_day: {}, agent_calls: {}, weights: WEIGHT };
  for (const v of msgs.values()) {
    const bucket = v.side ? out.subagent : out.main;
    const t = bucket[v.model] || (bucket[v.model] = blank());
    t.input += v.u.input; t.cache_read += v.u.cache_read; t.cache_creation += v.u.cache_creation; t.output += v.u.output; t.messages++;
    if (v.day) {
      const d = out.by_day[v.day] || (out.by_day[v.day] = { tokens: 0, weighted: 0 });
      const n = total(v.u);
      d.tokens += n;
      d.weighted += n * (WEIGHT[family(v.model)] || 1);
    }
  }
  const heavy = (b, f) => { let s = 0; for (const [m, u] of Object.entries(b)) { const fam = family(m); if (fam === 'opus' || fam === 'fable') s += f(u); } return s; };
  const all = (b, f) => Object.values(b).reduce((s, u) => s + f(u), 0);
  const noCache = (u) => u.input + u.cache_creation + u.output;
  out.subagent_opus_fable_share = {
    of_total_tokens: all(out.subagent, total) ? heavy(out.subagent, total) / all(out.subagent, total) : null,
    of_noncache_tokens: all(out.subagent, noCache) ? heavy(out.subagent, noCache) / all(out.subagent, noCache) : null,
    of_output_tokens: all(out.subagent, (u) => u.output) ? heavy(out.subagent, (u) => u.output) / all(out.subagent, (u) => u.output) : null,
  };
  let withM = 0;
  for (const c of toolCalls.values()) if (c.hasModel) withM++;
  out.agent_calls = { total: toolCalls.size, with_model: withM, without_model: toolCalls.size - withM,
    unspecified_rate: toolCalls.size ? (toolCalls.size - withM) / toolCalls.size : null };
  return out;
}

module.exports = { aggregate, family, parseArgs, WEIGHT, walk };

if (require.main === module) {
  aggregate(parseArgs(process.argv.slice(2))).then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  }).catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
}
