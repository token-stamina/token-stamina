# Token Stamina

Token Stamina turns your Claude Code pace into action. It compares weekly (7d) and 5-hour usage with how much of each window has passed, grades it green, yellow or red, and when you're well ahead of pace moves subagent calls to cheaper models. At work boundaries in long conversations it suggests a compact (with a savings estimate when it can make one) and saves a handoff note first. It makes no LLM calls; its only network request is a once-a-day version check (`"updateCheck": false` turns it off).

> **Unofficial.** Token Stamina is an independent, community-made plugin for Claude Code. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, PBC and are used only to say what this plugin works with. The 7d/5h percentages are passed through from Claude Code's status line input. Everything Token Stamina derives from them (grades, today's share, exhaustion time) and every savings figure is a local estimate based on assumptions, not a bill or an official usage number.

- **Status segment** (`scripts/statusline.js`): reads `rate_limits` from the status line input, stores it in `~/.claude/token-stamina/state.json`, prints e.g. `7d 84% · today 5.3% 🟡 · reset Mon 15:00 · ctx 41%`. Can wrap your existing status line (`wrap` in config; it runs that command through a shell, see Privacy).
- **Subagent model downgrade** (`scripts/agent-model.js`, PreToolUse `Agent`): only when the grade is red, subagent calls with no explicit model, no pinned definition model and not a fork get `haiku` (simple work) or `sonnet`. Judgment tasks are never forced. Modes: `inject` (default), `suggest`, `off`.
- **Pace nudges** (`scripts/nudge.js`): one line of context when the grade changes.
- **Per-turn cost** (status line): `ctx 19% (190k/turn)`, yellow marker from 100k tokens, red from `compactAtTokens`.
- **Work-boundary hint** (`scripts/boundary.js`, Stop hook): when the context is >= `compactAtTokens` (150k) and this turn committed or edited and ended with an answer, shows a user-visible `systemMessage` suggesting `/compact <commit subjects>`; >= `newSessionAtTokens` (400k) recommends a new session. Re-notifies only after `renotifyGrowthTokens` (100k) more. Nothing is added to the model context and it never blocks.
- **Audit** (`/token-stamina:audit`, `scripts/audit.js`): always-loaded files (estimated tokens), plugins, MCP/skill usage from local transcripts (cached by file mtime+size), and turn-off candidates. Changes nothing. `--cwd`, `--days 30`, `--json`, `--no-details`.
- **Report** (`scripts/report.js`): `node scripts/report.js --since 2026-10-09` aggregates local transcripts by model, main vs subagent.

Grades: green `u <= elapsed%`, yellow up to +10 points, red beyond or `u >= 90`. The worse of the two windows wins; a calm 5h window never upgrades a bad 7d.

Setup: install as a local plugin, then run `/token-stamina:setup`. Plugins cannot register the main status line, so setup edits user settings with your consent. Config: `~/.claude/token-stamina/config.json` overrides `config.default.json`. Set `TOKEN_STAMINA_HOME` to relocate state.

Language: `/token-stamina:setup` asks first (English or 한국어) and records it with `scripts/setup-lang.js`; or set "lang" yourself: `auto` (default; follows the language of your prompts, then the last detected one, then the OS locale), `en`, `ko`, `ja`, `zh`. A fixed value never changes. Status line and screen messages have en/ko/ja tables (other languages show English); lines for Claude carry a "tell the user in their language" directive. It covers nudges, agent-model, boundary, audit and the status line.

Tests: `node --test`.


## Install

In Claude Code 2.1.275 or later:

```
/plugin install token-stamina --marketplace token-stamina/token-stamina
```

On older versions, add the marketplace first, then install the plugin (adding the marketplace alone does not install it). Run both:

```
claude plugin marketplace add token-stamina/token-stamina
claude plugin install token-stamina@token-stamina
```

Then start a new Claude Code session (sessions already open do not see the plugin) and run `/token-stamina:setup` once. Since 0.4.5 you do not have to remember: the first time Claude Code starts with the plugin and no Token Stamina status line, Claude asks once whether to run setup now, and you answer yes or no. It never asks again either way (`scripts/first-run.js`, SessionStart `startup`; `"setupPrompt": false` turns it off).

### Updating

Claude Code does not auto-update third-party marketplaces unless you turn it on: `/plugin` → Marketplaces → `token-stamina` → enable auto-update. To update by hand:

```
claude plugin marketplace update token-stamina
claude plugin update token-stamina@token-stamina
```

then restart Claude Code. Since 0.4.6 you are told once per release when a newer version is out: at startup, at most once a day, `scripts/update-check.js` reads the version in this repository's `.claude-plugin/plugin.json` from GitHub in the background, and the next startup shows one line if it is newer than yours. `"updateCheck": false` turns this off.

