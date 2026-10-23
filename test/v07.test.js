'use strict';
// Language follow-along: detection, resolve order, hook output snapshots, fixed-lang regression.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pacer-v07-'));
process.env.TOKEN_STAMINA_HOME = TMP;
const L = require('../scripts/lang');
const pace = require('../scripts/pace');
const nudge = require('../scripts/nudge');
const statusline = require('../scripts/statusline');
const boundary = require('../scripts/boundary');
const setup = require('../scripts/setup-lang');
const CFG = path.join(TMP, 'config.json');
const LF = path.join(TMP, 'lang.json');
const reset = (cfg) => { for (const f of [CFG, LF]) try { fs.unlinkSync(f); } catch (e) { /* none */ } if (cfg) fs.writeFileSync(CFG, JSON.stringify(cfg)); };

test('detect: ko / ja / zh / en', () => {
  assert.strictEqual(L.detect('이 함수 왜 느린지 봐줘'), 'ko');
  assert.strictEqual(L.detect('この関数がなぜ遅いのか見てください'), 'ja');
  assert.strictEqual(L.detect('请帮我看看这个函数为什么慢'), 'zh');
  assert.strictEqual(L.detect('please look at why this function is slow'), 'en');
});

test('detect: mixed text follows the dominant script', () => {
  assert.strictEqual(L.detect('토큰 limit exceeded in the module config 확인해줘 제발'), 'ko');
  assert.strictEqual(L.detect('config の設定を確認して、トークンの上限を教えてください'), 'ja');
  assert.strictEqual(L.detect('what does 안녕 mean in this long english sentence about languages and so on'), null);
});

test('detect: code, paths, URLs, commands and empty text do not decide', () => {
  for (const x of ['', '   ', '/compact', 'ok', 'C:\\Projects\\misc\\a.js', 'https://example.com/한국어', '```js\nconst 한글 = 1;\n```', '`한국어`', '42']) assert.strictEqual(L.detect(x), null, x);
  assert.strictEqual(L.detect('```\nfoo(bar)\n``` 이거 왜 안돼'), 'ko');
});

test('resolve: explicit lang wins and never changes', () => {
  reset();
  for (const lang of ['ko', 'en', 'ja', 'zh']) assert.strictEqual(L.resolve({ lang }, { prompt: 'この関数がなぜ遅いのか見てください' }), lang);
  assert.ok(!fs.existsSync(LF));
});

test('resolve: auto follows the prompt, then the last detection, then OS locale', () => {
  reset();
  const cfg = { lang: 'auto' };
  assert.strictEqual(L.resolve(cfg, { session_id: 's1', prompt: '이 함수 왜 느린지 봐줘' }), 'ko');
  assert.strictEqual(L.resolve(cfg, { session_id: 's1' }), 'ko');
  assert.strictEqual(L.resolve(cfg, { session_id: 's1', prompt: '/compact' }), 'ko');
  assert.strictEqual(L.resolve(cfg, { session_id: 's1', prompt: 'now explain in english how this works please' }), 'en');
  assert.strictEqual(L.resolve(cfg, { session_id: 's2' }), 'en');
  reset();
  assert.strictEqual(L.resolve(cfg, { session_id: 's3' }), L.osLocale());
  assert.strictEqual(L.resolve({}, { session_id: 's3', prompt: 'この関数がなぜ遅いのか見てください' }), 'ja');
});

test('hook snapshots: nudge in ko / ja / en', () => {
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({ seven_day: { pct: 90, resets_at: now + 3 * 86400 }, recorded_at: now }));
  const run = (cfg, prompt, sid) => {
    reset(cfg);
    try { fs.unlinkSync(path.join(TMP, 'nudge.json')); } catch (e) { /* none */ }
    const o = JSON.parse(nudge.run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt })));
    return o.hookSpecificOutput.additionalContext;
  };
  const ko = run(null, '이 함수 왜 느린지 봐줘', 'a');
  assert.ok(ko.startsWith('Token Stamina: 주간') && ko.includes('Token Stamina 알림:') && !ko.includes('Write whatever'), ko);
  const ja = run(null, 'この関数がなぜ遅いのか見てください', 'b');
  assert.ok(ja.startsWith('Token Stamina: weekly usage') && ja.endsWith('Write whatever you tell the user in Japanese.'), ja);
  const en = run(null, 'please look at why this function is slow', 'c');
  assert.ok(en.startsWith('Token Stamina: weekly usage') && en.endsWith('in the language the user is writing in.'), en);
});

test('regression: lang fixed to ko behaves as before (no directive, ko text, prompt ignored)', () => {
  reset({ lang: 'ko' });
  try { fs.unlinkSync(path.join(TMP, 'nudge.json')); } catch (e) { /* none */ }
  const o = JSON.parse(nudge.run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'z', prompt: 'please answer in english now thanks a lot' })));
  const t = o.hookSpecificOutput.additionalContext;
  assert.ok(t.startsWith('Token Stamina: 주간') && t.endsWith('플러그인 제안임을 밝히세요.)'), t);
  assert.ok(!pace.attributed('x', 'ko').includes('Write whatever'));
  assert.ok(!pace.attributed('x', 'en').includes('Write whatever'));
});

test('screen tables: status line ja / ko / en, boundary ja, other languages fall back to en', () => {
  reset();
  const now = Math.floor(Date.now() / 1000);
  const state = { seven_day: { pct: 40, resets_at: now + 3 * 86400 }, recorded_at: now };
  const seg = (lang) => statusline.segment({}, state, now, Object.assign({}, pace.loadConfig(), { lang }));
  assert.ok(seg('ja').includes('今日の枠') && seg('ja').includes('リセット'), seg('ja'));
  assert.ok(seg('ko').includes('오늘 몫'));
  assert.ok(seg('en').includes('today') && seg('zh').includes('today'));
  const res = { tokens: 200000, commits: [] };
  const ja = boundary.message(res, 'ja', 'compact', {});
  assert.ok(ja.includes('/compact のしどき') && ja.includes('20万'), ja);
  assert.ok(boundary.message(res, 'zh', 'compact', {}).startsWith('Token Stamina: context is 200k'));
});

test('setup-lang: accepts auto/ja/zh, rejects others', () => {
  reset();
  for (const x of ['auto', 'ja', 'zh']) assert.ok(setup.apply({ lang: x, dryRun: true }).ok);
  assert.ok(!setup.apply({ lang: 'fr', dryRun: true }).ok);
});

test('audit.runClaude: refuses arguments with shell metacharacters', () => {
  const audit = require('../scripts/audit');
  for (const bad of ['a&calc', 'x;y', 'x y', '$(z)', 'a|b', '`z`', 'a"b', '']) assert.strictEqual(audit.runClaude(['plugin', 'details', bad], 1000), null, bad);
});
