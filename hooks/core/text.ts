// Pure: token/size estimates and small string helpers shared by several core modules.
// Ported from scripts/audit.js (estimateTokens, encodeCwd) -- only the pure subset needed
// for stage 1. The rest of audit.js (report/audit command, SAFE_ARG allowlist, runClaude)
// is out of scope for stage 1 (PLAN-0.5-mods.md Stage 2+).

// Rough, deliberately simple token estimate: ascii chars/4 + everything else (CJK etc.)/1.5.
// Never presented as exact -- callers must label downstream text as an estimate.
export function estimateTokens(text: unknown): number {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text)) {
    if ((ch.codePointAt(0) ?? 0) < 128) ascii++;
    else other++;
  }
  return Math.round(ascii / 4 + other / 1.5);
}

// Claude Code project folder name: every non-alphanumeric character becomes '-'
// (C:\Projects -> C--Projects). Matches Claude Code's own ~/.claude/projects/<encoded> layout.
export function encodeCwd(cwd: unknown): string {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}
