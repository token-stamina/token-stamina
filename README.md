<p><img src="docs/logo.svg" alt="" width="72"></p>

# Token Stamina

**Requires Claude Code 2.1.308 or later.** Older versions cannot load the plugin; run `claude update` first.

Token Stamina turns your Claude Code pace into action. It compares weekly (7d) and 5-hour usage with how much of each window has passed, grades it green, yellow or red, and when you're well ahead of pace moves subagent calls to cheaper models. At work boundaries in long conversations it suggests a compact and saves a handoff note first. It makes no LLM calls and no network requests of its own.

Since 0.6.0 it runs inside Claude Code as a hooks module (a "mod"). No Node.js is needed.

**Local only.** Token Stamina reads your Claude Code session records on your machine to work out usage. It sends no telemetry, never uploads your transcripts and makes no network requests of its own. The optional board preview, if you set it up and run it, asks Claude to write session numbers to your own private Artifact. Details: [privacy policy](https://tokenstamina.com/privacy.html).

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
- **Pace nudge**: one line of context when the grade changes. Yellow means more than `yellowAbove` (5) points ahead of the elapsed share, red more than `yellowMargin` (10) or `redAt` (90). After an alert, `nudgeCooldownSec` (3 hours) keeps further same-or-lower grades quiet on this machine; a worse grade still alerts at once.
- **Compact hint**: once the context passes `compactAtTokens` (150k; with a context window set, the lower of 150k and 40% of it), Claude is asked to end the task with a `/compact` hint (in the desktop app, a card with buttons). A larger context gets new-session advice.
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
/token-stamina:advisor          # Usage Advisor: analyze, recommend, apply (with your yes), revert, review
/ts-advisor --days 30           # Usage Advisor report, read-only (also --json, --brief)
/token-stamina:board            # (preview) push the efficiency board to your own dashboard Artifact
```

- `/ts-report` also takes `--until YYYY-MM-DD`.
- `/ts-savings` is an estimate, not billing. It reads the plugin's own event log (`events/`, and `events.jsonl` from older versions). `--since YYYY-MM-DD`, `--json`.
- `/ts-audit` changes nothing. `--cwd <path>`, `--days 30`, `--json`.
- The `/ts-…` commands print a table or report and call no model.

Config: `~/.claude/token-stamina/config.json` overrides `config.default.json`. Set `TOKEN_STAMINA_HOME` to move the data folder.

Language: `/token-stamina:setup` asks first, or set `"lang"` yourself: `auto` (default; follows the language of your prompts), `en`, `ko`, `ja`, `zh`. The status row and screen lines have en/ko/ja text (other languages show English); lines for Claude ask it to answer in your language.

## Usage Advisor (0.6.3)

The Usage Advisor reads your local Claude Code session records (last 30 days, or `cleanupPeriodDays` if that is shorter), adds up where the usage goes, and proposes settings changes. It is deterministic arithmetic: no LLM call, no network request, and the same records give the same screen. Everything it reads and writes stays on your machine.

```
/token-stamina:advisor            # recommend (default); also: analyze, apply, revert, review
/ts-advisor                       # the same analysis and recommendations, read-only, no model
/ts-advisor --days 7 --brief      # --days N, --brief, --json
```

- `/token-stamina:advisor` modes: **analyze** (where the usage goes), **recommend** (a ranked list; items with little or no effect are listed as "no change needed"), **apply** (below), **revert** (undo the last apply or a named one), **review** (suggestions the weekly check left waiting, and anything it changed itself). A first analysis is offered in `/token-stamina:setup`.
- **Apply needs your yes for every item.** Claude shows a `before -> after` preview, then asks per item. Before anything is written, the plugin asks you itself in a Claude Code confirmation dialog (`file key: before -> after`, Apply / Skip), so a "yes" typed to Claude is not enough. A dismissed dialog, or a non-interactive (`-p`) run, writes nothing. A plan is valid for 10 minutes. The file is backed up first (`settings.json.bak-token-stamina-<time>` next to `settings.json`; config backups under `advisor/backups/`), a `settings.json` that is not valid JSON is never touched, and unrelated keys are left alone.
- **Revert** restores a value only while the file still holds what the advisor wrote.
- `/ts-advisor` has no apply option.

The rules, each evaluated on the last 7 days and confirmed on 30:

| Rule | What it looks at | Proposed change |
|---|---|---|
| R1 | Opus/Fable subagents doing implementation or simple work with no model named | `agentModelDefault` to `sonnet` (risk B) |
| R1b | The same, where the call named the model itself | `explicitDowngradePressure: always`, `explicitDowngrade: inject` (risk B) |
| R2 | Compact/clear hints that are mostly ignored | `hintTrigger: gap`, `hintMinEffectTokens`, `topicCheck` |
| R3 | Auto-compact point | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in `settings.json` (risk B) |
| R4 | Subagents left waiting over 5 minutes (prompt cache expired and rewritten) | `subagentWaitAdvice`, `subagentLongCmdAdvice` (one informational line, never blocks) |
| R5 | Sessions still on an old model | `oldModelWarn` (one notice per session) |
| R6 | Returning after more than 1 hour idle | `topicGate`, `idleGapSec` |

- **Money is an estimate.** Figures are API list-price equivalents. On a subscription you are not billed this; your plan limit fills in the same proportion.
- **Transcripts over 4 MiB cannot be read** by the plugin (a mod cannot read part of a file). They are counted by size and left out, and the screen always shows a line like `Read N of M transcript files (P% of bytes)`. They are mostly long main sessions, so main-session figures, R3 and R6 are lower bounds, and R2 is shown as information only when 25% or more of the bytes were left out. Subagent records are almost all read, so R1, R1b and R4 are close to complete.
- **Weekly re-check.** From one week after install, when a Claude Code session starts or resumes, the plugin runs the analysis in the background (it reads only `~/.claude/projects` and writes only the `advisor/` folder), keeps a history snapshot, and, if a suggestion appears in two weeks in a row, leaves it for `review` and shows one line and a card at a later session start. There is no operating-system scheduled task: if you don't open Claude Code it doesn't run, and it catches up when you do. `"advisor": false` turns the whole feature off.
- **Auto-apply is off by default.** `advisorAutoApply` lists the rules the weekly check may apply by itself. Only risk A rules that change Token Stamina's own config can be listed; `settings.json` is never written automatically. A week after any apply, a check compares before and after and may propose a fine-tune or an undo.

New config keys (`config.default.json`; your `~/.claude/token-stamina/config.json` overrides them):

| Key | Default | Meaning |
|---|---|---|
| `advisor` | `true` | Weekly background re-check at session start. `false` turns it off. The commands still work. |
| `advisorMinEffectUsd` | `5` | A suggestion saving less than this per week (API-equivalent) is listed as "no change needed". |
| `advisorAutoApply` | `[]` | Risk A rule ids the weekly check may apply by itself, for example `["R4"]`. |
| `advisorHistoryKeep` | `12` | Weekly history snapshots kept. |
| `advisorRejectCooldownSec` | `2419200` | How long a refused suggestion is not proposed again (28 days). |
| `advisorDevice` | `null` | Optional short label stored in history snapshots. |
| `advisorNotifyCommand`, `advisorExportDir` | `null` | Present for config compatibility; the mod never runs a command and has no export. |
| `explicitDowngradePressure` | `"pace"` | `always` lowers explicit upper-tier subagent models without waiting for yellow/red (used with `explicitDowngrade: "inject"`). |
| `hintTrigger` | `"always"` | `gap` shows compact/clear hints only after a real idle gap. |
| `hintMinEffectTokens` | `0` | Hints appear only when the estimated saving reaches this many tokens. |
| `subagentWaitAdvice` | `false` | One sentence per session on the first Agent call about the 5-minute cache. |
| `subagentLongCmdAdvice` | `false` | When a subagent runs a long foreground command, one informational line (once per agent per session). |
| `longCmdPatterns` | built-in list | Regular expressions that count as a long command. |
| `oldModelWarn` | `false` | One notice per session when the last assistant model is an old generation. |
| `implementationKeywords` | built-in list | Words in a subagent description that count as implementation work. |

## Efficiency board (preview, desktop app)

**Preview, not yet tested in real use.** The board is back in 0.6.1, ported to the mod. Its automated tests pass, but the refresh tab and the approval flow have not been tried end to end in the desktop app yet. Expect rough edges and report what breaks.

An optional board for people who run several sessions at once. It shows, per session, recent input size, cache hit rate, context size, running subagents and a fit hint, plus the account's limits, and lets you approve or reject suggestions from your phone. The page follows the `lang` key (`en` or `ko`; otherwise the browser language).
- It is off until you set `dashboardUrl`. Then the Stop hook writes one small row per session to `board/<session>.json` (numbers from the transcript tail; no titles). Nothing leaves your machine from the hooks. A session whose transcript is over 4 MiB gets no row (the mod cannot read files that large), and subagent token counts skip transcripts over 4 MiB.
- `/token-stamina:board` pushes those rows to a private dashboard Artifact on claude.ai through Claude's own `ArtifactData` tool. Run it in a separate Haiku session, optionally with `/loop 15m /token-stamina:board`. The plugin does the counting through its own `board` tool; Claude only passes the results along. A run whose rows did not change and that has nothing pending skips the write (at most 25 minutes between writes), and `boardDailyTokens` caps a day's cost.
- This is the one feature that sends data off your machine, and only when you run the command: the board rows (numbers, model names and the last folder name of each session's working folder), session titles (unless `"dashboardMaskTitles": true`) and the account's usage percentages go to your own private Artifact.
- To set it up, ask Claude in the desktop app to publish `dashboard/index.html` from the plugin folder as an Artifact with the `db` capability, then put its link in `dashboardUrl` in `~/.claude/token-stamina/config.json`.
- Suggestions (a lower subagent default model, a clear at a work boundary, a setting) appear as cards. `applyMode` is `"manual"` by default: nothing is applied until you press approve, and the next board run applies it. Only what the local ledger (`board/decisions.json`) proposed can be applied, at most `applyMaxPerRun` (3) per run and one per session. Clearing a session is always left to you; the board never clears one. Protected sessions are shown but never get a suggestion that changes them. Suggestions for another session's model are advice only for now.
- Config keys: `board`, `boardTailBytes`, `boardKeepSec`, `boardIdleSec`, `boardDailyTokens`, `dashboardUrl`, `dashboardMaskTitles`, `managerExcludeCwd`, `managerProtectKeywords`, `managerProtectSegments`, `applyMode`, `proposalTtlSec`, `heldTtlSec`, `rejectCooldownSec`, `applyMaxPerRun`, `savingTurns`, `agentShareProposeAt`, `agentModelDefault`. `"board": false` stops the rows.

## v0.6.10: the usage chip and Previous chat open a dialog
- **Usage chip press opens a dialog.** In 0.6.9 the press printed lines with `$.ui.log`, which did not show in the desktop app, so nothing seemed to happen. Now it opens a dialog (the same kind the Clear and Compact buttons use) on every surface. The first line says what the chip is (how much of the weekly limit is used, and the daily share left until the reset), then the numbers in sentences. The choices are Close and "Compact now", which compacts at once with no second question (the handoff note is saved first, `compact_button` recorded as for the Compact button).
- **Clearer Korean label**: `주간 한도 46% · 오늘 몫 12.6%` (was `주간 46% · …`). English stays `week 46% · today 12.6%`.
- **"Previous chat" and `/ts-recall` on the desktop** show the turns in one dialog instead of `$.ui.log` rows. The terminal is unchanged. Nothing reaches the model either way.
- No new config keys or events.

## v0.6.9: Compact button and usage chip
- **"Compact" button** (mods build, `compactButton`, default on). In the band above the prompt on the desktop app and the terminal, between the usage chip and "Clear". Pressing it saves the handoff note (the same function the Clear button uses), asks "Compact now? The chat becomes a summary." with Cancel first, and then runs `$.session.compact()`, the same call `/compact` makes, between turns. If the engine skips the compact (a hook vetoed it) or refuses it (a reply is still running), you get one line on screen and nothing is recorded. A compact that ran records `compact_button` (session id and context size only). In `/ts-savings` it is the same manual compact boundary as a typed `/compact`: counted after a plugin hint, not otherwise.
- **Usage chip** (mods build, `usageChip`, default on). A button with the week's use and today's share, for example `week 46% · today 12.6%` (`주간 46% · 오늘 몫 12.6%` in Korean), in green, yellow or red by the same pace grade as the status line. Pressing it shows on screen only (nothing goes to the model; a dialog since 0.6.10) the week's use against the time elapsed, the projected run-out time, the reset time, today's share and, when it is read, the 5-hour window. The numbers are the status line's own pace numbers. Without a fresh weekly reading the chip is not drawn.
- **Band order**: usage chip, Compact, Clear (context size), Previous chat (only right after a clear). Labels follow `lang` (Korean or English). Not drawn on mobile. Redrawing the band writes no event; only a confirmed press does.
- New config keys: `compactButton`, `usageChip`. New event: `compact_button` (`session`, `tokens_at_compact`).

## v0.6.8: your own Agent hooks come first, keep the main model for judgment, `require` mode, advisor fixes
- **Your own `PreToolUse` hook on Agent/Task wins.** If a hook in your user, project or local settings has a matcher that covers `Agent` or `Task` (an empty matcher, `*`, `Agent`, `Task`, `Agent|Task`, a regex), Token Stamina no longer rewrites the call (`respectUserAgentHooks`, default `true`). In `inject` mode it behaves as `suggest` (`require` mode is not affected, since it only refuses and never rewrites): the input stays as it was and the hook sees the original call. One `agent_model_defer` event (`reason: "user_hook"`) is written per session. Why: in the hook chain Token Stamina runs before the settings hooks, and there is no official way to try a settings hook on the original input first, so the only safe choice is to leave the input alone. Hooks of this plugin are ignored. Set `respectUserAgentHooks` to `false` to get the old behavior.
- **Keywords are an auxiliary signal.** The judgment and simple keywords (`judgmentKeywords`, `simpleKeywords`) are only a hint that a task may need the stronger model; exact judgment is the calling model's (or `require` mode's). They were not widened in this version.
- **Judgment keeps the main model.** When a judgment signal is caught and the default model the subagent would get (`CLAUDE_CODE_SUBAGENT_MODEL`, or the `model:` of the named agent definition) ranks below the main model, `judgmentKeepParent` (default `true`) puts the main model's family in `model`. With it `false`, or when the mode does not rewrite input, you get one warning line of at most 60 tokens. New event reason: `judgment_keep_parent` / `judgment_below_parent`.
- **`require` mode.** `subagentMode: "require"` refuses an Agent/Task call that names no model (and is not a fork or an agent definition that pins one) with the official PreToolUse deny. The reason is at most 120 tokens (English or Korean): the models to pick from, a pace sentence (for example "7d red -> sonnet advised") and the four judgment questions (does a fixed procedure give the answer, stop or interpret when it is unexpected, does the result go out as it is, is a mistake hard to undo; if yes to any, say so in the model choice or split the task in two). `require` is for Agent/Task only; a session start can only be `off`, `suggest` or `inject`.
- **`subagentMode` and `sessionMode`.** `subagentMode` (Agent/Task) and `sessionMode` (start_session) each take `off`, `suggest`, `inject` (`subagentMode` also `require`). When one is `null` or unset, `mode` is used, as before. A user hook turns `inject` into `suggest`; `require` still refuses, because it changes no input.
- **Advisor `analyze` returns a string.** The `advisor` and `board` tools now return text (a JSON string when `json` is true) instead of an object, which the engine rejected as an output-shape mismatch (`invalid_union`). Errors come back as a denial with the message.
- **Big main transcripts are read, not skipped.** `analyze` streams a transcript over 4 MiB through `scripts/transcript-slim.js --adv` (usage rows, Agent/Task calls, compact boundaries, the first prompt), whatever its size, within its own time budget. If something is still skipped, the first line of the result says `Skipped N file(s) (X% of all bytes).` (`건너뜀 N개(전체의 X%)` in Korean).
- New config keys: `subagentMode`, `sessionMode`, `respectUserAgentHooks`, `judgmentKeepParent`. New event: `agent_model_defer`.

## v0.6.7: shorter real-path lines, fewer repeat hints on big windows, clear and recall buttons
- **Line caps with the real path.** The injected lines are measured with the real handoff path (about 90 characters, home folder shortened to `~`): the first hint is at most 170 tokens, later hints and the topic check and gate lines at most 90, the pace alert at most 80, in English and Korean. The savings estimate goes in the first hint only. The tests use a real-length path.
- **Fewer repeat hints on big windows.** A repeat hint needs the context to grow by at least `max(100k, 10% of compactWindowTokens)` since the previous hint, and at most 5 hints are given per context. The counter starts over after a compact or clear. The first hint point is unchanged.
- **Big transcripts in `/ts-savings`.** A transcript over 4 MiB is no longer skipped: `scripts/transcript-slim.js` streams it (one pass, flat memory, no size limit) and keeps only the rows the estimate reads. It needs `node` on the PATH; without it the old skip behaviour remains.
- **`pace_sample` event.** At most one per hour: week and 5-hour percentages, their reset times and the pace grade. Numbers only.
- **Transcript line in the handoff note.** `- transcript: ~/.claude/projects/<project>/<session>.jsonl` (omitted when Claude Code gives no path), so a later session can open the old conversation when you ask it to.
- **`/ts-recall [words]` and the "Previous chat" button** (mods build). Shows on screen the last 6 turns of the session you just cleared (your messages and Claude's text only, nothing is sent to the model); words filter them (at most 10 matches). The button sits in the band above the prompt on the desktop app and the terminal right after a clear and goes after one press or 5 prompts. Not shown on mobile. Checked in the terminal; not yet on the desktop app.
- **"Clear" button** (mods build, `clearButton`, default on). Always in the band above the prompt on the desktop app and the terminal, with the context size in the status line's style (`209k`, `21만`). Pressing it saves the handoff note (the same function as the Stop hook), asks "Clear now?" with Cancel first, and then clears. It runs the built-in `/clear` (checked in the terminal); if a Claude Code version refuses that, the button puts `/clear` in the prompt box, or prints a one-line instruction. A confirmed press records `clear_button` (context size only) and leaves a one-time marker, so the saved note (your Claude note if there is a fresh one, else the auto note) comes back in the cleared session, and the restore is counted as a clear in `/ts-savings`. Buttons never add anything to the model's context.
- New config key: `clearButton`. New event: `clear_button`; new file `recall.json` (the last button-clear: session id, transcript path, time, context size).

## v0.6.6

- **Pace alerts are calmer.** Yellow now needs usage more than `yellowAbove` (default 5) points ahead of the elapsed share of the window. Within `nudgeCooldownSec` (default 10800, 3 hours) after an alert, a second session or a yellow/red flip-flop stays silent; a worse grade (yellow to red) still alerts at once. `yellowMargin` is now documented as the red margin.
- **Clearer alert wording.** Every percentage is "of the weekly (or 5-hour) limit". The weekly red line says when the limit runs out at this rate and the daily share that lasts to the reset.
- **Earlier context hints.** With a context window configured, the compact hint is at the lower of 40% of the window and 150k, and the topic gate at the lower of 50% and 200k (a 600k window: 150k and 200k, not 240k and 300k). New-session advice stays at 95%. To keep a later hint, set `compactAtTokens` (and `gateAtTokens`) in `config.json`; an explicit value wins.
- **Shorter injected lines.** The first compact hint in a session is full text (about 170 tokens at most); later hints, the topic check and the gate are one short sentence (about 90 tokens at most). The size limits are fixed by tests.
- **Attribution line in `/ts-savings`.** Separates clears that followed a plugin hint (within 3 hours) from clears done without one, with the average context size of each, markers that were not restored, and the count and token cost of injected lines. It shows how much the plugin prompted; it does not estimate what would have happened without it. The "clear after a hint" part now also counts the desktop app's clears.
- **Clear handoff diagnostics.** A clear marker that is found but not restored (expired, own session, invalid, no note) is now recorded as a `handoff_drop` event, and a marker already used in this process is never injected twice, even if writing it back fails.
- **Leftover `.tmp` files.** The old Node status line writer retries a failed rename and always removes its temp file; `/ts-audit` reports leftover `*.<pid>.tmp` files in the data folder (safe to delete).
- **Board stays a preview and opt-in.** Nothing is written until you set `dashboardUrl`; each refresh through `/token-stamina:board` costs the tokens of one Haiku session.
- New config keys: `yellowAbove`, `nudgeCooldownSec`. New event fields: see Privacy.

## v0.6.5

- No behavior change. A byte-order mark in the settings writer is now spelled as an escape (`\uFEFF`) instead of an invisible character, the website icon is a PNG instead of an `.ico`, and the README explains for directory review which environment variables are read, which files are written and that no hook makes a permission decision.

## v0.6.4

- Code form only, no behavior change: calls that hand `$` to a helper no longer carry TypeScript type arguments, so the plugin directory's static check can read them.

## v0.6.3

- New: Usage Advisor. `/token-stamina:advisor` and the read-only `/ts-advisor` (see above): analysis of the last 30 days, rules R1 to R6, per-item apply with a confirmation dialog and backups, revert, a weekly background re-check at session start, and new config keys. `/token-stamina:setup` offers a first analysis.
- Transcripts over 4 MiB are counted and left out of the advisor's figures; the screen says so.

## v0.6.2

- After a clear in the desktop app, the last few turns of the old session now show in a band above the prompt (Expand / Collapse / Close) until your first prompt. They are on screen only and are not sent to the model.
- Fixes from an adversarial review of 0.6.1.

## v0.6.1

- Event log: each session now writes its own file under `events/`, so two sessions writing at the same moment no longer lose each other's lines. The same session open in two windows at once can still collide.
- Handoff files unchanged for 7 days are emptied (the plugin cannot delete files, so empty file names remain).
- The efficiency board returns as a preview (above).

## v0.6.0
- Rewritten as a Claude Code mod: the hooks run inside Claude Code as a TypeScript hooks module. No Node.js needed. Requires Claude Code 2.1.308 or later.
- The status row is drawn by the plugin. No status line setup any more; it does not touch `statusLine` or wrap another status line.
- New command names: `/ts-report`, `/ts-savings`, `/ts-audit`, `/ts-fleet`. The old `token-stamina:` names of report, savings, fleet and audit are now `/ts-…`.
- Removed: the efficiency board and its dashboard (not in 0.6.0; they may return later), the daily update check (the plugin now makes no network requests), the first-run setup question, and the desktop usage sync hint.
- Kept: subagent model choice, compact hint, topic check, handoff note restore (including the desktop app's clear), recent turns on screen after a clear, fleet count, `excludeCwd` and headless skips.

**Upgrading from 0.5.x.** The old `statusLine` entry in `settings.json` keeps working quietly: it prints nothing of its own, and if it wrapped your own status line, that keeps running. On first start the plugin shows one on-screen line suggesting `/token-stamina:setup`, which removes the old entry and puts your own status line back.

**Known limits.**
- `/ts-report`, `/ts-savings` and `/ts-audit` skip transcript files over 4 MiB and say how many they skipped.

History: 0.3 added the handoff note, 0.4 the savings estimate and topic check, 0.5 the fleet count, 0.6 moved everything into a mod.

## Privacy and what runs on your machine

Token Stamina works locally. It makes no network requests of its own, sends no telemetry and calls no LLM. The one exception you can turn on is the board preview: `/token-stamina:board` asks Claude to write board rows to your own private Artifact (see above). It starts no commands of its own. Hint lines and restored handoff notes are added to the conversation, so Claude Code sends them to the model like any other context.

**What it reads**
- Claude Code's usage reading for the session (7d and 5h percentages and reset times, context size).
- `~/.claude/projects/**/*.jsonl` (your session transcripts): usage per model (`/ts-report`, `/ts-savings`), what the last turn did (commit, edit, final answer), whether a clear was already offered, the first call's size, and MCP/skill usage counts (`/ts-audit`). Files over 4 MiB are skipped.
- Subagent metadata files Claude Code keeps there (`agent-*.meta.json`) to count running subagents, and the start of other active session transcripts to count sessions.
- Each prompt's text, only to detect its language and for the handoff note (see below).
- To choose a subagent model: the call's description and prompt, and `model:` from `.claude/agents/<name>.md` (project and user). Not stored.
- `~/.claude/settings.json`: at startup, to see whether the old 0.5.x status line entry is still there; for `/ts-audit`, the list of enabled plugins; and for the Usage Advisor, `cleanupPeriodDays` and the auto-compact setting.
- Usage Advisor: the same `~/.claude/projects/**/*.jsonl` transcripts, only the usage numbers, model names, timestamps, tool and subagent call counts and sizes of each call. Text, file paths and ids are classified in memory and dropped; ids are kept only as salted hashes. Files over 4 MiB are not read. It sends nothing anywhere.
- For `/ts-audit`: your always-loaded files (`CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` in the folder and its parents, the project `MEMORY.md`), only to count characters; `plugins/installed_plugins.json`; and MCP server **names** from `~/.claude.json` and `.mcp.json` (no keys or values are copied).

**What it writes**

Everything goes under `~/.claude/token-stamina/` (or `TOKEN_STAMINA_HOME`):
- `state.json`: the last usage reading.
- `events/`: session ids, token counts, which hint fired, subagent model decisions. Since 0.6.6 the events of injected lines carry `line_tokens` (the estimated size of the line), `handoff_restore` carries `tokens_at_clear` (context size when the clear happened) and `hinted` (whether a plugin hint came first), and `handoff_drop` records a clear marker that was not restored with a `reason` (expired, own, invalid, no_note). Numbers and reasons only; no text of your sessions is recorded. Each session writes its own slot file (`s000.jsonl` to `s3ff.jsonl`, at most 1,024 slots); past 3 MiB a slot moves to its `.old.jsonl` file, replacing the previous one. A slot unused for 30 days is reused and overwritten by a new session; if every slot is taken, the one idle longest (at least a day) is reused, so older events can be lost early. Events without a session id are not recorded. Logs from 0.6.0 and earlier (`events.jsonl`, `events-<time>.jsonl`, `events-mod.jsonl`) are still read but no longer written or deleted.
- Per-session bookkeeping, each keeping the last 50 sessions: `nudge.json`, `boundary.json`, `topic-gate.json` (includes the working folder and prompt times), `lang.json` (a language per session).
- `explicit-downgrade.json`: repeat memory for explicit-model suggestions.
- `audit-cache.json`: transcript paths and MCP/skill names, so `/ts-audit` doesn't re-read unchanged files.
- `legacy-statusline.json`: marks that the one-time upgrade line was shown.
- Board preview, only after you set `dashboardUrl`: `board/` (one row per session; rows older than `boardKeepSec` are emptied, and the suggestion ledger `decisions.json`) and `board-push/` (the last batch the board command sent). `/token-stamina:board` may also update `config.json` when you approve a setting on the board, keeping the previous one in `config.prev.json`.
- `advisor/` (Usage Advisor; numbers, hashes, rule ids and setting names and values only, no text from your sessions, no paths, no session ids): `analysis-latest.json` (the last analysis), `history/` (weekly snapshots, the newest `advisorHistoryKeep`; older ones are emptied), `baseline.json` and `pending.json` (change detection and waiting suggestions), `plan.json` (the plan you are asked to approve; valid 10 minutes), `apply-log.jsonl` (each apply: item, before and after values, backup names; at 3 MiB it moves to `apply-log.old.jsonl`), `applied/` (before-and-after numbers for the one-week check), `backups/` (copies of `config.json` made before an apply), `scan-cache/` (64 small files with per-transcript numbers and hashes, so the next scan skips unchanged files), `schedule.json` (when the next weekly run is due), `salt` (a random value used for the hashes; it stays on your machine) and `weekly.lock`. Files the plugin cannot delete are emptied instead.
- `sub-wait/<session>.json`: only when `subagentLongCmdAdvice` is on; subagent ids already warned about; emptied after 2 days.
- `handoff/` (see below).
- `config.json` is written only by `/token-stamina:setup`, `/token-stamina:autocompact` or an approved `/token-stamina:advisor` item (and by the weekly check only for rules you listed in `advisorAutoApply`), after you agree.

`handoff/` holds **text from your session**:
- `<session>.md` and `latest-<hash>.md`: the working folder path and session id, up to the last 3 requests (clipped to 200 characters each), commit subjects, edited file paths and to-do items, capped by `handoffMaxTokens`.
- `<session>.json`: up to 40 commit subjects and file paths, and the last `clearRecentTurns` turns (your text and Claude's reply, 140 characters each) used for the on-screen replay after a clear. `0` stores none.
- `<session>.claude.md`: a note Claude writes itself when asked to before a compact or clear (free text, no cap); `latest-<hash>.claude.md` and its `.from` file point to the newest one.
- `pending-clear-<id>.json`: a short marker left when Claude clears its own session in the desktop app; emptied once used.

Files in `handoff/` (notes, side files and markers) unchanged for 7 days are **emptied** when a session starts: their text is overwritten with nothing, and the empty file names stay (the plugin cannot delete files). Delete the `handoff/` folder to remove everything at once. `"handoff": false` stops writing and restoring notes but does not delete existing ones; to stop Claude-written notes too, also set `"topicGate": false`, `"topicCheck": false` and `"inlineCompactHint": false`.

Outside that folder, only `/token-stamina:setup`, `/token-stamina:autocompact` and `/token-stamina:advisor` change anything, and only after you agree: `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` or the old `statusLine` entry in `~/.claude/settings.json` (a `settings.json.bak-token-stamina-<timestamp>` backup is saved first; for the advisor you approve each item in a Claude Code confirmation dialog, and it never writes `settings.json` automatically), and, if you accept, a `/compact` keybinding in `~/.claude/keybindings.json`.

To remove everything: uninstall the plugin, delete `~/.claude/token-stamina/` (or your `TOKEN_STAMINA_HOME`), remove any leftover Token Stamina `statusLine` and `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` from `~/.claude/settings.json` (or restore a `settings.json.bak-token-stamina-*` backup; the advisor's backups of `settings.json` sit next to it), and drop the keybinding if you added one.

## Notes for plugin directory review

- **Environment variables it reads.** `TOKEN_STAMINA_HOME` (and the old `TOKEN_PACER_HOME`) for its data folder; `USERPROFILE`, `HOME` and `CLAUDE_CONFIG_DIR` to find `~/.claude`; `CLAUDE_CODE_ENTRYPOINT` to tell the desktop app from the CLI; `CLAUDE_CODE_HOST_SESSION_ID`, the desktop app's id for the current session, to name the marker it leaves when Claude clears its own session; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to show when auto-compact will run. None of them is a credential, and nothing is sent anywhere.
- **Files it writes.** Only the files listed under "What it writes" above. The only files outside its own folder that other tools obey are `~/.claude/settings.json` and `~/.claude/keybindings.json`, and they are written only by `/token-stamina:setup`, `/token-stamina:autocompact` and `/token-stamina:advisor` after you approve the change, with a backup first. The write helper takes a path variable because file names carry per-session slots; every path is built from the data folder or is one of those two files.
- **Permission decisions.** It never allows, denies or asks for a tool call on your behalf, and never changes the permission mode or Remote Control. Its hooks on `Bash` and `PowerShell` calls let the call run unchanged and, only when `subagentLongCmdAdvice` is on, add an advice line afterwards. Its hooks on `Agent` and `mcp__ccd_session__start_session` calls can set the `model` of the subagent or new session: that is the subagent model feature (`"mode": "inject"` by default; `"suggest"` only adds a note, `"off"` turns it off). It changes which model runs, not whether the call runs. Its `command.run` hooks answer only its own `/ts-*` commands.
- **Website files.** `docs/` is the project website (GitHub Pages), not part of the plugin's behaviour.

## Support
Token Stamina is free. Coffee-money support is welcome at [ko-fi.com/tokenstamina](https://ko-fi.com/tokenstamina). Project site: [tokenstamina.com](https://tokenstamina.com).

## License
MIT. See `LICENSE`.
