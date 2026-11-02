// SessionStart hook: ask once (ever) to run /token-stamina:setup when the status line isn't ours
// yet. Ported from scripts/setup-nudge.js.
//
// The original's `classify(settingsPath)` mixes pure classification with an inline
// `fs.readFileSync` (and ENOENT-vs-other-error discrimination). Per the same pattern used for
// `agent-model.ts`'s `definitionHasModel`, this port keeps an impure default `classify()` that
// still calls `node:fs` directly (for local/Node-native verification on this PC), and factors the
// actual decision into a pure `classifyText(raw, readErrorCode)` that takes the already-attempted
// read's outcome as explicit parameters. Whether a mods hook sandbox permits direct `node:fs`
// access (as opposed to only `$.fs`, which per PLAN §1 caps reads at 4 MiB with no partial reads --
// moot here since settings.json is tiny) is the same open question flagged in agent-model.ts; if
// not permitted, register.ts should call `classifyText` directly with data fetched via `$.fs`.
//
// `flagFile()` similarly stays impure (uses `pace.home()`'s equivalent, inlined here since this
// port has no pace.js dependency) but a pure `flagFileName(dir)` variant is exported too, matching
// the `handoff.ts` `sessionFileName(dir, ...)` pattern, in case register.ts needs to supply `dir`
// explicitly (e.g. from `$.fs` home-dir resolution rather than `node:os`).

import { joinPath } from './text.ts';

export const MSG: Record<string, string> = {
  en: 'Token Stamina: run /token-stamina:setup once to wire the status line, pacing nudges, and auto-handoff for this install.',
  ko: 'Token Stamina: /token-stamina:setup 를 한 번 실행하면 이 설치에 상태줄·속도 알림·자동 인계가 연결돼요.',
};

export function message(lang: string | undefined): string {
  return MSG[lang as string] || MSG.en;
}

// Default location of the user's settings.json. Impure (node:os/path); register.ts may supply its
// own `dir` via `$.fs`'s home-dir resolution instead of calling this.
export function defaultSettingsPath(homeDir: string): string {
  return joinPath(homeDir, '.claude', 'settings.json');
}

// True when `command` is (recognizably) our own statusline.js -- either the literal
// ${CLAUDE_PLUGIN_ROOT} template written by /token-stamina:setup, or an already-resolved path
// containing the product name. Pure.
export function isOurCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const c = command.toLowerCase();
  return c.includes('statusline.js') && (c.includes('claude_plugin_root') || c.includes('token-stamina'));
}

export type Classification = 'ours' | 'other' | 'ambiguous';

// Pure core: given the outcome of an already-attempted read of settings.json (either its raw text,
// or a read-error code when the read failed), classify the status-line ownership.
//   - read failed with ENOENT (no file at all) -> 'other' (eligible for the nudge)
//   - read failed with any other error -> 'ambiguous' (never nag on a detection gap)
//   - raw is not valid JSON, or parses to a non-object -> 'ambiguous'
//   - settings.statusLine is undefined/null (no status line configured) -> 'other'
//   - settings.statusLine is present but has an unexpected shape (not an object, or `.command` is
//     not a string) -> 'ambiguous'
//   - otherwise -> 'ours' if isOurCommand(statusLine.command), else 'other'
export function classifyText(raw: string | null | undefined, readErrorCode?: string | null): Classification {
  if (raw === null || raw === undefined) {
    return readErrorCode === 'ENOENT' ? 'other' : 'ambiguous';
  }
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    return 'ambiguous';
  }
  if (!settings || typeof settings !== 'object') return 'ambiguous';
  const sl = (settings as Record<string, unknown>).statusLine;
  if (sl === undefined || sl === null) return 'other';
  if (typeof sl !== 'object') return 'ambiguous';
  const command = (sl as Record<string, unknown>).command;
  if (typeof command !== 'string') return 'ambiguous';
  return isOurCommand(command) ? 'ours' : 'other';
}

// The original's `classify(settingsPath)` read the file itself. The hooks module has no node:fs,
// so the caller reads it and passes the text (or the read error's code).
export function classify(raw: string | null, readErrorCode: string | null): Classification {
  return classifyText(raw, readErrorCode);
}

export interface DecideResult { show: boolean; reason: string }

// Pure. already shown (ever, globally) wins over everything; otherwise nudge only when the status
// line looks like someone else's (or none at all).
export function decide(cls: Classification, alreadyShown: boolean): DecideResult {
  if (alreadyShown) return { show: false, reason: 'already_shown' };
  if (cls === 'ours') return { show: false, reason: 'ours' };
  if (cls === 'ambiguous') return { show: false, reason: 'ambiguous' };
  return { show: true, reason: 'other' };
}

// Pure path builder, `dir` explicit (mirrors handoff.ts's sessionFileName(dir, ...) pattern) for
// register.ts call sites that resolve the data dir via `$.fs` rather than `node:os`/pace.home().
export function flagFileName(dir: string): string {
  return joinPath(dir, 'setup-nudge.json');
}

// ---- Usage Advisor card texts of scripts/first-run.js (ADV_CARD / ADV_AUTO_ONLY). Only the two pure text tables
// are ported; first-run's advisorStep (schedule.json / pending.json / lock files / detached spawn of
// usage-advisor.js, and advisorContext's `node ... revert` lines) is Node-only: the mod's weekly check lives in the
// advisor-* modules and register.ts (DESIGN-usage-advisor-mod.md, decision 2).
export const ADV_CARD: Record<string, (n: number) => string> = {
  en: (n) => `Token Stamina advisor: ${n} usage suggestion${n === 1 ? '' : 's'} from the weekly check. Claude will offer to review ${n === 1 ? 'it' : 'them'}.`,
  ko: (n) => `Token Stamina 어드바이저: 주간 점검에서 사용량 제안 ${n}건이 나왔어요. Claude가 확인할지 물어봐요.`,
  ja: (n) => `Token Stamina アドバイザー: 週次チェックで使用量の提案が${n}件あります。Claude が確認するか尋ねます。`,
};
export const ADV_AUTO_ONLY: Record<string, string> = {
  en: 'Token Stamina advisor: the weekly check changed a setting automatically. Claude will tell you how to undo it.',
  ko: 'Token Stamina 어드바이저: 주간 점검이 설정을 자동으로 바꿨어요. Claude가 되돌리는 방법을 알려줘요.',
  ja: 'Token Stamina アドバイザー: 週次チェックが設定を自動で変更しました。元に戻す方法は Claude が案内します。',
};
// n suggestions -> ADV_CARD; none (auto-applied only) -> ADV_AUTO_ONLY. Same choice as first-run.js advisorStep.
export function advisorCardMessage(n: number, lang: string | undefined): string {
  return n ? (ADV_CARD[lang as string] || ADV_CARD.en)(n) : (ADV_AUTO_ONLY[lang as string] || ADV_AUTO_ONLY.en);
}

// NOTE: the original module's impure `run(raw, settingsPath)` orchestration (reads stdin, calls
// lang.withLang(pace.loadConfig(), input), checks cfg.setupNudge === false, reads/writes the flag
// file via pace.readJson/writeJson, calls classify + decide, appends an event, and formats the
// final hookSpecificOutput JSON via pace.attributed(message(cfg.lang), ...)) is NOT ported here --
// that is register.ts's `classic.SessionStart` handler's job (desktop-only, unverified on this PC).
