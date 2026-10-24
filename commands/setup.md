---
description: Register the Token Stamina status line (wrapping your existing one) and suggest subagent model defaults
allowed-tools: Read, Edit, Bash(node:*), AskUserQuestion
---

Set up Token Stamina. Plugins cannot register a main status line themselves, so this is done in user settings, and only after the user agrees.

Ask every question that has fixed answers (yes or no, or a pick from a list) with the AskUserQuestion tool, so the user can click instead of typing. Put the recommended option first and mark it "(Recommended)". The tool takes 2 to 4 options and always adds a free-text "Other"; when there are more choices, leave the least likely ones to "Other" and name them in the question. If the tool is unavailable, ask in one short line.

0. Language first. Ask which language Token Stamina should use for its status line and hints: Auto (follow the language you write in; recommended), English, 한국어 (Korean), 日本語 (Japanese) or 中文 (Chinese; screen lines stay English, hints for Claude follow Chinese). Ask in the language the user is writing in and make that language the recommended choice. After the pick, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-lang.js" --lang <auto|en|ko|ja|zh>` (it only sets `lang` in `~/.claude/token-stamina/config.json`, keeping other keys) and continue the rest of setup in that language. If the user skips, leave it unset (same as auto).
1. Read `~/.claude/settings.json` and report the current `statusLine` (if any) and `env.CLAUDE_CODE_SUBAGENT_MODEL`.
2. Status line. Preview with `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.js" --dry-run` and show the output, then wait for an explicit yes and run it without `--dry-run`. Do not edit `statusLine` by hand. The script:
   - writes a small launcher, `~/.claude/token-stamina/token-stamina-statusline.js`, that runs whichever Token Stamina version is installed, so the status line keeps working after plugin updates;
   - points `statusLine` at that launcher, after backing up `~/.claude/settings.json`;
   - keeps an existing status line that is not Token Stamina's by saving it as `wrap` in `~/.claude/token-stamina/config.json` (Token Stamina runs it with the same stdin and appends its own segment). An older Token Stamina entry is replaced, not wrapped.
3. Explain, do not apply: setting env `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` gives a static default for subagents. On Claude Code older than v2.1.251 that env var overrides even explicit per-call models, so check `claude --version` first.
4. After editing, tell the user to restart Claude Code and that the first values appear after the first response in a session (Pro/Max only).
5. Offer, never auto-apply (ask first): a keybinding so `/compact` is one keypress. Show the user this for `~/.claude/keybindings.json` and let them choose the key; only edit the file after an explicit yes and keep existing bindings:
   `{ "bindings": [ { "context": "Chat", "bindings": { "ctrl+k ctrl+c": "command:compact" } } ] }`
   (`command:compact` takes no arguments; Token Stamina restores its auto-saved handoff note after compact/clear, so plain `/compact` is enough.)
6. Auto-compact point (ask; apply only after an explicit pick). Present the choice with this cost note: lower = cheaper per turn but compacts more often; average per-turn context is roughly (fixed overhead ~100k + chosen window) / 2.
   - 300k (more frequent compaction, cheapest turns)
   - 400k (recommended)
   - 600k
   - keep Claude Code's default (about 967k on 1M-context models; removes the setting)
   First preview with `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-compact.js" --window <300000|400000|600000|default> --dry-run`, show the output, then after the user confirms run it without `--dry-run`. It backs up `~/.claude/settings.json` with a timestamp, sets or removes `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`, and records `compactWindowTokens` in `~/.claude/token-stamina/config.json` so the hint thresholds follow (hint at ~40% of the window, new-session advice at ~95%, topic gate at ~50%). Never run it without an explicit choice.
