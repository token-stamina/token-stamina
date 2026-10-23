---
description: Estimate tokens saved by the plugin (model downgrades, compacts and clears after hints) - an estimate, not billing
argument-hint: "[--since YYYY-MM-DD]"
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/savings.js" --text $ARGUMENTS` and summarize the output briefly: the three items (model downgrade, compact after hint, clear after hint), the total in Opus input-token equivalents, and what was excluded. You MUST say these are estimates computed from assumptions about what would have been used without the plugin, not actual billing. Do not paste the raw output.
