'use strict';
// SessionStart (startup) hook, three jobs:
// 1. Right after install the status line is not registered, so the plugin sees no usage numbers. Ask once, through
//    Claude, whether to run setup now. Never asked again after that, yes or no.
// 2. A status line written by 0.4.5 or older names a version folder and would stay on that version after updates.
//    Ask once whether to switch it to the launcher; keep the launcher itself current.
// 3. Tell the user once per release when a newer version is published. update-check.js reads the version from
//    GitHub at most once a day, in the background; the result is compared at the next startup.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const pace = require('./pace');
const langmod = require('./lang');

const NOTICE = {
  en: 'Token Stamina: the status line is not set up yet. Say yes when Claude asks, or run /token-stamina:setup.',
  ko: 'Token Stamina: 상태줄이 아직 설정되지 않았습니다. Claude가 물으면 "예"라고 하거나 /token-stamina:setup 을 실행하세요.',
  ja: 'Token Stamina: ステータスラインがまだ設定されていません。Claude に聞かれたら「はい」と答えるか、/token-stamina:setup を実行してください。',
};
const MIGRATE = {
  en: 'Token Stamina: your status line points at one version folder and would not follow updates. Claude will offer to fix it once.',
  ko: 'Token Stamina: 상태줄이 한 버전 폴더를 가리키고 있어 업데이트를 따라가지 못합니다. Claude가 한 번 고칠지 물어봅니다.',
  ja: 'Token Stamina: ステータスラインが特定のバージョンのフォルダを指しており、更新に追従しません。Claude が一度だけ修正を提案します。',
};
const UPDATE = {
  en: (v, cur) => `Token Stamina ${v} is available (you have ${cur}). Update: claude plugin update token-stamina@token-stamina, then restart Claude Code. Or turn on auto-update in /plugin → Marketplaces.`,
  ko: (v, cur) => `Token Stamina ${v} 버전이 나왔습니다(현재 ${cur}). 업데이트: claude plugin update token-stamina@token-stamina 실행 후 Claude Code 를 다시 시작하세요. /plugin → Marketplaces 에서 자동 업데이트를 켤 수도 있습니다.`,
  ja: (v, cur) => `Token Stamina ${v} が利用可能です(現在 ${cur})。更新: claude plugin update token-stamina@token-stamina を実行し、Claude Code を再起動してください。/plugin → Marketplaces で自動更新も有効にできます。`,
};
const DAY = 24 * 3600 * 1000;

function settingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

// True when the user-level status line already runs Token Stamina: through the plugin root variable, from a path
// naming the plugin, or from any checkout whose statusline.js sits next to Token Stamina's pace.js.
function registered(settings) {
  const cmd = settings && settings.statusLine && String(settings.statusLine.command || '');
  if (!cmd || !/statusline\.js/.test(cmd)) return false;
  if (/token-stamina|CLAUDE_PLUGIN_ROOT/i.test(cmd)) return true;
  const m = /"([^"]*statusline\.js)"|'([^']*statusline\.js)'|(\S*statusline\.js)/.exec(cmd);
  const file = m && (m[1] || m[2] || m[3]);
  return !!file && fs.existsSync(path.join(path.dirname(file), 'pace.js'));
}