The status line set up by 0.4.6 runs a small launcher, `~/.claude/token-stamina/token-stamina-statusline.js`, that always runs the installed version, so updates reach the status line too. If yours was set up by 0.4.5 or older it points at one version folder; Claude offers once to switch it (`scripts/setup-statusline.js`).

## v0.3: handoff
- `scripts/handoff.js` (Stop): writes `~/.claude/token-stamina/handoff/<session>.md` and `latest-<cwdhash>.md` (last 3 requests, commits, edited files, todos; capped by `handoffMaxTokens`; pruned after 7 days). No LLM.
- `handoff.js` (SessionStart, matcher `compact|clear`): injects that note into the fresh conversation. A Claude-written `<session>.claude.md` newer than the last prompt wins. After `/clear` only a Claude-written note from the last hour is restored (the auto note is skipped, since clearing usually means a new topic).
- `scripts/topic-gate.js` (UserPromptSubmit): above `gateAtTokens` (200k) after `idleGapSec` (1h) idle or a cwd change, adds one line asking Claude to write a handoff and offer a fresh start if the request is unrelated. Once per 100k growth.
- Hooks cannot run `/compact` or `/clear`; plain `/compact` (or a `command:compact` keybinding, see `/token-stamina:setup`) is enough because the note is restored.

Auto-compact point: `/token-stamina:autocompact` (or step 6 of `/token-stamina:setup`) lets you pick 300k / 400k (recommended) / 600k / Claude Code default via `scripts/setup-compact.js --window <n|default> [--dry-run]`. It backs up settings.json, sets `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`, and records `compactWindowTokens`; hint thresholds then scale (40% / 95% / 50% of the window) unless set explicitly.

Hooks skip headless runs (`CLAUDE_CODE_ENTRYPOINT` starting with `sdk`) and any cwd matching `excludeCwd` in `~/.claude/token-stamina/config.json` (case-insensitive substrings), so automation that drives Claude Code (bots, scripts) never gets Token Stamina lines in its prompts.

Compact hint (v0.3.5): Claude cannot see its own context size, so `topic-gate.js` (UserPromptSubmit) tells it once the context passes the compact threshold (and again every 100k), asking it to end the task with the hint in its reply. Where a session-clearing tool exists (Claude desktop app `clear_session`), Claude writes the handoff note and offers a one-click clear instead of a paste line. The old screen hint (`boundary.js` systemMessage) is opt-in with `"boundary": true`; `"inlineCompactHint": false` turns the inline hint off.


## v0.4: savings estimate
`/token-stamina:savings [--since YYYY-MM-DD]` (`scripts/savings.js`, default last 7 days; `--text` for a readable report, JSON otherwise; `--dir` overrides the projects folder) shows how many tokens the plugin plausibly saved. **Everything is an estimate**: the difference from what would likely have been used without the plugin, computed under assumptions. It is not billing. Cost per usage record is `(input + 1.25*cache_creation + 0.1*cache_read + 5*output) * weight` (weights from `report.js`), reported as Opus input-token equivalents (cost / Opus weight).
- **Model downgrade**: `agent_model` events with action `inject` (the event now records `tool_use_id`). Subagent usage is summed from the subagent transcript; the Agent tool result's usage is only a fallback (it may cover just the last call). Counterfactual model = the main-thread model that made the call. Assumption: the stronger model would have used the same tokens. Saving = max(0, cost on that model - cost on the real one). `suggest` events are only counted, not credited.
- **Compact after a hint**: a manual `compact_boundary` within 3 hours after an `inline_hint`/`topic_gate`/`boundary` event of the same session. Dropped = preTokens - postTokens; assumed to be re-read from cache (0.1x) on every later call, up to `savingsMaxCalls` (default 50) calls. The /compact request itself (whole context read once at 0.1x, summary written at 5x, measured from the summary message) is subtracted, floored at 0 (0.4.1).
- **Clear after a hint**: `handoff_restore` with source `clear` whose new `from_session` had a hint within 3 hours. Dropped = last context of the old session - first context of the new one; same re-read assumption. A clear costs nothing.
- **Excluded** (only counted): auto compacts, manual compacts or clears with no hint, clears recorded before `from_session` existed ("unlinked"), and anything whose usage cannot be resolved.

## v0.4.2: topic-check line (trial)
Above the topic-gate threshold (`gateAtTokens`, 200k by default), a prompt gets one short line asking Claude to offer a clear (with "Clear" / "Keep going" buttons and a handoff note) if the request is a different topic. No idle gap or folder change is needed, and no LLM is called: Claude judges the topic while reading the prompt anyway. Since 0.4.5 the line waits for the context to grow by `topicCheckStepTokens` (50k) before it comes back, because each line stays in the context and is re-read on every later call (`0` = every prompt, as before). After Claude offers a clear, the line stays quiet until the context grows by `renotifyGrowthTokens`. `"topicCheck": false` turns it off. `/token-stamina:savings` reports the line's own cost (it is re-read on later calls) and subtracts it from the total, next to the compacts and clears that followed such a line.


