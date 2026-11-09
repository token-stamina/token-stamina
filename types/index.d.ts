export type RecentBand = { lines: string[]; ko: boolean };
// The previous (just-cleared) session, for /ts-recall and the "previous chat" button.
export type Recall = { from: string; transcript: string; ko: boolean; key: string; left: number };
export type ClearButton = { on: boolean; ko: boolean };
// What the band chip needs besides the live usage: the switches, the language, the data folder and the pace settings.
export type BandExtra = { compact: boolean; chip: boolean; ko: boolean; home: string; pace: Record<string, unknown> };

declare module 'claude-code' {
  interface PluginState {
    'token-stamina': { band: RecentBand | null; isOpen: boolean; isGone: boolean; recall: Recall | null; recallGone: string; clearBtn: ClearButton | null; bandExtra: BandExtra | null };
  }
}
