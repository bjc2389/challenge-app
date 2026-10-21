import { ApiError } from "../apiError";

// Friendly text for API errors (SPEC.md §10). Validation and catalog messages are
// already written for players, so they pass through.
const MESSAGES: Record<string, string> = {
  not_found: "No game with that code",
  invalid_state: "That can't be done right now",
  game_over: "This game is over",
  final_locked: "Finish every other task first",
  final_not_undoable: "The final task can't be undone",
  busy: "Lots of taps at once. Try again.",
};
const PASS_THROUGH = new Set(["validation", "catalog_incomplete"]);
const GENERIC = "Something went wrong";

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (PASS_THROUGH.has(err.code)) return err.message;
    return MESSAGES[err.code] ?? GENERIC;
  }
  // fetch rejects with a TypeError when the network is down.
  if (err instanceof TypeError) return "Can't reach the server. Check your connection.";
  return GENERIC;
}