## Privacy and what runs on your machine
Token Stamina works locally. It sends no telemetry and calls no LLM. Its only network connection is the update check: at most once a day, one HTTPS GET of `https://raw.githubusercontent.com/token-stamina/token-stamina/main/.claude-plugin/plugin.json`, which sends nothing beyond the request itself (GitHub sees your IP address, as with any download); `"updateCheck": false` turns it off. Two things it starts can use the network on their own: `claude plugin list` (audit only) and your own `wrap` command. Hint lines and restored handoff notes are added to the conversation, so Claude Code sends them to the model like any other context.

**What it reads**
- `~/.claude/projects/**/*.jsonl` (your session transcripts): for usage totals per model (`report`, `savings`, including subagent transcripts), the current context size, what the last turn did (commit, edit, final answer), whether a clear was already offered, MCP/skill usage counts (`audit`), the first call's size (fixed-cost estimate), and the auto-compact point (up to 40 recent transcripts under 64 MB, read in full). Only derived numbers and names are kept (see `audit-cache.json` and `compact-point.json` below), plus the handoff note.
- Status line input from Claude Code (`rate_limits`, context size, session id, working folder) and each prompt's text (only to detect its language; the text is not stored). The subagent hook reads `model:` from `.claude/agents/<name>.md` (project and user) and the first 600 characters of a subagent prompt to choose a model; neither is stored.
- For `/token-stamina:audit`: the text of your always-loaded files (`CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` in the folder and its parents, and the project `MEMORY.md`), used only to count characters; the plugin list (`claude plugin list`, or `settings.json` `enabledPlugins` and `plugins/installed_plugins.json`); and MCP server **names** from `~/.claude.json` and `.mcp.json` files (no keys or values are copied).

**What it writes**
- Its own files live under `~/.claude/token-stamina/` (override with `TOKEN_STAMINA_HOME`): `state.json`; `events.jsonl` (append-only and never pruned: session ids, token counts, which hint fired, subagent model decisions); per-session bookkeeping (`topic-gate.json` including the working folder, `boundary.json`, `nudge.json`, `lang.json`, `first-run.json` (when the one-time setup question was asked) with a language per session; each keeps the last 50 sessions); caches (`audit-cache.json` with transcript paths and MCP/skill names, `compact-point.json`); `config.json` (your settings); `handoff/`.
- `handoff/` notes hold **text from your session**: the working folder path and session id, up to the last 3 requests (clipped to 200 characters each), commit subjects (or the start of the commit command when no subject can be parsed), edited file paths and to-do items, capped by `handoffMaxTokens`. A `<session>.json` sidecar keeps up to 40 commit subjects and file paths. When the context is large, Token Stamina also asks Claude to write its own note (`<session>.claude.md`, free text, no cap). Notes are restored into the conversation after `/compact` or `/clear`. Files older than 7 days are deleted the next time the Stop hook runs. `"handoff": false` stops writing and restoring notes but does not delete existing ones; to stop Claude-written notes too, also set `"topicGate": false`, `"topicCheck": false` and `"inlineCompactHint": false`.
- The one-time setup question only reads `statusLine` in `~/.claude/settings.json` to see whether setup already ran. The update check stores the newest published version and when it checked in `update-check.json`, and the last announced version in `first-run.json`. At startup the launcher `token-stamina-statusline.js` is rewritten if it exists and is out of date.
- Outside that folder, only `/token-stamina:setup` changes anything, and only after you agree. `scripts/setup-statusline.js` points `statusLine` in `~/.claude/settings.json` at the launcher after saving `~/.claude/settings.json.bak-token-stamina-<timestamp>`. `scripts/setup-compact.js` sets `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` after saving `~/.claude/settings.json.bak-token-stamina-<timestamp>`. If you accept, a `/compact` keybinding is added to `~/.claude/keybindings.json`.

**Commands it runs**
- `claude plugin list --json` and `claude plugin details <id>` (audit only, with a shell; the plugin id is checked against a strict character set first).
- `node scripts/update-check.js` (at startup, at most once a day, detached in the background, no shell).
- If you set `wrap` in the config, the status line runs **that command, with a shell, on every status refresh**, passing it Claude Code's status line input. Treat `wrap` like any startup script: only put a command there that you trust.

To remove everything: uninstall the plugin, delete `~/.claude/token-stamina/` (or your `TOKEN_STAMINA_HOME`), remove `statusLine` and `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` from `~/.claude/settings.json` (or restore a `settings.json.bak-token-stamina-*` backup), and drop the keybinding if you added one.

## Support
Token Stamina is free. Coffee-money support is welcome at [ko-fi.com/tokenstamina](https://ko-fi.com/tokenstamina). Project site: [tokenstamina.com](https://tokenstamina.com).

## License
MIT. See `LICENSE`.
