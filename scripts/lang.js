'use strict';
// Language follow-along. Order: explicit config.lang (en|ko|ja|zh) > language of the prompt just typed
// (UserPromptSubmit) > last detected language (this session, then any session) > OS locale > en.
// The OS locale is the last resort on purpose: it can disagree with the language the user actually writes.
// Screen lines (status line, systemMessage) have tables for en/ko/ja; any other language shows en there.
// Lines meant for Claude stay neutral and carry a "tell the user in <language>" directive instead (pace.attributed).
const path = require('path');
const pace = require('./pace');

const EXPLICIT = ['en', 'ko', 'ja', 'zh'];
const NAMES = { en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese' };

function stripNoise(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:[A-Za-z]:)?[\\/][\w.\-\\/]+/g, ' ')   // paths and slash commands
    .replace(/<[^>\n]{1,200}>/g, ' ');                   // pasted tags
}

// Returns 'ko' | 'ja' | 'zh' | 'en' | null (null = not enough signal: keep the previous language).
function detect(text) {
  const s = stripNoise(text);
  let hangul = 0, kana = 0, han = 0, latin = 0, words = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F)) hangul++;
    else if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF)) kana++;
    else if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF)) han++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xC0 && c <= 0x24F)) latin++;
  }
  for (const m of s.match(/[A-Za-zÀ-ɏ]{2,}/g) || []) words++;
  const cjk = hangul + kana + han;
  const letters = cjk + latin;
  if (cjk > 0) {
    if (cjk < 2 || cjk / letters < 0.12) return null;    // a quoted foreign word inside a longer text: no change
    if (hangul >= kana && hangul > 0 && hangul >= han * 0.5) return 'ko';
    if (kana > 0) return 'ja';
    if (han >= 4) return 'zh';
    return null;
  }
  return words >= 3 && latin >= 12 ? 'en' : null;
}

function osLocale() {
  try {
    const l = String(Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase().slice(0, 2);
    return EXPLICIT.includes(l) ? l : 'en';
  } catch (e) { return 'en'; }
}

function isAuto(cfg) { return !(cfg && EXPLICIT.includes(cfg.lang)); }

function stateFile() { return path.join(pace.home(), 'lang.json'); }

// Detected language for this call. input.prompt (UserPromptSubmit) updates the record; other events only read it.
function resolve(cfg, input) {
  if (!isAuto(cfg)) return cfg.lang;
  const sid = (input && input.session_id) || 'unknown';
  const book = pace.readJson(stateFile(), {}) || {};
  const sess = book.sessions || {};
  const prompt = input && typeof input.prompt === 'string' ? input.prompt : null;
  if (prompt !== null) {
    const d = detect(prompt);
    if (d) {
      if (book.last !== d || !sess[sid] || sess[sid].lang !== d) {
        sess[sid] = { lang: d, ts: Date.now() };
        const keys = Object.keys(sess);
        if (keys.length > 50) keys.sort((x, y) => sess[x].ts - sess[y].ts).slice(0, keys.length - 50).forEach((k) => delete sess[k]);
        try { pace.writeJson(stateFile(), { last: d, sessions: sess }); } catch (e) { /* read-only home: still answer */ }
      }
      return d;
    }
  }
  if (sess[sid] && EXPLICIT.includes(sess[sid].lang)) return sess[sid].lang;
  if (EXPLICIT.includes(book.last)) return book.last;
  return osLocale();
}

// Copy of cfg whose lang is the resolved one. _langAuto tells pace.attributed to add the "user's language" directive.
function withLang(cfg, input) {
  return Object.assign({}, cfg, { lang: resolve(cfg, input), _langAuto: isAuto(cfg) });
}

module.exports = { EXPLICIT, NAMES, detect, stripNoise, osLocale, isAuto, resolve, withLang };
