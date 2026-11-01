<p><img src="docs/logo.svg" alt="" width="72"></p>

# Token Stamina

**Requires Claude Code 2.1.308 or later.** Older versions cannot load the plugin; run `claude update` first.

Token Stamina turns your Claude Code pace into action. It compares weekly (7d) and 5-hour usage with how much of each window has passed, grades it green, yellow or red, and when you're well ahead of pace moves subagent calls to cheaper models. At work boundaries in long conversations it suggests a compact and saves a handoff note first. It makes no LLM calls and no network requests.

Since 0.6.0 it runs inside Claude Code as a hooks module (a "mod"). No Node.js is needed.

**Local only.** Token Stamina reads your Claude Code session records on your machine to work out usage. It sends no telemetry, never uploads your transcripts and makes no network requests at all. Details: [privacy policy](https://tokenstamina.com/privacy.html).

**Works alongside** tools that shrink what a single task reads (command-output filters, code-graph MCP servers). Token Stamina doesn't compete with them: it adjusts models and compact timing to your limit pace. We haven't tested every combination; if you see a conflict, open an issue.

> **Unofficial.** Token Stamina is an independent, community-made plugin for Claude Code. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, PBC and are used only to say what this plugin works with. The 7d/5h percentages come from Claude Code's own usage reading. Everything Token Stamina derives from them (grades, today's share, exhaustion time) and every savings figure is a local estimate based on assumptions, not a bill or an official usage number.

## Install

```
claude plugin marketplace add token-stamina/token-stamina
claude plugin install token-stamina@token-stamina
```

Adding the marketplace alone does not install the plugin; run both. Then start a new Claude Code session (sessions already open do not see the plugin). The status row appears by itself after the first response in a session; there is nothing to set up.

`/token-stamina:setup` is optional. It sets the language of the hints, cleans up the old status line entry left by 0.5.x, explains the subagent model default and offers an auto-compact point. It previews every file edit and waits for your yes.

### Updating

Claude Code does not auto-update third-party marketplaces unless you turn it on: `/plugin` → Marketplaces → `token-stamina` → enable auto-update. To update by hand:

```
claude plugin marketplace update token-stamina
claude plugin update token-stamina@token-stamina
```

then restart Claude Code. The plugin does not check for new versions by itself.

## What it does

- **Status row**: drawn by the plugin itself, e.g. `7d 84% · today 5.3% 🟡 · reset Mon 15:00 · ctx 41%`. It does not touch your `statusLine` setting and does not wrap or combine with another status line.
- **Subagent model**: while the grade is red, subagent (Agent tool) calls with no explicit model, no pinned definition model and not a fork get `haiku` (simple work) or `sonnet`. With several subagents or sessions running at once, yellow is enough. Judgment tasks (design, review, ...) are never forced; Claude gets a suggestion instead. Modes: `inject` (default), `suggest`, `off`.
- **Explicit upper-tier models**: a call that names an upper-tier model itself only gets a suggestion by default (`"explicitDowngrade": "suggest"`). `"inject"` replaces it; `"off"` leaves explicit models alone. A "keep-model" marker in the description or prompt, or a repeat of the same task soon after, is never lowered.
- **New sessions started by Claude** (desktop app, `start_session`) get the same treatment. `"sessionModelHook": false` ignores them; `"sessionModelInject": false` makes it advice-only.
- **Fleet count**: before a subagent call it counts the subagents of this session that are running now, plus other active interactive sessions. The count only adds pressure when the budget is already yellow or red. Token Stamina cannot stop or pause a running agent.
- **Pace nudge**: one line of context when the grade changes.
- **Compact hint**: once the context passes `compactAtTokens` (150k), Claude is asked to end the task with a `/compact` hint (in the desktop app, a card with buttons). A larger context gets new-session advice.
- **Topic check**: above `gateAtTokens` (200k), a prompt gets one short line asking Claude to offer a clear if the request is a different topic. It comes back only after the context grows by `topicCheckStepTokens` (50k). `"topicCheck": false` turns it off.
- **Handoff note**: saved at the end of each turn, restored after `/compact` and `/clear`, and after the desktop app's clear. Hooks cannot run `/compact` themselves; plain `/compact` is enough because the note comes back.
- **Recent turns after a clear**: the last few turns (default 3, `clearRecentTurns`; `0` = off) are shown on screen only. They are not sent to the model.
- **Skipped sessions**: headless `-p` runs and any working folder matching `excludeCwd` (case-insensitive substrings) get no Token Stamina lines.

