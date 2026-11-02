// Templates of the first screen (design "First analysis -> apply -> one-week check"): pattern, leaks, why lines, no-effect
// block, glossary, one-week check. Numbers and price ratios are passed in (computed from pricing.js); no number is typed here.
// en and ko; every other language prints English (the coverage line below also has ja).
export const usdInt = (x: number) => '$' + Math.round(x).toLocaleString('en-US');
export const pct = (x: number) => Math.round(x * 100) + '%';
export const pr = (x: number) => '$' + String(Math.round(x * 100) / 100); // a price per MTok: $0.2, $4, $0.25
export const nx = (x: number) => (Math.round(x * 10) / 10) + 'x';
const nb = (x: number) => (Math.round(x * 10) / 10) + '배'; // Korean "2배", "2.5배"
const fam = (f: string) => f.charAt(0).toUpperCase() + f.slice(1);
const k = (n: number) => Math.round(n / 1000) + 'k';
const sgn = (x: number) => (x > 0 ? '+' : '') + Math.round(x * 100) + '%';
const num = (x: number) => (Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 100) / 100));

export const T: Record<string, any> = {
  en: {
    patternTitle: 'Your pattern in one look',
    pattern1: (p: any) => `About ${usdInt(p.usd)}/wk API-equivalent: main session ${pct(p.mainShare)}, subagents ${pct(p.subShare)}.`,
    pattern2: (p: any) => `Cost parts: cache read ${usdInt(p.read)}, cache write ${usdInt(p.write)}, output ${usdInt(p.output)}` + (p.input >= 1 ? `, new input ${usdInt(p.input)}` : '') + '.',
    leaksTitle: 'Where the money goes: top 3 (figures can overlap, do not add them up)',
    leaksNone: (min: any) => `No single cause is above ${usdInt(min)}/wk.`,
    leak: {
      upper_impl: { label: 'Opus/Fable subagents on implementation or simple work', ev: (e: any) => `${usdInt(e.explicit)} with a model named, ${usdInt(e.unnamed)} without` },
      ttl5_sub: { label: 'Subagent cache rewritten after 5 min', ev: (e: any) => `${e.n} rewrites` },
      old_models: { label: 'Old-model sessions', ev: (e: any) => `${e.sessions} session${e.sessions === 1 ? "" : "s"}` },
      idle_1h: { label: 'Returning after more than 1 h idle', ev: (e: any) => `${e.n} returns` },
      fable_sub: { label: 'Fable subagents', ev: (e: any) => `${pct(e.share)} of subagent cost` },
      compaction: { label: 'Cache rewritten after a compaction', ev: (e: any) => `${e.n} rewrites` },
    },
    leakLine: (i: any, label: any, usd: any, ev: any) => `${i}. ${label}: ${usdInt(usd)}/wk (${ev})`,
    recsTitle: 'Recommendations',
    why: {
      main: (x: any) => (x.same
        ? `Why: cache read is ${usdInt(x.read)} of ${usdInt(x.total)} main cost, and ${fam(x.a)} = ${fam(x.b)} there (${pr(x.pa)}/MTok): a main-model switch saves little.`
        : `Why: cache read is ${usdInt(x.read)} of ${usdInt(x.total)} main cost; ${fam(x.a)} costs ${nx(x.r)} ${fam(x.b)} there (${pr(x.pa)} vs ${pr(x.pb)}/MTok).`),
      sub: (x: any) => `Why: subagents write fresh context and much code; ${fam(x.a)} costs ${nx(x.n)} ${fam(x.b)} there (in ${pr(x.ia)} vs ${pr(x.ib)}, out ${pr(x.oa)} vs ${pr(x.ob)}).`,
      cache5: (x: any) => `Why: after 5 min idle the stored context is dropped; rewriting costs about ${nx(x.k)} a cache read per token.`,
      cache1: (x: any) => `Why: after 1 h idle the stored context is dropped; rewriting costs about ${nx(x.k)} a cache read per token.`,
      hints: (x: any) => `Why: ${pct(1 - x.followed)} of hints were ignored and only interrupt; gap mode shows hints only after a real gap.`,
      clear: (x: any) => (x.fixed > 0
        ? `Why: clear/compact drops only the chat; ~${k(x.fixed)} fixed tokens (tools, system text) stay, so the saving is smaller.`
        : 'Why: clear/compact drops only the chat; the fixed part (tools, system text) stays, so the saving is smaller.'),
      old: (x: any) => `Why: old ${fam(x.family)} versions charge ${nx(x.r)} the current cache-read price (${pr(x.pa)} vs ${pr(x.pb)}/MTok).`,
    },
    noEffectTitle: 'Little or no effect (no change needed)',
    noEffect: {
      R3: (x: any) => `Auto-compact point (${x.cur}): no change needed: the best cap saves at most ${usdInt(x.save)}/wk before the compaction cost.`,
      R2: (x: any) => `Clear/compact hints: no change needed: followed ${pct(x.followed)}, keep (saved ~${usdInt(x.saved)}/wk).`,
      R6: (x: any) => `Return after idle: no change needed: idle returns cost ${usdInt(x.usd)}/wk and the topic gate is already on.`,
      generic: (x: any) => `${x.item}: no change needed: effect under ${usdInt(x.min)}/wk.`,
    },
    glossary: [
      'cache read: re-reading the stored conversation on every call (cheap per token).',
      'cache write: storing new context for reuse (costs more than a normal input token).',
      'output: the text and code the model writes (the dearest per token).',
      'context: everything sent with a call: tools, system text and the conversation.',
    ],
    check: {
      title: (id: any, days: any) => `One-week check of apply ${id}: ${days} days of data after the change`,
      early: (n: any) => `Too early (${n} days of data after the change; at least 5 are needed).`,
      none: 'No applied change to check.',
      reverted: (id: any) => `Apply ${id} was reverted; nothing to check.`,
      checked: (id: any) => `Apply ${id} was already checked; nothing more to do (add --force to check again).`,
      item: (rule: any, verdict: any, calls: any) => `${rule}: ${verdict} (${calls} calls)`,
      metric: (name: any, b: any, a: any, p: any) => `  ${name}: ${num(b)} -> ${num(a)} (${sgn(p)})`,
      names: { upper_share: 'upper-tier share of subagent cost', usd_per_impl_agent: '$ per implementation subagent', ttl5_per100_sub_calls: '5-min rewrite $ per 100 subagent calls',
        hints_per100_main_calls: 'hint lines per 100 main calls', follow_rate: 'hint follow rate', old_model_call_share: 'old-model share of calls',
        idle_1h_usd_per_session: 'idle-return $ per session', mean_ctx: 'mean context (tokens)', compactions_per100_main_calls: 'compactions per 100 main calls' },
      verdicts: { improved: 'improved', no_effect: 'no effect', worse: 'worse', unclear: 'unclear (too few calls)' },
      proposals: (n: any) => `${n} follow-up suggestion${n === 1 ? '' : 's'} waiting. Run /token-stamina:advisor review`,
    },
    follow: {
      revertItem: (rule: any) => `Undo ${rule} change`,
      thresholdItem: 'Effect threshold (advisorMinEffectUsd)',
      revertEv: (e: any) => `${e.verdict}: ${sgn(e.pct)} after a week`,
      thresholdEv: (e: any) => `improved; what is left (${usdInt(e.left)}/wk) is near the threshold ${usdInt(e.min)}/wk`,
      revertEff: 'back to the previous setting', thresholdEff: 'fewer repeat suggestions',
    },
  },
  ko: {
    patternTitle: '한눈에 보는 사용 패턴',
    pattern1: (p: any) => `API 환산 주 약 ${usdInt(p.usd)}: 메인 세션 ${pct(p.mainShare)}, 서브에이전트 ${pct(p.subShare)}.`,
    pattern2: (p: any) => `비용 구성: 캐시 읽기 ${usdInt(p.read)}, 캐시 쓰기 ${usdInt(p.write)}, 출력 ${usdInt(p.output)}` + (p.input >= 1 ? `, 새 입력 ${usdInt(p.input)}` : '') + '.',
    leaksTitle: '돈이 새는 곳 상위 3 (수치는 서로 겹칠 수 있어서 더하면 안 돼요)',
    leaksNone: (min: any) => `주 ${usdInt(min)}를 넘는 단일 원인은 없어요.`,
    leak: {
      upper_impl: { label: '구현·단순 작업에 쓴 Opus/Fable 서브에이전트', ev: (e: any) => `모델 지정 ${usdInt(e.explicit)}, 미지정 ${usdInt(e.unnamed)}` },
      ttl5_sub: { label: '5분 뒤 서브에이전트 캐시 재작성', ev: (e: any) => `${e.n}회` },
      old_models: { label: '구형 모델 세션', ev: (e: any) => `세션 ${e.sessions}개` },
      idle_1h: { label: '1시간 넘게 쉰 뒤 복귀', ev: (e: any) => `${e.n}회` },
      fable_sub: { label: 'Fable 서브에이전트', ev: (e: any) => `서브에이전트 비용의 ${pct(e.share)}` },
      compaction: { label: '압축 뒤 캐시 재작성', ev: (e: any) => `${e.n}회` },
    },
    leakLine: (i: any, label: any, usd: any, ev: any) => `${i}. ${label}: 주 ${usdInt(usd)} (${ev})`,
    recsTitle: '권장 사항',
    why: {
      main: (x: any) => (x.same
        ? `이유: 메인 비용 ${usdInt(x.total)} 중 캐시 읽기가 ${usdInt(x.read)}이고 ${fam(x.a)}와 ${fam(x.b)}의 읽기 단가가 같아서(${pr(x.pa)}/MTok) 메인 모델을 바꿔도 거의 안 줄어요.`
        : `이유: 메인 비용 ${usdInt(x.total)} 중 캐시 읽기가 ${usdInt(x.read)}이고 ${fam(x.a)}는 ${fam(x.b)}의 ${nb(x.r)}예요 (${pr(x.pa)} 대 ${pr(x.pb)}/MTok).`),
      sub: (x: any) => `이유: 서브에이전트는 새 컨텍스트와 코드를 많이 써서 ${fam(x.a)}가 ${fam(x.b)}의 ${nb(x.n)} (입력 ${pr(x.ia)} 대 ${pr(x.ib)}, 출력 ${pr(x.oa)} 대 ${pr(x.ob)})예요.`,
      cache5: (x: any) => `이유: 서브에이전트가 5분 넘게 기다리면 저장된 컨텍스트가 버려져 다시 써요. 다시 쓰는 비용이 토큰당 캐시 읽기의 약 ${nb(x.k)}예요.`,
      cache1: (x: any) => `이유: 1시간 넘게 쉬면 저장된 컨텍스트가 버려져 다시 써요. 다시 쓰는 비용이 토큰당 캐시 읽기의 약 ${nb(x.k)}예요.`,
      hints: (x: any) => `이유: 힌트의 ${pct(1 - x.followed)}를 무시해서 방해만 돼요. 간격 모드는 실제로 쉬었을 때만 힌트를 보여줘요.`,
      clear: (x: any) => (x.fixed > 0
        ? `이유: 비우기·압축은 대화만 덜어내요. 고정 부분(도구·시스템 글, 약 ${k(x.fixed)} 토큰)은 남아서 절약이 작아요.`
        : '이유: 비우기·압축은 대화만 덜어내요. 고정 부분(도구·시스템 글)은 남아서 절약이 작아요.'),
      old: (x: any) => `이유: 구형 ${fam(x.family)}는 현재 버전 캐시 읽기 단가의 ${nb(x.r)}예요 (${pr(x.pa)} 대 ${pr(x.pb)}/MTok).`,
    },
    noEffectTitle: '효과가 작거나 없음 (바꿀 필요 없음)',
    noEffect: {
      R3: (x: any) => `자동 압축 시점 (${x.cur}): 바꿀 필요 없어요: 가장 좋은 상한도 압축 비용을 빼기 전 주 ${usdInt(x.save)} 이하예요.`,
      R2: (x: any) => `압축/비우기 힌트: 바꿀 필요 없어요: ${pct(x.followed)} 따랐으니 그대로 둬요 (주 약 ${usdInt(x.saved)} 절약).`,
      R6: (x: any) => `쉬었다 돌아온 세션: 바꿀 필요 없어요: 복귀 비용이 주 ${usdInt(x.usd)}이고 주제 게이트가 이미 켜져 있어요.`,
      generic: (x: any) => `${x.item}: 바꿀 필요 없어요: 효과가 주 ${usdInt(x.min)} 미만이에요.`,
    },
    glossary: [
      '캐시 읽기: 호출마다 저장된 대화를 다시 읽는 것 (토큰당 쌈).',
      '캐시 쓰기: 새 컨텍스트를 재사용하려고 저장하는 것 (보통 입력보다 비쌈).',
      '출력: 모델이 쓰는 글과 코드 (토큰당 가장 비쌈).',
      '컨텍스트: 호출마다 같이 보내는 전부: 도구, 시스템 글, 대화.',
    ],
    check: {
      title: (id: any, days: any) => `적용 ${id} 일주일 점검: 변경 뒤 ${days}일치 기록`,
      early: (n: any) => `아직 일러요 (변경 뒤 ${n}일치, 최소 5일이 필요해요).`,
      none: '점검할 적용 기록이 없어요.',
      reverted: (id: any) => `적용 ${id} 는 이미 되돌려서 점검할 것이 없어요.`,
      checked: (id: any) => `적용 ${id} 는 이미 점검했어요. 다시 하려면 --force 를 붙이세요.`,
      item: (rule: any, verdict: any, calls: any) => `${rule}: ${verdict} (호출 ${calls}건)`,
      metric: (name: any, b: any, a: any, p: any) => `  ${name}: ${num(b)} -> ${num(a)} (${sgn(p)})`,
      names: { upper_share: '서브에이전트 비용 중 상위 모델 비중', usd_per_impl_agent: '구현 서브에이전트당 $', ttl5_per100_sub_calls: '서브에이전트 100호출당 5분 재작성 $',
        hints_per100_main_calls: '메인 100호출당 힌트 줄', follow_rate: '힌트 따른 비율', old_model_call_share: '구형 모델 호출 비중',
        idle_1h_usd_per_session: '세션당 쉰 뒤 복귀 $', mean_ctx: '평균 컨텍스트 (토큰)', compactions_per100_main_calls: '메인 100호출당 압축' },
      verdicts: { improved: '좋아짐', no_effect: '효과 없음', worse: '나빠짐', unclear: '판단 불가 (호출 너무 적음)' },
      proposals: (n: any) => `후속 제안 ${n}건이 대기 중이에요. /token-stamina:advisor review 로 확인하세요`,
    },
    follow: {
      revertItem: (rule: any) => `${rule} 변경 되돌리기`,
      thresholdItem: '효과 기준 (advisorMinEffectUsd)',
      revertEv: (e: any) => `${e.verdict}: 일주일 뒤 ${sgn(e.pct)}`,
      thresholdEv: (e: any) => `좋아졌고 남은 ${usdInt(e.left)}/주가 기준 ${usdInt(e.min)}/주 근처예요`,
      revertEff: '이전 설정으로 복귀', thresholdEff: '반복 제안 감소',
    },
  },
};
export const tr = (lang: string): any => T[lang] || T.en;