// True when the status line runs Token Stamina straight from a plugin cache version folder (or through the plugin
// root variable, which the status line does not expand) instead of the launcher.
function stale(settings) {
  const cmd = settings && settings.statusLine && String(settings.statusLine.command || '');
  if (!registered(settings) || /token-stamina-statusline\.js/.test(cmd)) return false;
  return /CLAUDE_PLUGIN_ROOT/.test(cmd) || /plugins[\\/]+cache[\\/]+[^"']*token-stamina/i.test(cmd);
}

// Numeric x.y.z compare; anything unparsable counts as older.
function newer(a, b) {
  const p = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')) || []).slice(1).map(Number);
  const x = p(a), y = p(b);
  if (x.length !== 3) return false;
  if (y.length !== 3) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function version(dir) {
  const j = pace.readJson(path.join(dir, '.claude-plugin', 'plugin.json'), null);
  return j && j.version ? String(j.version) : null;
}

// The newest version the background check has seen (update-check.js writes it).
function latestKnown() {
  const j = pace.readJson(require('./update-check').FILE(), null);
  return j && j.latest ? String(j.latest) : null;
}

function context(root) {
  const setup = path.join(root, 'commands', 'setup.md');
  return 'Token Stamina was just installed, but its status line is not registered, so it cannot see usage yet. ' +
    'In your next reply, after handling what the user asked, ask them once whether to run Token Stamina setup now, with the AskUserQuestion tool so they can click (two options: run setup now, not now; one short line instead if that tool is unavailable) ' +
    '(it explains each change and asks before editing any file). ' +
    `If they say yes, read ${setup} and follow its steps, using ${root} wherever it says \${CLAUDE_PLUGIN_ROOT}. ` +
    'If they say no or ignore it, drop it: this question will not come back, and they can run /token-stamina:setup any time.';
}

function migrateContext(root) {
  const script = path.join(root, 'scripts', 'setup-statusline.js');
  return 'The Token Stamina status line in ~/.claude/settings.json points at one plugin version folder, so it keeps running that version after updates. ' +
    'In your next reply, after handling what the user asked, ask them once whether to switch it to the update-proof launcher, with the AskUserQuestion tool so they can click (switch now, not now; one short line instead if that tool is unavailable). ' +
    `If yes, run \`node "${script}" --dry-run\`, show the output, and after an explicit yes (ask with AskUserQuestion again) run it without --dry-run; then tell them to restart Claude Code. ` +
    'If they say no or ignore it, drop it: this question will not come back.';
}

// Pure: what to emit for this SessionStart. kind 'setup' or 'migrate'; update is a newer version to announce.
function decide(input, settings, cfg, book, versions) {
  if (input.hook_event_name !== 'SessionStart' || (input.source && input.source !== 'startup')) return null;
  book = book || {};
  let kind = null;
  if (cfg.setupPrompt !== false && cfg.setupNudge !== false) {
    if (!registered(settings)) { if (!book.asked) kind = 'setup'; }
    else if (stale(settings) && !book.migrateAsked) kind = 'migrate';
  }
  let update = null;
  const v = versions || {};
  if (cfg.updateCheck !== false && v.latest && newer(v.latest, v.installed) && book.notified !== v.latest) update = v.latest;
  if (!kind && !update) return null;
  return { kind, update, installed: v.installed, lang: cfg.lang, auto: cfg._langAuto };
}

// Starts update-check.js detached, at most once a day, so startup never waits on the network. Read next startup.
function startCheck(cfg, book, now) {
  if (cfg.updateCheck === false) return false;
  if (book.fetched && now - Date.parse(book.fetched) < DAY) return false;
  try {
    const c = cp.spawn(process.execPath, [path.join(__dirname, 'update-check.js')], { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => {});
    c.unref();
  } catch (e) { return false; }
  return true;
}

function run(raw, now) {
  now = now || Date.now();
  const input = JSON.parse(raw);
  const cfg = langmod.withLang(pace.loadConfig(), input);
  const file = path.join(pace.home(), 'first-run.json');
  const book = pace.readJson(file, {}) || {};
  // 0.4.5-era branch builds kept the one-time question in setup-nudge.json: already asked there counts as asked here.
  const legacy = pace.readJson(path.join(pace.home(), 'setup-nudge.json'), null);
  if (legacy && legacy.shown && !book.asked) book.asked = typeof legacy.ts === 'number' ? new Date(legacy.ts).toISOString() : 'legacy';
  const root = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
  const launcher = require('./setup-statusline');
  try { if (fs.existsSync(launcher.launcherPath())) launcher.writeLauncher(root); } catch (e) { /* keep the old one */ }
  const versions = { installed: version(root), latest: latestKnown() };
  const d = decide(input, pace.readJson(settingsPath(), {}), cfg, book, versions);
  const next = Object.assign({}, book);
  if (startCheck(cfg, book, now)) next.fetched = new Date(now).toISOString();
  if (!d) { if (next.fetched !== book.fetched) pace.writeJson(file, next); return ''; }
  const stampNow = new Date(now).toISOString();
  const msgs = [];
  let ctx = null;
  if (d.kind === 'setup') { next.asked = stampNow; msgs.push(NOTICE[d.lang] || NOTICE.en); ctx = context(root); }
  if (d.kind === 'migrate') { next.migrateAsked = stampNow; msgs.push(MIGRATE[d.lang] || MIGRATE.en); ctx = migrateContext(root); }
  if (d.update) { next.notified = d.update; msgs.push((UPDATE[d.lang] || UPDATE.en)(d.update, d.installed || '?')); }
  pace.writeJson(file, next);
  pace.appendEvent({ event: 'first-run', kind: d.kind || 'update', update: d.update || undefined, session: input.session_id || 'unknown' });
  const out = { systemMessage: msgs.join('\n') };
  if (ctx) out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: pace.attributed(ctx, d.lang, d.auto) };
  return JSON.stringify(out);
}

module.exports = { registered, stale, newer, decide, run, context, migrateContext, startCheck };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try { if (!pace.skipHook(JSON.parse(raw), pace.loadConfig())) { const o = run(raw); if (o) process.stdout.write(o); } } catch (e) { /* silent */ }
    process.exit(0);
  });
}