Grades: green `u <= elapsed%`, yellow up to +10 points, red beyond or `u >= 90`. The worse of the two windows wins; a calm 5h window never upgrades a bad 7d.

## Commands

```
/ts-report                      # local usage by model, main vs subagent (default last 30 days)
/ts-report --since 2026-10-01
/ts-savings                     # estimated tokens saved (default last 7 days)
/ts-audit --days 30             # always-loaded files, plugins, MCP/skill usage, turn-off candidates
/ts-fleet --all                 # subagents running now, by model
/token-stamina:autocompact 400k # pick when auto-compact happens: 300k / 400k / 600k / default
/token-stamina:setup            # language, old status line cleanup, defaults
```

- `/ts-report` also takes `--until YYYY-MM-DD`.
- `/ts-savings` is an estimate, not billing. It reads the plugin's own event log (`events.jsonl`). `--since YYYY-MM-DD`, `--json`.
- `/ts-audit` changes nothing. `--cwd <path>`, `--days 30`, `--json`.
- The four `/ts-…` commands print a table and call no model.

Config: `~/.claude/token-stamina/config.json` overrides `config.default.json`. Set `TOKEN_STAMINA_HOME` to move the data folder.

Language: `/token-stamina:setup` asks first, or set `"lang"` yourself: `auto` (default; follows the language of your prompts), `en`, `ko`, `ja`, `zh`. The status row and screen lines have en/ko/ja text (other languages show English); lines for Claude ask it to answer in your language.

## v0.6.0

