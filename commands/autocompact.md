---
description: Show or change when Claude Code compacts automatically (300k / 400k / 600k / default), without running the whole setup
argument-hint: "[300k|400k|600k|default]"
allowed-tools: Read, Bash(node:*), AskUserQuestion
---

Change only the auto-compact point. Speak in the language the user is writing in.

Ask every question that has fixed answers (yes or no, or a pick from a list) with the AskUserQuestion tool, so the user can click instead of typing. Put the recommended option first and mark it "(Recommended)". The tool takes 2 to 4 options and always adds a free-text "Other"; when there are more choices, leave the least likely ones to "Other" and name them in the question. If the tool is unavailable, ask in one short line.

1. Read `~/.claude/settings.json` and report, in one or two lines: `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` (or "Claude Code default, about 967k on 1M-context models" when unset) and, if set, `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (Claude Code then compacts at that percent of the window, so 400k at 70 means about 280k).
2. If `$ARGUMENTS` already names a choice, use it. Otherwise offer these, with the current one marked:
   - 300k: cheapest turns, compacts most often
   - 400k: recommended
   - 600k: compacts less often, each turn reads more
   - default: remove the setting and use Claude Code's own point
   Add one line on the trade-off: each call re-reads the whole context, so the average cost per turn is roughly (fixed overhead ~100k + window) / 2; a lower point is cheaper per turn but compacts more often. Token Stamina restores its handoff note after every compact.
3. Preview: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-compact.js" --window <300000|400000|600000|default> --dry-run` and show the output.
4. Only after an explicit yes, run the same command without `--dry-run`. It backs up `~/.claude/settings.json` first and updates `compactWindowTokens` in Token Stamina's config so its hints follow. Do not touch `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`; mention it if set.
5. Tell the user the new point applies to sessions started after a Claude Code restart.
