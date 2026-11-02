// Screen text for the advisor (design section 13). en and ko tables; ja and every other language print English
// (the command file tells Claude to speak the user's language). Every line is a template; no model is involved.
import * as pricing from './advisor-pricing.ts';

const usd = (x) => (x >= 10 ? '$' + Math.round(x) : '$' + Math.round(x * 10) / 10);
const usdInt = (x) => '$' + Math.round(x).toLocaleString('en-US');
const range = (lo, hi) => {
  const a = Math.round(lo), b = Math.round(hi);
  if (b < 1 && hi < 0.5) return '$0';
  return a === b ? '$' + b : '$' + a + '-' + b;
};
const kTok = (n) => (n >= 1e6 ? Math.round(n / 1e5) / 10 + 'M' : Math.round(n / 1e3) + 'k');
const pct = (x) => Math.round(x * 100) + '%';

const T = {
  en: {
    wk: '/wk',
    none: '(none)', dash: '-',
    header: (n, m) => `Based on the last ${n} days of this device's local records (cleanupPeriodDays = ${m}). Reads local records only, sends nothing anywhere.`,
    cols: ['#', 'item', 'current', 'recommended', 'evidence', 'expected effect (API-equiv, est.)'],
    foot: {
      pricing: (d, s) => `Prices: ${s}, cached ${d}. All money is API-list-price equivalent, an estimate.`,
      sub: 'On a subscription this is not billed; the plan limit fills in the same proportion.',
      unpriced: (u) => `unpriced: ${u.calls} calls / ${kTok(u.tokens)} tokens (${u.key}), excluded from $ totals`,
      skipped: (f, l) => `skipped: ${f} files, ${l} lines`,
    },
    insufficient: (n, d) => `Not enough records yet (${n} calls over ${d} days). The first analysis is scheduled in one week.`,
    noRecs: 'No changes recommended: nothing in the records clears the thresholds.',
    skipLine: 'Run /token-stamina:advisor any time.',
    partial: (p) => `partial: ${p.files_done} of ${p.files_total} files, newest first (the rest is read on the next run)`,
    progress: (d, n, s) => `scanned ${d}/${n} files, ~${s}s left`,
    rule: {
      R1: { item: 'Subagent default model', ev: (e) => `impl. Opus/Fable subagents ${usdInt(e.u)}${'/wk'}, no model named in ${pct(e.noModel)} of Agent calls`, eff: (lo, hi) => range(lo, hi) + '/wk' },
      R1b: { item: 'Explicit upper-tier subagents', ev: (e) => `impl./simple Opus/Fable subagents with a model named ${usdInt(e.u)}/wk (${pct(e.share)} of Agent calls name one); add '${e.marker}' to a description to keep a model`, eff: (lo, hi) => range(lo, hi) + '/wk' },
      R2: { item: 'Compact/clear hints', ev: (e) => `hints ${e.events}/wk, followed ${pct(e.followedPct)}, saved ~${usd(e.saved)}`, eff: (lo, hi, e) => (hi < 0.5 ? 'money ~$0' : range(lo, hi) + '/wk') + (e && e.fewer >= 1 ? `; ~${e.fewer} fewer hints/wk` : '; hints ignored, fewer interruptions') },
      R3: { item: 'Auto-compact point', ev: (e) => `best cap saves up to ${usdInt(e.saveHi)} before cost`, eff: (lo, hi) => range(lo, hi) + '/wk' },
      R4: { item: 'Subagents waiting >5 min', ev: (e) => `5-min cache rewrites ${usdInt(e.usd)}/wk`, eff: (lo, hi) => range(lo, hi) + '/wk if avoided' },
      R5: { item: 'Old-model sessions', ev: (e) => `old models ${usdInt(e.usd)}/wk in ${e.sessions} session${e.sessions === 1 ? "" : "s"}` + (e.unpriced ? `, plus ${e.unpriced} calls unpriced (no price row)` : ''), eff: (lo, hi) => 'up to ' + range(hi, hi) + '/wk' },
      R6: { item: 'Return after idle', ev: (e) => `idle >1h returns ${usdInt(e.usd)}/wk`, eff: (lo, hi) => 'up to ' + range(hi, hi) + '/wk' },
    },
    r1alt: ' (or haiku)',
    cur: { default: 'default', gateOn: 'gate on' },
    a: {
      title: (n) => `Usage analysis, last ${n} days (API-equivalent, estimate)`,
      total: (x) => `Total ${usdInt(x.usd)} over ${x.calls} calls: write ${usdInt(x.w)}, read ${usdInt(x.parts.read)}, output ${usdInt(x.parts.output)}, input ${usdInt(x.parts.input)}`,
      roles: (r) => `Main ${usdInt(r.main.usd)} (${r.main.calls} calls), subagents ${usdInt(r.sub.usd)} (${r.sub.calls} calls, ${r.sub.agents} agents, ${pct(r.sub.share)} of cost)`,
      fam: 'By model family',
      famRow: (k, f) => `  ${k}: ${usdInt(f.usd)} (main ${usdInt(f.main_usd)}, sub ${usdInt(f.sub_usd)}, ${f.tier})`,
      bands: 'Context size per call',
      rewrite: 'Cache writes by cause (main / subagents)',
      classes: 'Subagents by class (cost, agents, upper-tier cost, upper-tier cost with no model named)',
      old: (o) => `Old-model use: ${usdInt(o.usd)} over ${o.calls} calls in ${o.sessions} session${o.sessions === 1 ? "" : "s"}` + (o.unpriced_calls ? ` (${o.unpriced_calls} of those calls unpriced, no price row)` : ''),
      comp: (c) => `Compactions: ${c.auto} auto, ${c.manual} manual; hints ${c.hint_events}, followed ${c.hint_followed}`,
      top: 'Top sessions (opaque ids, local only)',
      topRow: (s) => `  ${s.key}: ${usdInt(s.usd)} (sub ${usdInt(s.sub_usd)}), ${s.calls} calls, max context ${kTok(s.max_ctx)}, ${Math.round(s.span_h)}h`,
      d30: (n, x) => `Last ${n} days: ${usdInt(x.usd)} over ${x.calls} calls`,
    },
    apply: {
      preview: 'Changes to make:', none: 'Nothing to change.', dry: '(dry run: nothing written)', backup: 'backup:',
      unknown: (id) => `${id}: no such recommendation in this analysis; skipped.`, info: (id) => `${id}: information only, nothing to apply.`,
      same: (id) => `${id}: already set; nothing to change.`, logged: (id) => `apply log id: ${id}`,
      invalid: 'Settings file is not valid JSON; nothing changed.',
      configInvalid: 'Config file is not valid JSON; nothing changed.', configUnreadable: 'Cannot read the config file; nothing changed.',
      logUnreadable: 'The apply log cannot be read; nothing changed.',
      logWriteFailed: (m) => `The apply log could not be written (${m}); the changes were rolled back, nothing changed.`,
      cfgRollbackFailed: (b) => `The config file could not be put back automatically; the previous text is in ${b}.`,
      needConfirm: "Changes to settings.json need the person's confirmation in an interactive session; nothing changed.",
      newFile: '(new file)', rolledBack: 'settings.json was put back to its previous text.',
      rollbackFailed: (b) => `settings.json could not be put back automatically; the previous text is in ${b}.`,
      restored: 'restored', alreadyRestored: 'already restored', changedSince: 'changed since; left alone', nothingToRevert: 'No applied change to revert.',
      reverted: (id) => `reverted ${id}`, unknownId: (id) => `No apply log entry ${id}.`, already: (id) => `${id} was already reverted.`,
      failed: 'could not be reverted; run revert again after fixing the problem', heldBack: 'left as is because the settings part of the same rule failed',
      nothingReverted: (id) => `Nothing was reverted for ${id}. The apply stays open: run revert ${id} again once the problem is fixed.`,
    },
  },
  ko: {
    wk: '/주',
    none: '(없음)', dash: '-',
    header: (n, m) => `이 PC의 로컬 기록 최근 ${n}일을 기준으로 해요 (cleanupPeriodDays = ${m}). 로컬 기록만 읽고 어디로도 보내지 않아요.`,
    cols: ['#', '항목', '현재', '권장', '근거', '예상 효과 (API 환산, 추정)'],
    foot: {
      pricing: (d, s) => `단가: ${s}, ${d} 기준. 모든 금액은 API 정가 환산 추정치예요.`,
      sub: '구독이면 실제 청구는 없고, 플랜 한도가 같은 비율로 차요.',
      unpriced: (u) => `가격 미확인: ${u.calls}건 / ${kTok(u.tokens)} 토큰 (${u.key}), $ 합계에서 뺐어요`,
      skipped: (f, l) => `건너뜀: 파일 ${f}개, 줄 ${l}개`,
    },
    insufficient: (n, d) => `아직 기록이 부족해요 (${d}일간 ${n}건). 첫 분석은 일주일 뒤로 잡혀 있어요.`,
    noRecs: '권장 변경이 없어요: 기록상 기준을 넘는 항목이 없어요.',
    skipLine: '언제든 /token-stamina:advisor 를 실행하세요.',
    partial: (p) => `일부만 읽음: 파일 ${p.files_total}개 중 ${p.files_done}개, 최신순 (나머지는 다음 실행에서 읽어요)`,
    progress: (d, n, s) => `파일 ${d}/${n}개 읽음, 약 ${s}초 남음`,
    rule: {
      R1: { item: '서브에이전트 기본 모델', ev: (e) => `구현형 Opus/Fable 서브에이전트 ${usdInt(e.u)}/주, Agent 호출의 ${pct(e.noModel)}가 모델 미지정`, eff: (lo, hi) => range(lo, hi) + '/주' },
      R1b: { item: '모델을 지정한 상위 서브에이전트', ev: (e) => `구현·단순형 Opus/Fable 서브에이전트(모델 지정) ${usdInt(e.u)}/주, Agent 호출의 ${pct(e.share)}가 모델을 지정; 설명에 '${e.marker}' 를 붙이면 그 모델을 유지`, eff: (lo, hi) => range(lo, hi) + '/주' },
      R2: { item: '압축/비우기 힌트', ev: (e) => `힌트 주 ${e.events}회, 따른 비율 ${pct(e.followedPct)}, 절약 약 ${usd(e.saved)}`, eff: (lo, hi, e) => (hi < 0.5 ? '돈 효과 거의 없음' : range(lo, hi) + '/주') + (e && e.fewer >= 1 ? `, 힌트 주 약 ${e.fewer}회 줄어듦` : ', 무시한 힌트가 줄어 방해가 적어져요') },
      R3: { item: '자동 압축 시점', ev: (e) => `가장 좋은 상한도 비용 전 최대 ${usdInt(e.saveHi)} 절약`, eff: (lo, hi) => range(lo, hi) + '/주' },
      R4: { item: '5분 넘게 대기한 서브에이전트', ev: (e) => `5분 캐시 재작성 ${usdInt(e.usd)}/주`, eff: (lo, hi) => '피하면 ' + range(lo, hi) + '/주' },
      R5: { item: '구형 모델 세션', ev: (e) => `구형 모델 ${usdInt(e.usd)}/주, 세션 ${e.sessions}개` + (e.unpriced ? `, 가격 없는 호출 ${e.unpriced}건(unpriced) 별도` : ''), eff: (lo, hi) => '최대 ' + range(hi, hi) + '/주' },
      R6: { item: '쉬었다 돌아온 세션', ev: (e) => `1시간 넘게 쉰 뒤 복귀 ${usdInt(e.usd)}/주`, eff: (lo, hi) => '최대 ' + range(hi, hi) + '/주' },
    },
    r1alt: ' (또는 haiku)',
    cur: { default: '기본값', gateOn: '게이트 켜짐' },
    a: {
      title: (n) => `사용량 분석, 최근 ${n}일 (API 환산, 추정)`,
      total: (x) => `합계 ${usdInt(x.usd)} / ${x.calls}건: 쓰기 ${usdInt(x.w)}, 읽기 ${usdInt(x.parts.read)}, 출력 ${usdInt(x.parts.output)}, 입력 ${usdInt(x.parts.input)}`,
      roles: (r) => `메인 ${usdInt(r.main.usd)} (${r.main.calls}건), 서브에이전트 ${usdInt(r.sub.usd)} (${r.sub.calls}건, ${r.sub.agents}개, 비용의 ${pct(r.sub.share)})`,
      fam: '모델 계열별',
      famRow: (k, f) => `  ${k}: ${usdInt(f.usd)} (메인 ${usdInt(f.main_usd)}, 서브 ${usdInt(f.sub_usd)}, ${f.tier})`,
      bands: '호출당 컨텍스트 크기',
      rewrite: '원인별 캐시 쓰기 (메인 / 서브에이전트)',
      classes: '서브에이전트 분류별 (비용, 개수, 상위 모델 비용, 모델 미지정 상위 모델 비용)',
      old: (o) => `구형 모델 사용: ${usdInt(o.usd)} / ${o.calls}건 / 세션 ${o.sessions}개` + (o.unpriced_calls ? ` (그중 ${o.unpriced_calls}건은 가격 없음, unpriced)` : ''),
      comp: (c) => `압축: 자동 ${c.auto}회, 수동 ${c.manual}회; 힌트 ${c.hint_events}회, 따른 것 ${c.hint_followed}회`,
      top: '상위 세션 (불투명 ID, 로컬 전용)',
      topRow: (s) => `  ${s.key}: ${usdInt(s.usd)} (서브 ${usdInt(s.sub_usd)}), ${s.calls}건, 최대 컨텍스트 ${kTok(s.max_ctx)}, ${Math.round(s.span_h)}시간`,
      d30: (n, x) => `최근 ${n}일: ${usdInt(x.usd)} / ${x.calls}건`,
    },
    apply: {
      preview: '바꿀 내용:', none: '바꿀 것이 없어요.', dry: '(미리보기: 아무것도 쓰지 않았어요)', backup: '백업:',
      unknown: (id) => `${id}: 이 분석에 없는 권장이라 건너뛰었어요.`, info: (id) => `${id}: 안내만 있고 적용할 것이 없어요.`,
      same: (id) => `${id}: 이미 같은 값이에요.`, logged: (id) => `적용 기록 id: ${id}`,
      invalid: 'Settings file is not valid JSON; nothing changed.',
      configInvalid: 'Config file is not valid JSON; nothing changed.', configUnreadable: 'Cannot read the config file; nothing changed.',
      logUnreadable: 'The apply log cannot be read; nothing changed.',
      logWriteFailed: (m) => `The apply log could not be written (${m}); the changes were rolled back, nothing changed.`,
      cfgRollbackFailed: (b) => `The config file could not be put back automatically; the previous text is in ${b}.`,
      needConfirm: "Changes to settings.json need the person's confirmation in an interactive session; nothing changed.",
      newFile: '(new file)', rolledBack: 'settings.json was put back to its previous text.',
      rollbackFailed: (b) => `settings.json could not be put back automatically; the previous text is in ${b}.`,
      restored: '되돌렸어요', alreadyRestored: '이미 되돌려져 있어요', changedSince: '그 뒤에 바뀌어서 그대로 뒀어요', nothingToRevert: '되돌릴 적용 기록이 없어요.',
      reverted: (id) => `${id} 되돌림`, unknownId: (id) => `적용 기록 ${id} 가 없어요.`, already: (id) => `${id} 는 이미 되돌렸어요.`,
      failed: '되돌리지 못했어요. 문제를 고친 뒤 revert 를 다시 실행하세요', heldBack: '같은 규칙의 settings 쪽이 실패해서 그대로 뒀어요',
      nothingReverted: (id) => `${id} 는 하나도 되돌리지 못했어요. 적용 기록은 열려 있으니 문제를 고친 뒤 revert ${id} 를 다시 실행하세요.`,
    },
  },
};
const tbl = (lang) => T[lang] || T.en;

