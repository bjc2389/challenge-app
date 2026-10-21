-- SPEC.md §8: end_reason and winner_team_id are set only on finished games, and
-- a finished game always has an end_reason. SQLite can't add a CHECK to an
-- existing table, so triggers enforce it. Additive: no table changes.

CREATE TRIGGER games_end_state_insert
BEFORE INSERT ON games
WHEN NOT (
  (NEW.status = 'finished' AND NEW.end_reason IS NOT NULL)
  OR (NEW.status <> 'finished' AND NEW.end_reason IS NULL AND NEW.winner_team_id IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'only finished games have an end_reason or winner, and every finished game has an end_reason');
END;

CREATE TRIGGER games_end_state_update
BEFORE UPDATE OF status, end_reason, winner_team_id ON games
WHEN NOT (
  (NEW.status = 'finished' AND NEW.end_reason IS NOT NULL)
  OR (NEW.status <> 'finished' AND NEW.end_reason IS NULL AND NEW.winner_team_id IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'only finished games have an end_reason or winner, and every finished game has an end_reason');
END;
