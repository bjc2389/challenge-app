-- Initial schema (SPEC.md §8).
-- STRICT tables. Booleans are INTEGER 0/1. Times are INTEGER UTC epoch milliseconds.
-- No ON DELETE CASCADE: deleting a game is an explicit batch that clears
-- winner_team_id, then task_events, team_tasks, game_tasks, teams and games.

-- Catalog, synced from catalog/catalog.json on every deploy. Rows are never
-- deleted, only marked inactive.
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  count_per_game INTEGER NOT NULL CHECK (count_per_game >= 1),
  is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

CREATE TABLE catalog_tasks (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories (id),
  text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

CREATE INDEX catalog_tasks_category_active ON catalog_tasks (category_id, active);

-- Games. `code` is the public ID; `id` is internal.
CREATE TABLE games (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'setup'
    CHECK (status IN ('setup', 'rolled', 'active', 'finished', 'abandoned')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  rolled_at INTEGER,
  started_at INTEGER,
  ends_at INTEGER,
  ended_at INTEGER,
  -- Null unless finished. An abandoned game has no end reason.
  end_reason TEXT CHECK (end_reason IN ('completed', 'timeout')),
  winner_team_id INTEGER REFERENCES teams (id)
) STRICT;

-- Finds active games past ends_at for the timeout sweep.
CREATE INDEX games_status_ends_at ON games (status, ends_at);
-- History lists finished and abandoned games, newest first, without test games.
CREATE INDEX games_is_test_ended_at ON games (is_test, ended_at);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games (id),
  slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
  name TEXT NOT NULL,
  UNIQUE (game_id, slot)
) STRICT;

-- Task text is copied in when a game is rolled, so catalog edits never change it.
CREATE TABLE game_tasks (
  id INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games (id),
  catalog_task_id TEXT NOT NULL REFERENCES catalog_tasks (id),
  category_id TEXT NOT NULL REFERENCES categories (id),
  text TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_final INTEGER NOT NULL CHECK (is_final IN (0, 1)),
  UNIQUE (game_id, sort_order),
  UNIQUE (game_id, catalog_task_id)
) STRICT;

-- At most one final task per game.
CREATE UNIQUE INDEX game_tasks_one_final ON game_tasks (game_id) WHERE is_final = 1;

-- completed_at is null while the task is not done.
CREATE TABLE team_tasks (
  team_id INTEGER NOT NULL REFERENCES teams (id),
  game_task_id INTEGER NOT NULL REFERENCES game_tasks (id),
  completed_at INTEGER,
  PRIMARY KEY (team_id, game_task_id)
) STRICT;

CREATE INDEX team_tasks_game_task ON team_tasks (game_task_id);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games (id),
  team_id INTEGER NOT NULL REFERENCES teams (id),
  game_task_id INTEGER NOT NULL REFERENCES game_tasks (id),
  action TEXT NOT NULL CHECK (action IN ('complete', 'undo')),
  at INTEGER NOT NULL
) STRICT;

CREATE INDEX task_events_game_at ON task_events (game_id, at, id);
