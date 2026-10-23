---
description: Summarize local token usage by model, subagent share and unspecified Agent calls
argument-hint: "[--since YYYY-MM-DD]"
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/report.js" $ARGUMENTS` and summarize the JSON briefly: tokens per model (main vs subagent), the Opus/Fable share of subagent tokens, and the share of Agent calls that did not specify a model. Do not paste the raw JSON.
