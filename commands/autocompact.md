---
description: Show or change when Claude Code compacts automatically (300k / 400k / 600k / default), without running the whole setup
argument-hint: "[300k|400k|600k|default]"
allowed-tools: Read, Edit, Write, AskUserQuestion
---

Change only the auto-compact point. Speak in the language the user is writing in. Nothing here needs a shell: you read and edit two files yourself, and only after the user agrees to a preview.

Ask every question that has fixed answers (yes or no, or a pick from a list) with the AskUserQuestion tool, so the user can click instead of typing. Put the recommended option first and mark it "(Recommended)". The tool takes 2 to 4 options and always adds a free-text "Other"; when there are more choices, leave the least likely ones to "Other" and name them in the question. If the tool is unavailable, ask in one short line.

Files (turn `~` into the user's home folder; the tools need absolute paths):
- `SETTINGS` = `~/.claude/settings.json` (under `$CLAUDE_CONFIG_DIR` instead, if the user says they set that)
- `CONFIG` = `~/.claude/token-stamina/config.json` (under `$TOKEN_STAMINA_HOME` instead, if the user says they set that); it may not exist yet

1. Read `SETTINGS` and report, in one or two lines: `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` (or "Claude Code default, about 967k on 1M-context models" when unset) and, if set, `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (Claude Code then compacts at that percent of the window, so 400k at 70 means about 280k). If the file is not valid JSON, say so and stop; change nothing.
2. If `$ARGUMENTS` already names a choice, use it. Otherwise offer these, with the current one marked:
   - 300k: cheapest turns, compacts most often
   - 400k: recommended
   - 600k: compacts less often, each turn reads more
   - default: remove the setting and use Claude Code's own point

   Add one line on the trade-off: each call re-reads the whole context, so the average cost per turn is roughly (fixed overhead ~100k + window) / 2; a lower point is cheaper per turn but compacts more often. Token Stamina restores its handoff note after every compact. A number outside 100000 to 2000000 is refused.
3. Preview, and write nothing yet. Show these lines:
   - `SETTINGS` path
   - `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW: <before or (unset)> -> <new value as a string, e.g. "400000", or (unset, Claude Code default)>`
   - `token-stamina config compactWindowTokens: <new number, or (removed)>`
   - the backup file that will be made: `SETTINGS` path + `.bak-token-stamina-` + the current UTC time as an ISO string with every `:` and `.` turned into `-` (for example `settings.json.bak-token-stamina-2026-10-31T12-00-00-000Z`)

   If the value in `SETTINGS` already equals the new one, say there is nothing to change in it and skip to the `CONFIG` update.
4. Only after an explicit yes, in this order:
   1. Write the backup file with exactly the text you read from `SETTINGS` (skip it when `SETTINGS` does not change).
   2. Edit `SETTINGS`: set the string value of `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`, creating `env` when missing. For `default`, remove that key, and remove `env` when it ends up empty. Change nothing else and keep the file's indentation and key order. Do not touch `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`; mention it if set.
   3. Read `CONFIG` (missing counts as `{}`; if it exists but is not valid JSON, do not overwrite it, tell the user). Set `compactWindowTokens` to the new number, or remove the key for `default`, keep every other key, and write it back (Write; it creates the folder). Token Stamina's hint thresholds follow this number (hint at about 40% of the window, new-session advice at about 95%, topic gate at about 50%).
5. Tell the user the new point applies to sessions started after a Claude Code restart, and which backup file was made.

Never edit anything without an explicit choice and a yes to the preview.