// ---- coverage line (design decision 1: transcript files over 4 MiB cannot be read, so they are counted, not priced)
const MIB = 1048576;
const mb1 = (b: number) => String(Math.round((b / MIB) * 10) / 10);
export const COVERAGE: Record<string, any> = {
  en: {
    all: (c: any) => `Read ${c.read} of ${c.files} transcript files (100% of bytes).`,
    base: (c: any) => `Read ${c.read} of ${c.files} transcript files (${c.p}% of bytes).`,
    big: (c: any) => `${c.skipped} file${c.skipped === 1 ? '' : 's'} over 4 MiB ${c.skipped === 1 ? 'was' : 'were'} not read (${c.s} MB)` + (c.mainHeavy ? ', mostly long main sessions, so main-session figures are a lower bound.' : '.'),
    budget: (c: any) => `${c.unread} file${c.unread === 1 ? '' : 's'} not read yet (time budget); the next run continues.`,
    failed: (c: any) => `${c.failed} file${c.failed === 1 ? '' : 's'} could not be read.`,
    mark: ' (lower bound)',
    keepReason: ' (lower bound: large sessions could not be read)',
  },
  ko: {
    all: (c: any) => `대화 기록 파일 ${c.files}개 중 ${c.read}개를 읽었어요 (바이트 100%).`,
    base: (c: any) => `대화 기록 파일 ${c.files}개 중 ${c.read}개를 읽었어요 (바이트 ${c.p}%).`,
    big: (c: any) => `4 MiB가 넘는 파일 ${c.skipped}개(${c.s} MB)는 읽지 못했어요` + (c.mainHeavy ? ', 대부분 긴 메인 세션이라 메인 세션 수치는 하한이에요.' : '.'),
    budget: (c: any) => `${c.unread}개는 아직 못 읽었어요 (시간 예산). 다음 실행이 이어서 읽어요.`,
    failed: (c: any) => `${c.failed}개는 읽기에 실패했어요.`,
    mark: ' (하한)',
    keepReason: ' (하한: 큰 세션을 못 읽었음)',
  },
  ja: {
    all: (c: any) => `会話記録ファイル ${c.files} 件中 ${c.read} 件を読み込みました (バイト数の 100%)。`,
    base: (c: any) => `会話記録ファイル ${c.files} 件中 ${c.read} 件を読み込みました (バイト数の ${c.p}%)。`,
    big: (c: any) => `4 MiB を超える ${c.skipped} 件 (${c.s} MB) は読み込めませんでした` + (c.mainHeavy ? '。多くは長いメインセッションのため、メインセッションの数値は下限です。' : '。'),
    budget: (c: any) => `${c.unread} 件は未読です (時間制限)。次回の実行が続きを読みます。`,
    failed: (c: any) => `${c.failed} 件は読み込みに失敗しました。`,
    mark: ' (下限)',
    keepReason: ' (下限: 大きなセッションを読み込めませんでした)',
  },
};
export const covTable = (lang: string): any => COVERAGE[lang] || COVERAGE.en;

