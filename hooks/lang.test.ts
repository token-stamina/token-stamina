// Ported from test/v07.test.js's detect()/resolve() fixtures (lines 21-56). The legacy `L.resolve(cfg,
// input)` is impure -- it reads/writes lang.json under TOKEN_STAMINA_HOME itself, keyed by
// input.session_id. The ported `resolveLang(cfg, prompt, sid, book, nowMs)` takes the already-loaded
// book object and returns { lang, nextBook? } instead -- so each legacy call in the "auto follows the
// prompt, then the last detection, then OS locale" sequence is ported by manually threading the book
// returned by the previous call into the next call (falling back to the previous book when a call
// returns no nextBook, exactly mirroring "no write happened" in the legacy fs-backed version).
//
// hook-snapshot assertions in v07.test.js (nudge/statusline/boundary output in ko/ja/en) exercise
// register.ts-level orchestration (reads state.json, calls into other modules) and are not portable
// here; only the lang module's own pure detect/resolve surface is ported.

import '../test/helpers/temp-home.js'; // isolated data folder before anything reads it
import test from 'node:test';
import assert from 'node:assert';
import { detect, resolveLang, osLocale, isAuto, withLang, type LangBook } from './core/lang.ts';

test('detect: ko / ja / zh / en', () => {
  assert.equal(detect('이 함수 왜 느린지 봐줘'), 'ko');
  assert.equal(detect('この関数がなぜ遅いのか見てください'), 'ja');
  assert.equal(detect('请帮我看看这个函数为什么慢'), 'zh');
  assert.equal(detect('please look at why this function is slow'), 'en');
});

test('detect: mixed text follows the dominant script', () => {
  assert.equal(detect('토큰 limit exceeded in the module config 확인해줘 제발'), 'ko');
  assert.equal(detect('config の設定を確認して、トークンの上限を教えてください'), 'ja');
  assert.equal(detect('what does 안녕 mean in this long english sentence about languages and so on'), null);
});

test('detect: code, paths, URLs, commands and empty text do not decide', () => {
  for (const x of ['', '   ', '/compact', 'ok', 'C:\\Projects\\misc\\a.js', 'https://example.com/한국어', '```js\nconst 한글 = 1;\n```', '`한국어`', '42']) {
    assert.equal(detect(x), null, x);
  }
  assert.equal(detect('```\nfoo(bar)\n``` 이거 왜 안돼'), 'ko');
});

test('resolveLang: explicit lang wins and never changes (no nextBook)', () => {
  for (const lang of ['ko', 'en', 'ja', 'zh']) {
    const r = resolveLang({ lang }, 'この関数がなぜ遅いのか見てください', undefined, undefined, 0);
    assert.equal(r.lang, lang);
    assert.equal(r.nextBook, undefined);
  }
});

test('resolveLang: auto follows the prompt, then the last detection, then OS locale', () => {
  const cfg = { lang: 'auto' };
  let book: LangBook | undefined = {};

  const r1 = resolveLang(cfg, '이 함수 왜 느린지 봐줘', 's1', book, 0);
  assert.equal(r1.lang, 'ko');
  book = r1.nextBook || book; // a write happened: last detection changed

  const r2 = resolveLang(cfg, undefined, 's1', book, 0);
  assert.equal(r2.lang, 'ko');
  book = r2.nextBook || book; // no write: falls back to this session's last recorded language

  const r3 = resolveLang(cfg, '/compact', 's1', book, 0);
  assert.equal(r3.lang, 'ko'); // '/compact' doesn't decide a language, session record still wins
  book = r3.nextBook || book;

  const r4 = resolveLang(cfg, 'now explain in english how this works please', 's1', book, 0);
  assert.equal(r4.lang, 'en');
  book = r4.nextBook || book;

  const r5 = resolveLang(cfg, undefined, 's2', book, 0);
  assert.equal(r5.lang, 'en'); // new session, no record of its own: falls back to book.last

  // reset(): a fresh (empty) book, as if lang.json had just been deleted.
  const r6 = resolveLang(cfg, undefined, 's3', {}, 0);
  assert.equal(r6.lang, osLocale());

  const r7 = resolveLang({}, 'この関数がなぜ遅いのか見てください', 's3', {}, 0);
  assert.equal(r7.lang, 'ja'); // cfg.lang undefined is auto too, same as 'auto'
});

// Not a direct legacy port -- isAuto/withLang have no standalone legacy unit test (they're only
// exercised indirectly, wrapped inside resolve(), inside every other module's `langmod.withLang(...)`
// call sites). Tested here directly against their own one-line definitions in lang.ts.
test('isAuto/withLang: explicit lang is pinned, anything else (including absent/"auto") is auto', () => {
  assert.equal(isAuto({ lang: 'ko' }), false);
  assert.equal(isAuto({ lang: 'auto' }), true);
  assert.equal(isAuto({}), true);
  assert.equal(isAuto(undefined), true);
  const pinned = withLang({ lang: 'ko', other: 1 } as any, 'ko');
  assert.equal(pinned.lang, 'ko');
  assert.equal(pinned._langAuto, false);
  assert.equal((pinned as any).other, 1);
  const auto = withLang({ lang: 'auto' } as any, 'ja');
  assert.equal(auto.lang, 'ja');
  assert.equal(auto._langAuto, true);
});