- Rewritten as a Claude Code mod: the hooks run inside Claude Code as a TypeScript hooks module. No Node.js needed. Requires Claude Code 2.1.308 or later.
- The status row is drawn by the plugin. No status line setup any more; it does not touch `statusLine` or wrap another status line.
- New command names: `/ts-report`, `/ts-savings`, `/ts-audit`, `/ts-fleet`. The old `token-stamina:` names of report, savings, fleet and audit are now `/ts-…`.
- Removed: the efficiency board and its dashboard (not in 0.6.0; they may return later), the daily update check (the plugin now makes no network requests), the first-run setup question, and the desktop usage sync hint.
- Kept: subagent model choice, compact hint, topic check, handoff note restore (including the desktop app's clear), recent turns on screen after a clear, fleet count, `excludeCwd` and headless skips.

**Upgrading from 0.5.x.** The old `statusLine` entry in `settings.json` keeps working quietly: it prints nothing of its own, and if it wrapped your own status line, that keeps running. On first start the plugin shows one on-screen line suggesting `/token-stamina:setup`, which removes the old entry and puts your own status line back.

**Known limits.**
- `/ts-report`, `/ts-savings` and `/ts-audit` skip transcript files over 4 MiB and say how many they skipped.
- `events.jsonl` is rewritten whole on each write and rotated at 3 MiB. Two sessions writing at the same instant can lose one line; a fix is planned.

History: 0.3 added the handoff note, 0.4 the savings estimate and topic check, 0.5 the fleet count, 0.6 moved everything into a mod.

## Privacy and what runs on your machine

Token Stamina works locally. It makes no network requests, sends no telemetry and calls no LLM. It starts no commands of its own. Hint lines and restored handoff notes are added to the conversation, so Claude Code sends them to the model like any other context.

**What it reads**
- Claude Code's usage reading for the session (7d and 5h percentages and reset times, context size).
- `~/.claude/projects/**/*.jsonl` (your session transcripts): usage per model (`/ts-report`, `/ts-savings`), what the last turn did (commit, edit, final answer), whether a clear was already offered, the first call's size, and MCP/skill usage counts (`/ts-audit`). Files over 4 MiB are skipped.
- Subagent metadata files Claude Code keeps there (`agent-*.meta.json`) to count running subagents, and the start of other active session transcripts to count sessions.
- Each prompt's text, only to detect its language and for the handoff note (see below).
- To choose a subagent model: the call's description and prompt, and `model:` from `.claude/agents/<name>.md` (project and user). Not stored.
- `~/.claude/settings.json`: at startup, to see whether the old 0.5.x status line entry is still there; and for `/ts-audit`, the list of enabled plugins.
- For `/ts-audit`: your always-loaded files (`CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` in the folder and its parents, the project `MEMORY.md`), only to count characters; `plugins/installed_plugins.json`; and MCP server **names** from `~/.claude.json` and `.mcp.json` (no keys or values are copied).

**What it writes**

Everything goes under `~/.claude/token-stamina/` (or `TOKEN_STAMINA_HOME`):
- `state.json`: the last usage reading.
- `events.jsonl`: session ids, token counts, which hint fired, subagent model decisions. Rotated at 3 MiB to `events-<time>.jsonl`; `events-mod.jsonl` is used if an old log is too large to read. Rotated files are not deleted.
- Per-session bookkeeping, each keeping the last 50 sessions: `nudge.json`, `boundary.json`, `topic-gate.json` (includes the working folder and prompt times), `lang.json` (a language per session).
- `explicit-downgrade.json`: repeat memory for explicit-model suggestions.
- `audit-cache.json`: transcript paths and MCP/skill names, so `/ts-audit` doesn't re-read unchanged files.
- `legacy-statusline.json`: marks that the one-time upgrade line was shown.
- `handoff/` (see below).
- `config.json` is written only by `/token-stamina:setup` or `/token-stamina:autocompact`, after you agree.

`handoff/` holds **text from your session**:
- `<session>.md` and `latest-<hash>.md`: the working folder path and session id, up to the last 3 requests (clipped to 200 characters each), commit subjects, edited file paths and to-do items, capped by `handoffMaxTokens`.
- `<session>.json`: up to 40 commit subjects and file paths, and the last `clearRecentTurns` turns (your text and Claude's reply, 140 characters each) used for the on-screen replay after a clear. `0` stores none.
- `<session>.claude.md`: a note Claude writes itself when asked to before a compact or clear (free text, no cap); `latest-<hash>.claude.md` and its `.from` file point to the newest one.
- `pending-clear-<id>.json`: a short marker left when Claude clears its own session in the desktop app; emptied once used.

Notes are **not deleted automatically** in 0.6.0. Delete the `handoff/` folder to remove them. `"handoff": false` stops writing and restoring notes but does not delete existing ones; to stop Claude-written notes too, also set `"topicGate": false`, `"topicCheck": false` and `"inlineCompactHint": false`.

Outside that folder, only `/token-stamina:setup` and `/token-stamina:autocompact` change anything, and only after you agree to a preview: `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` or the old `statusLine` entry in `~/.claude/settings.json` (a `settings.json.bak-token-stamina-<timestamp>` backup is saved first), and, if you accept, a `/compact` keybinding in `~/.claude/keybindings.json`.

To remove everything: uninstall the plugin, delete `~/.claude/token-stamina/` (or your `TOKEN_STAMINA_HOME`), remove any leftover Token Stamina `statusLine` and `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` from `~/.claude/settings.json` (or restore a `settings.json.bak-token-stamina-*` backup), and drop the keybinding if you added one.

## Support
Token Stamina is free. Coffee-money support is welcome at [ko-fi.com/tokenstamina](https://ko-fi.com/tokenstamina). Project site: [tokenstamina.com](https://tokenstamina.com).

## License
MIT. See `LICENSE`.
