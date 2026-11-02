---
description: Usage Advisor - find the settings that cost the most and apply the ones you approve (analyze, recommend, apply, revert, review)
argument-hint: "[analyze|recommend|apply|revert|review]"
allowed-tools: mcp__token-stamina__advisor, AskUserQuestion
---

Token Stamina's Usage Advisor reads your local Claude Code transcripts (nothing leaves this PC), prices them at API list prices (an estimate, not a bill) and suggests setting changes. All numbers come from the `mcp__token-stamina__advisor` tool. You never compute, round, re-order or reword a number, and you never write a file yourself: every change goes through the tool.

Rules for the whole command:
- Show the tool's text exactly as it comes back (code block or plain text), then comment in your own words only after it. Do not shorten tables, do not convert currencies, do not change a range.
- The tool names a lower bound whenever a scan skipped files over 4 MiB. Keep that wording where it appears.
- Never apply anything without a clear yes from the person for that item. The tool also asks the person itself (one confirmation dialog per rule, listing every `file key: before -> after` line of that rule; a yes applies all of the rule's values, anything else none, e.g. the compact window changes `settings.json` and the config together) before it writes anything; in a non-interactive (`-p`) run it writes nothing and says an interactive session is needed. Ask each item with the AskUserQuestion tool: the recommended answer first and marked "(Recommended)", then the other answer. An item the tool marks risk B changes how a model is chosen for a whole class of work: say so in the question itself ("risk B: ..."). If AskUserQuestion is not available, ask one short line per item.
- Answer in the language the person writes in.

`$ARGUMENTS` picks the mode (default: `recommend`):

1. `analyze` - call the tool with `mode: "analyze"` (add `days` when the person gave a number). Show the result. Stop there.
2. `recommend` - call the tool with `mode: "recommend"`. Show the result. If it lists suggestions, continue with step 4 for the ones the person wants. If it says there is not enough data, stop.
3. `review` - call the tool with `mode: "review"` (the suggestions the weekly check left waiting, plus anything it changed by itself). Show the result, then continue with step 4 for each waiting suggestion. For a change the weekly check made automatically, the result names the apply id: offer step 6 for it.
4. Plan. For the suggestions the person wants to look at, call the tool with `mode: "plan"` and `ids` (the ids exactly as printed, for example `["R2","R4"]`). It returns a `planId` (valid 10 minutes) and a `before -> after` preview and writes nothing else. Show the preview as it is. If `planId` is null, nothing can be applied: say what the tool printed and stop.
5. Apply. Ask per item (see the rules above). Then call the tool with `mode: "apply"`, the `planId` and `ids` set to only the items the person said yes to. Show the result as it is, including the backup file names. If the tool says the plan expired or the files changed, run step 4 again; never reuse a planId after an error. Nothing is applied for an item the person skipped.
6. `revert` - call the tool with `mode: "revert"` and `last: true` (or `id` when the person names an apply id). It restores a value only when the file still holds what the apply wrote; otherwise it changes nothing and says so. Show the result.
7. When the person declines a suggestion for good, call the tool with `mode: "reject"` and `rule` (for example `"R4"`): it will not be proposed again for the cooldown period.
8. `check` (on request) - `mode: "check"` judges an earlier apply after a week of data; its fine-tune proposals (`UNDO-R#`, `TUNE-R#`) go through steps 4 and 5 like any other suggestion.

The Usage Advisor also runs once a week by itself from the start of a session and leaves its findings for `review`; it only changes Token Stamina's own config when `advisorAutoApply` lists a rule. Settings in `settings.json` are never written without your yes in the tool's own confirmation dialog. `/ts-advisor` shows the same recommendation screen without a model and without any option to apply.
