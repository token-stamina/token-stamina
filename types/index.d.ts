export type RecentBand = { lines: string[]; ko: boolean };

declare module 'claude-code' {
  interface PluginState {
    'token-stamina': { band: RecentBand | null; isOpen: boolean; isGone: boolean };
  }
}