// Bytes that were actually read: read_bytes when the scan recorded it, else everything but the files over 4 MiB.
const readBytesOf = (c: any): number => (typeof c.read_bytes === 'number' ? c.read_bytes : Math.max(0, (c.bytes || 0) - (c.skipped_bytes || 0)));

// c = {files, read, skipped, bytes, skipped_bytes, skipped_main, skipped_sub, read_bytes?, unread?, failed?}; 'bytes' is the total of every
// transcript (skipped included). The "all / 100%" wording is only for a scan that read every file; any file left out (over 4 MiB, cut by the
// time budget, failed to read) turns it into the percentage of bytes really read, never rounded up to 100.
export function coverageLine(lang: string, c: any): string {
  const t = covTable(lang);
  const skipped = c.skipped || 0;
  const other = Math.max(0, (c.files || 0) - (c.read || 0) - skipped);
  const failed = typeof c.failed === 'number' ? Math.min(c.failed, other) : 0;
  const unread = typeof c.unread === 'number' ? Math.min(c.unread, other - failed) : other - failed;
  if (!skipped && !unread && !failed) return t.all({ files: c.files, read: c.read });
  const bytes = c.bytes || 0;
  const p = bytes > 0 ? Math.min(99, Math.round((readBytesOf(c) / bytes) * 100)) : 0;
  const parts = [t.base({ files: c.files, read: c.read, p })];
  if (skipped) parts.push(t.big({ skipped, s: mb1(c.skipped_bytes || 0), mainHeavy: (c.skipped_main || 0) > (c.skipped_sub || 0) }));
  if (unread) parts.push(t.budget({ unread }));
  if (failed) parts.push(t.failed({ failed }));
  return parts.join(' ');
}
// true when 25% or more of the bytes were not read (over 4 MiB, cut by the time budget or failed): R2, R3 and R6 rows then carry the lower-bound mark.
export const lowerBound = (c: any): boolean => !!c && c.bytes > 0 && (c.bytes - readBytesOf(c)) / c.bytes >= 0.25;
