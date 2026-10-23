---
description: Register the Token Stamina status line (wrapping your existing one) and suggest subagent model defaults
allowed-tools: Read, Edit, Bash(node:*)
---

Set up Token Stamina. Plugins cannot register a main status line themselves, so this is done in user settings, and only after the user agrees.

0. Language first. Ask which language Token Stamina should use for its status line and hints: Auto (follow the language you write in; recommended), English, 한국어 (Korean), 日本語 (Japanese) or 中文 (Chinese; screen lines stay English, hints for Claude follow Chinese). Ask in the language the user is writing in and make that language the recommended choice. After the pick, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-lang.js" --lang <auto|en|ko|ja|zh>` (it only sets `lang` in `~/.claude/token-stamina/config.json`, keeping other keys) and continue the rest of setup in that language. If the user skips, leave it unset (same as auto).
1. Read `~/.claude/settings.json` and report the current `statusLine` (if any) and `env.CLAUDE_CODE_SUBAGENT_MODEL`.
2. Propose, and wait for an explicit yes before editing:
   - `statusLine`: `{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js\"" }`.
   - If a status line already exists, do not drop it: write its command string to `~/.claude/token-stamina/config.json` as `{ "wrap": "<old command>" }` (create the folder; keep other keys). Token Stamina will run it with the same stdin and append its own segment.
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
