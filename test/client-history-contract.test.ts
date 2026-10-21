// SPEC.md §9 /history and /history/:code, §10 GET /api/history and GET /api/history/:code:
// the client's history types must match what the Worker returns. The type-level checks
// run under `npm run check` (tsc -p tsconfig.worker.json); the runtime checks hit D1.
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  HistoryDetail,
  HistoryEvent,
  HistoryItem,
  HistoryList,
  HistoryTask,
  HistoryTeam,
  RecordHolder,
} from "../src/client/history/types";
import { toHistoryDetail, toHistoryList } from "../src/worker/api/historyView";
import type { RecordHolder as WorkerRecordHolder } from "../src/worker/game/records";
import { makeDeps } from "./helpers/auth";
import { T0, resetDb } from "./helpers/db";
import { player, seedRollCatalog } from "./helpers/game";
import { getDetail, getList, redsBluesGame } from "./helpers/history";

type WorkerList = ReturnType<typeof toHistoryList>;
type WorkerDetail = ReturnType<typeof toHistoryDetail>;

// Exhaustive at compile time: a missing or extra key fails the typecheck.
const LIST_KEYS: Record<keyof HistoryList, true> = { items: true, hasMore: true, records: true };
const ITEM_KEYS: Record<keyof HistoryItem, true> = {
  code: true,
  status: true,
  startedAt: true,
  endedAt: true,
  elapsedMs: true,
  endReason: true,
  winnerTeamId: true,
  teams: true,
};
const ITEM_TEAM_KEYS: Record<keyof HistoryItem["teams"][number], true> = { id: true, slot: true, name: true, score: true };
const RECORDS_KEYS: Record<keyof HistoryList["records"], true> = { fastestWin: true, fastestPuzzle: true, gamesPlayed: true };
const HOLDER_KEYS: Record<keyof RecordHolder, true> = { code: true, teamName: true, ms: true, endedAt: true };
const DETAIL_KEYS: Record<keyof HistoryDetail, true> = { game: true, teams: true, tasks: true, events: true };
const DETAIL_GAME_KEYS: Record<keyof HistoryDetail["game"], true> = {
  code: true,
  status: true,
  createdAt: true,
  startedAt: true,
  endsAt: true,
  endedAt: true,
  endReason: true,
  winnerTeamId: true,
  elapsedMs: true,
};
const DETAIL_TEAM_KEYS: Record<keyof HistoryTeam, true> = { id: true, slot: true, name: true, score: true, puzzleMs: true };
const DETAIL_TASK_KEYS: Record<keyof HistoryTask, true> = {
  id: true,
  sortOrder: true,
  categoryName: true,
  text: true,
  isFinal: true,
  splitMs: true,
};
const EVENT_KEYS: Record<keyof HistoryEvent, true> = {
  id: true,
  at: true,
  sinceStartMs: true,
  teamId: true,
  taskId: true,
  action: true,
};
const sorted = (o: object) => Object.keys(o).sort();

describe("§10 HistoryList: client type equals the worker's toHistoryList", () => {
  it("type level, nested types too", () => {
    expectTypeOf<WorkerList>().toEqualTypeOf<HistoryList>();
    expectTypeOf<WorkerList["items"][number]>().toEqualTypeOf<HistoryItem>();
    expectTypeOf<WorkerList["items"][number]["teams"][number]>().toEqualTypeOf<HistoryItem["teams"][number]>();
    expectTypeOf<WorkerList["records"]>().toEqualTypeOf<HistoryList["records"]>();
    expectTypeOf<NonNullable<WorkerList["records"]["fastestWin"]>>().toEqualTypeOf<RecordHolder>();
    expectTypeOf<NonNullable<WorkerList["records"]["fastestPuzzle"]>>().toEqualTypeOf<RecordHolder>();
    expectTypeOf<WorkerRecordHolder>().toEqualTypeOf<RecordHolder>();
    expectTypeOf<HistoryList["records"]["fastestWin"]>().toEqualTypeOf<RecordHolder | null>();
    expectTypeOf<HistoryItem["status"]>().toEqualTypeOf<"finished" | "abandoned">();
    expectTypeOf<HistoryItem["elapsedMs"]>().toEqualTypeOf<number | null>();
  });

  it("the documented key lists are the plan's", () => {
    expect(sorted(LIST_KEYS)).toEqual(["hasMore", "items", "records"]);
    expect(sorted(ITEM_KEYS)).toEqual(
      ["code", "elapsedMs", "endReason", "endedAt", "startedAt", "status", "teams", "winnerTeamId"],
    );
    expect(sorted(ITEM_TEAM_KEYS)).toEqual(["id", "name", "score", "slot"]);
    expect(sorted(RECORDS_KEYS)).toEqual(["fastestPuzzle", "fastestWin", "gamesPlayed"]);
    expect(sorted(HOLDER_KEYS)).toEqual(["code", "endedAt", "ms", "teamName"]);
  });
});

