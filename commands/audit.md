---
description: Audit fixed token costs - always-loaded files, plugins, MCP/skill usage and turn-off candidates (no LLM, changes nothing)
argument-hint: "[--cwd <path>] [--days 30] [--json] [--no-details]"
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/audit.js" $ARGUMENTS` and show its table output to the user as is (it is already formatted). Then add at most three lines: the largest always-loaded cost and the turn-off candidates, if any. Do not turn anything off yourself; the script only prints how. Mention that claude.ai chat and desktop-extension use is not in these records.
