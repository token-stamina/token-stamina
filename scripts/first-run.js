'use strict';
// SessionStart (startup) hook: right after install the status line is not registered yet, so the plugin sees no
// usage numbers. Ask once, through Claude, whether to run setup now. Never asked again after that, yes or no.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pace = require('./pace');
const langmod = require('./lang');

const NOTICE = {
  en: 'Token Stamina: the status line is not set up yet. Say yes when Claude asks, or run /token-stamina:setup.',
  ko: 'Token Stamina: 상태줄이 아직 설정되지 않았습니다. Claude가 물으면 "예"라고 하거나 /token-stamina:setup 을 실행하세요.',
  ja: 'Token Stamina: ステータスラインがまだ設定されていません。Claude に聞かれたら「はい」と答えるか、/token-stamina:setup を実行してください。',
};

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

function context(root) {
  const setup = path.join(root, 'commands', 'setup.md');
  return 'Token Stamina was just installed, but its status line is not registered, so it cannot see usage yet. ' +
    'In your next reply, after handling what the user asked, ask them once in one short line whether to run Token Stamina setup now ' +
    '(it explains each change and asks before editing any file). ' +
    `If they say yes, read ${setup} and follow its steps, using ${root} wherever it says \${CLAUDE_PLUGIN_ROOT}. ` +
    'If they say no or ignore it, drop it: this question will not come back, and they can run /token-stamina:setup any time.';
}

// Pure: what to emit for this SessionStart, and whether to record that the question was asked.
function decide(input, settings, cfg, book) {
  if (input.hook_event_name !== 'SessionStart' || (input.source && input.source !== 'startup')) return null;
  if (cfg.setupPrompt === false || (book && book.asked) || registered(settings)) return null;
  return { lang: cfg.lang, auto: cfg._langAuto };
}

function run(raw) {
  const input = JSON.parse(raw);
  const cfg = langmod.withLang(pace.loadConfig(), input);
  const file = path.join(pace.home(), 'first-run.json');
  const d = decide(input, pace.readJson(settingsPath(), {}), cfg, pace.readJson(file, {}));
  if (!d) return '';
  pace.writeJson(file, { asked: new Date().toISOString() });
  pace.appendEvent({ event: 'first-run', session: input.session_id || 'unknown' });
  const root = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
  return JSON.stringify({
    systemMessage: NOTICE[d.lang] || NOTICE.en,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: pace.attributed(context(root), d.lang, d.auto) },
  });
}

module.exports = { registered, decide, run, context };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try { if (!pace.skipHook(JSON.parse(raw), pace.loadConfig())) { const o = run(raw); if (o) process.stdout.write(o); } } catch (e) { /* silent */ }
    process.exit(0);
  });
}
