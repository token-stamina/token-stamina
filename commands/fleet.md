---
description: Show how many subagents are running now and on which models (read-only, no LLM)
argument-hint: "[--all]"
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.js" $ARGUMENTS` and show its table output to the user as is (it is already formatted, in the user's language). Then add at most two lines: how many are running and on which models (S=Sonnet, O=Opus, H=Haiku, F=Fable, ?=inherited from the parent). Mention that "stale" means a record that stopped updating without being marked finished. Without `--all` it covers only the current session's most recent transcript; with `--all` it sweeps every project. The plugin cannot stop running agents; this view only observes.

If the table starts with a budget line (7d usage, today's share, reset time), keep it as is: it is the same pace figure the status line shows, so the fleet size can be read against what is left.

If a sessions line follows (sessions S interactive, excluded B, headless H, agents here M), keep it as is too: S counts the other interactive Claude sessions active in the last 30 minutes (this session, the folders in `excludeCwd` and headless SDK/bot sessions are not counted in S; B and H show how many were set aside, "unknown" = head unreadable, not counted). With `--all` the agent count there is the total over every session. Sessions and agents together are what the hooks weigh against the account limit.
