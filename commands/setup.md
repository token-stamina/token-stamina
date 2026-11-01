---
description: Set the language of Token Stamina's hints, check leftovers of the old status line setup and suggest subagent model and auto-compact defaults
allowed-tools: Read, Edit, Write, AskUserQuestion
---

Set up Token Stamina (the mod build). The status line needs no setup any more: the mod shows its own status row, does not touch your `statusLine` setting and does not wrap another status line. Nothing here needs a shell: you read and edit files yourself, and every step that changes a user file shows a preview first and waits for an explicit yes.

Ask every question that has fixed answers (yes or no, or a pick from a list) with the AskUserQuestion tool, so the user can click instead of typing. Put the recommended option first and mark it "(Recommended)". The tool takes 2 to 4 options and always adds a free-text "Other"; when there are more choices, leave the least likely ones to "Other" and name them in the question. If the tool is unavailable, ask in one short line.

Files (turn `~` into the user's home folder; the tools need absolute paths):
- `SETTINGS` = `~/.claude/settings.json` (under `$CLAUDE_CONFIG_DIR` instead, if the user says they set that)
- `CONFIG` = `~/.claude/token-stamina/config.json` (under `$TOKEN_STAMINA_HOME` instead, if the user says they set that); it may not exist yet

0. Language first. Ask which language Token Stamina should use for its status row and hints: Auto (follow the language you write in; recommended), English, 한국어 (Korean), 日本語 (Japanese) or 中文 (Chinese; screen lines stay English, hints for Claude follow Chinese). Ask in the language the user is writing in and make that language the recommended choice. After the pick, preview `token-stamina config lang: <current or (unset, auto)> -> <auto|en|ko|ja|zh>` and, after a yes, read `CONFIG` (missing counts as `{}`; if it exists but is not valid JSON, do not overwrite it, tell the user), set only `lang`, keep every other key and write it back with Write. If the user skips, leave it unset (same as auto). Continue the rest of setup in the chosen language.
1. Read `SETTINGS` and report the current `statusLine` (if any) and `env.CLAUDE_CODE_SUBAGENT_MODEL`. If the file is not valid JSON, say so and stop.
2. Old status line check. If `statusLine.command` mentions `token-stamina-statusline.js`, it is the status line of the old Node version of Token Stamina; the mod does not need it and it is safe to remove. Tell the user how, and do not change it yourself unless they ask:
   - If `CONFIG` has a `wrap` command, the user's own status line was saved there: set `statusLine` back to that command (keep `type`, `padding` and the other keys of the old entry as they are), then remove `wrap` from `CONFIG`.
   - Otherwise delete the `statusLine` key from `SETTINGS`.
   - The launcher file `~/.claude/token-stamina/token-stamina-statusline.js` can then be deleted by hand; the mod never reads it.
   - Say that the mod's status row cannot wrap or combine with another status line command.

   If the user asks you to do the edit, show the before and after of the `statusLine` entry, wait for an explicit yes, and keep a copy of the current text in `SETTINGS` + `.bak-token-stamina-` + the current UTC time as an ISO string with every `:` and `.` turned into `-`. A `statusLine` that does not mention Token Stamina is the user's own: leave it alone.
3. Explain, do not apply: setting env `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` gives a static default for subagents. On Claude Code older than v2.1.251 that env var overrides even explicit per-call models, so the user should check `claude --version` first. (The mod already moves subagent calls to cheaper models by itself when the pace is ahead.)
4. Tell the user to restart Claude Code and that the first values appear after the first response in a session (Pro/Max only).
5. Offer, never auto-apply (ask first): a keybinding so `/compact` is one keypress. Show the user this for `~/.claude/keybindings.json` and let them choose the key; only edit the file after an explicit yes and keep existing bindings:
   `{ "bindings": [ { "context": "Chat", "bindings": { "ctrl+k ctrl+c": "command:compact" } } ] }`
   (`command:compact` takes no arguments; Token Stamina restores its auto-saved handoff note after compact/clear, so plain `/compact` is enough.)
6. Auto-compact point (ask; apply only after an explicit pick). Present the choice with this cost note: lower = cheaper per turn but compacts more often; average per-turn context is roughly (fixed overhead ~100k + chosen window) / 2.
   - 300k (more frequent compaction, cheapest turns)
   - 400k (recommended)
   - 600k
   - keep Claude Code's default (about 967k on 1M-context models; removes the setting)

   Then follow exactly the steps of `/token-stamina:autocompact` (step 3 onward): preview the `SETTINGS` and `CONFIG` changes and the backup name, and only after a yes write the backup, edit `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` in `SETTINGS` (remove the key for the default, and `env` when it ends up empty) and set or remove `compactWindowTokens` in `CONFIG`. Never edit without an explicit choice and a yes to the preview.