describe("§10 HistoryDetail: client type equals the worker's toHistoryDetail", () => {
  it("type level, nested types too", () => {
    expectTypeOf<WorkerDetail>().toEqualTypeOf<HistoryDetail>();
    expectTypeOf<WorkerDetail["game"]>().toEqualTypeOf<HistoryDetail["game"]>();
    expectTypeOf<WorkerDetail["teams"][number]>().toEqualTypeOf<HistoryTeam>();
    expectTypeOf<WorkerDetail["tasks"][number]>().toEqualTypeOf<HistoryTask>();
    expectTypeOf<WorkerDetail["events"][number]>().toEqualTypeOf<HistoryEvent>();
    expectTypeOf<HistoryDetail["teams"][number]>().toEqualTypeOf<HistoryTeam>();
    expectTypeOf<HistoryDetail["tasks"][number]>().toEqualTypeOf<HistoryTask>();
    expectTypeOf<HistoryDetail["events"][number]>().toEqualTypeOf<HistoryEvent>();
    expectTypeOf<HistoryTask["splitMs"]>().toEqualTypeOf<(number | null)[]>();
    expectTypeOf<HistoryEvent["action"]>().toEqualTypeOf<"complete" | "undo">();
  });

  it("the documented key lists are the plan's", () => {
    expect(sorted(DETAIL_KEYS)).toEqual(["events", "game", "tasks", "teams"]);
    expect(sorted(DETAIL_GAME_KEYS)).toEqual(
      ["code", "createdAt", "elapsedMs", "endReason", "endedAt", "endsAt", "startedAt", "status", "winnerTeamId"],
    );
    expect(sorted(DETAIL_TEAM_KEYS)).toEqual(["id", "name", "puzzleMs", "score", "slot"]);
    expect(sorted(DETAIL_TASK_KEYS)).toEqual(["categoryName", "id", "isFinal", "sortOrder", "splitMs", "text"]);
    expect(sorted(EVENT_KEYS)).toEqual(["action", "at", "id", "sinceStartMs", "taskId", "teamId"]);
  });
});

describe("§10 the real history responses have exactly the client's keys", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRollCatalog();
  });

  it("GET /api/history", async () => {
    const clock = makeDeps();
    const api = await player(clock.deps);
    await redsBluesGame(api, clock, T0);
    const body = await getList(api);
    expect(sorted(body)).toEqual(sorted(LIST_KEYS));
    expect(body.items).toHaveLength(1);
    for (const item of body.items) {
      expect(sorted(item)).toEqual(sorted(ITEM_KEYS));
      expect(item.teams).toHaveLength(2);
      for (const team of item.teams) expect(sorted(team)).toEqual(sorted(ITEM_TEAM_KEYS));
    }
    expect(sorted(body.records)).toEqual(sorted(RECORDS_KEYS));
    expect(sorted(body.records.fastestWin!)).toEqual(sorted(HOLDER_KEYS));
    expect(sorted(body.records.fastestPuzzle!)).toEqual(sorted(HOLDER_KEYS));
  });

  it("GET /api/history/:code", async () => {
    const clock = makeDeps();
    const api = await player(clock.deps);
    const g = await redsBluesGame(api, clock, T0);
    const body = await getDetail(api, g.code);
    expect(sorted(body)).toEqual(sorted(DETAIL_KEYS));
    expect(sorted(body.game)).toEqual(sorted(DETAIL_GAME_KEYS));
    expect(body.teams).toHaveLength(2);
    for (const team of body.teams) expect(sorted(team)).toEqual(sorted(DETAIL_TEAM_KEYS));
    expect(body.tasks.length).toBeGreaterThan(0);
    for (const task of body.tasks) {
      expect(sorted(task)).toEqual(sorted(DETAIL_TASK_KEYS));
      expect(task.splitMs).toHaveLength(2);
    }
    expect(body.events.length).toBeGreaterThan(0);
    for (const event of body.events) expect(sorted(event)).toEqual(sorted(EVENT_KEYS));
  });
});