// Display width: Hangul and CJK take two columns.
function dispW(s) {
  let w = 0;
  for (const ch of String(s)) { const c = ch.codePointAt(0); w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1; }
  return w;
}
const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - dispW(s)));
function wrap(s, w) {
  const out = [];
  let line = '';
  for (const word of String(s).split(' ')) {
    if (line && dispW(line + ' ' + word) > w) { out.push(line); line = word; } else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

// Symbols the rules pass as current/recommended; localized here.
const SYM = {
  en: { none: '(none)', dash: '-', default: 'default', gateOn: 'gate on', gap: 'gap mode', keep: 'keep', warnOnce: 'warn once', always: 'always', off: 'off' },
  ko: { none: '(없음)', dash: '-', default: '기본값', gateOn: '게이트 켜짐', gap: '간격 모드', keep: '유지', warnOnce: '한 번 경고', always: '항상', off: '꺼짐' },
};
const sym = (lang, x) => ((SYM[lang] || SYM.en)[x] !== undefined ? (SYM[lang] || SYM.en)[x] : String(x));

// Row columns of one recommendation for a language. ev = numbers object built by rules.js
// (current/recommended are plain values or SYM keys; alt = haiku alternative of R1).
function row(lang, id, ev) {
  const t = tbl(lang);
  const r = t.rule[id];
  let cur = sym(lang, ev.current), rec = sym(lang, ev.recommended);
  if (id === 'R6' && ev.current === 'gateOn') cur = cur + ', ' + ev.idleGapSec + 's';
  if (id === 'R1' && ev.alt) rec += t.r1alt;
  return { item: r.item, current: cur, recommended: rec, evidence: r.ev(ev), effect: ev.noEffect ? t.dash : r.eff(ev.lo, ev.hi, ev) };
}

function headerLine(lang, days, cleanup, partial) { return tbl(lang).header(days, cleanup) + (partial ? ' ' + tbl(lang).partial(partial) : ''); }

function footerLines(lang, win, partial) {
  const t = tbl(lang).foot;
  const lines = [t.pricing(win.pricing.date, win.pricing.source)];
  if (partial) lines.push(tbl(lang).partial(partial));
  for (const k of Object.keys(win.unpriced || {})) lines.push(t.unpriced({ key: k, calls: win.unpriced[k].calls, tokens: win.unpriced[k].tokens }));
  if (win.skipped && (win.skipped.files || win.skipped.lines)) lines.push(t.skipped(win.skipped.files, win.skipped.lines));
  lines.push(t.sub);
  return lines;
}

// recs: Recommendation[] (each has .text[lang] columns, .risk, .id). The "(B)" tag marks the high-risk class.
function table(lang, recs, whys) {
  const t = tbl(lang);
  const W = [2, 34, 16, 14, 40];
  const cols = t.cols;
  const lines = [[pad(cols[0], W[0]), pad(cols[1], W[1]), pad(cols[2], W[2]), pad(cols[3], W[3]), pad(cols[4], W[4]), cols[5]].join(' ').trimEnd()];
  recs.forEach((r, i) => {
    const c = (r.text && r.text[lang]) || r.text.en;
    const ev = wrap(c.evidence, W[4]);
    const item = c.item + ' (' + r.risk + ')';
    const itemL = wrap(item, W[1]);
    const n = Math.max(ev.length, itemL.length);
    for (let j = 0; j < n; j++) {
      lines.push([pad(j === 0 ? String(i + 1) : '', W[0]), pad(itemL[j] || '', W[1]), pad(j === 0 ? c.current : '', W[2]), pad(j === 0 ? c.recommended : '', W[3]), pad(ev[j] || '', W[4]), j === 0 ? c.effect : ''].join(' ').trimEnd());
    }
    if (whys && whys[r.rule]) lines.push('   ' + whys[r.rule]);
  });
  return lines.join('\n');
}

const MON = ['<50k', '50-100k', '100-200k', '200-300k', '300-500k', '>=500k'];
// Text report for `analyze` (not json). all = buildAll result.
function analyzeReport(lang, all, cleanup) {
  const t = tbl(lang).a;
  const w = all.windows.d7;
  const out = [headerLine(lang, all.range.days, cleanup, all.partial), '', t.title(w.period.days)];
  const wUsd = w.totals.parts.w5 + w.totals.parts.w1;
  out.push(t.total({ usd: w.totals.usd, calls: w.totals.calls, w: wUsd, parts: w.totals.parts }));
  out.push(t.roles(w.roles));
  out.push(t.fam);
  for (const k of Object.keys(w.byFamily)) out.push(t.famRow(k, w.byFamily[k]));
  out.push(t.bands + ': ' + MON.map((b) => `${b} ${usdInt(w.ctxBands[b].usd)}`).join(', '));
  out.push(t.rewrite + ': ' + Object.keys(w.rewrite).map((k) => `${k} ${usdInt(w.rewrite[k].main_usd)}/${usdInt(w.rewrite[k].sub_usd)}`).join(', '));
  out.push(t.classes + ': ' + Object.keys(w.subagents.byClass).map((k) => { const c = w.subagents.byClass[k]; return `${k} ${usdInt(c.usd)}/${c.n}/${usdInt(c.upper_usd)}/${usdInt(c.upper_no_model_usd)}`; }).join(', '));
  out.push(t.old(w.oldModels));
  out.push(t.comp(w.compaction));
  if (w.topSessions.length) { out.push(t.top); for (const s of w.topSessions.slice(0, 5)) out.push(t.topRow(s)); }
  const d = all.windows.d30;
  if (d !== w) out.push(t.d30(d.period.days, d.totals));
  out.push('', ...footerLines(lang, d, all.partial));
  return out.join('\n');
}
export { T, sym, tbl, usd, usdInt, range, kTok, pct, dispW, pad, wrap, row, headerLine, footerLines, table, analyzeReport };
