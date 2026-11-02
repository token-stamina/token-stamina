// Defaults of the advisor config keys (design section 5.1). config.default.json must hold the same values
// (hooks/advisor-defaults.test.ts). Code reads cfg.<key> with these as the fallback.
// Regex sources (case-insensitive) for commands that may run over 5 minutes (sub-wait.ts).
export const LONG_CMD_PATTERNS: string[] = [
  '(?:^|[\\s;&|(])(?:sleep|Start-Sleep(?:\\s+-(?:Seconds|s))?)\\s+(?:[3-9]\\d{2}|\\d{4,})(?:\\s|$|;|&|\\|)',
  '\\b(?:while|until)\\b[^\\n]*\\b(?:sleep|Start-Sleep)\\b',
  '\\bnode\\s+--test\\s*(?:$|[;&|]|\\d*>)',
  '\\b(?:npm|pnpm|yarn)\\s+(?:run\\s+)?test\\s*(?:$|[;&|]|\\d*>)',
  '\\bpytest\\b(?![^;&|\\n]*(?:\\s-k\\b|\\.py\\b|::|/))',
  '\\bcargo\\s+test\\b',
  '\\bgo\\s+test\\s+\\./\\.\\.\\.',
  '\\bgradle(?:w)?\\s+test\\b',
  '\\bmvn(?:w)?\\s+test\\b',
];
// advisorNotifyCommand stays a key (config.default.json parity with the Node build) but the mod never runs it.
export const ADVISOR_DEFAULTS: Record<string, any> = {
  advisor: true,
  advisorMinEffectUsd: 5,
  advisorAutoApply: [],
  advisorNotifyCommand: null,
  advisorDevice: null,
  advisorExportDir: null,
  advisorHistoryKeep: 12,
  advisorRejectCooldownSec: 2419200,
  explicitDowngradePressure: 'pace',
  judgmentKeywords: ["design","architecture","review","audit","strategy","security","decide","plan","설계","리뷰","검수","전략","감사","판단","결정"],
  simpleKeywords: ["list","find","grep","glob","count","aggregate","format","rename","summarize logs","collect","목록","찾기","집계","포맷","수집","정리"],
  implementationKeywords: ['implement', 'build', 'port', 'fix', 'refactor', 'write tests', '구현', '수정', '포팅', '작성', '테스트 작성', '이식', '배선', 'wiring', 'fix pass'],
  hintTrigger: 'always',
  hintMinEffectTokens: 0,
  subagentWaitAdvice: false,
  oldModelWarn: false,
  subagentLongCmdAdvice: false,
  longCmdPatterns: LONG_CMD_PATTERNS,
};
