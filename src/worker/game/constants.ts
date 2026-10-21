// Game constants (SPEC.md §4). The 60-minute limit is fixed in code, not configurable.
export const GAME_DURATION_MS = 60 * 60 * 1000;

// Game codes skip characters that are easy to confuse: 0/O, 1/I/L.
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;
export const MAX_CODE_ATTEMPTS = 5;

export const TEAM_NAME_MAX = 24;
export const DEFAULT_TEAM_NAMES = ["Team 1", "Team 2"] as const;
