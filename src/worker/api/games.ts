// Game endpoints (SPEC.md §4, §5, §10). Every handler loads the game, finalizes it
// if time is up, asks a pure rule what to do, and commits the result guarded by the
// game's version. A lost race is retried from fresh state.
import { Hono, type Context } from "hono";
import type { AppEnv, Deps } from "../app";
import { commitChange, finalizeIfExpired, insertGame, loadSnapshot, readActiveCatalog } from "../db/games";
import { apiError } from "../errors";
import { generateCode, normalizeCode } from "../game/code";
import { DEFAULT_TEAM_NAMES, GAME_DURATION_MS, MAX_CODE_ATTEMPTS } from "../game/constants";
import { validateTeamNames } from "../game/names";
import { rollTasks } from "../game/roll";
import { canDo, decideComplete, decideUndo, statusError, type Action } from "../game/state";
import type { Decision, Snapshot } from "../game/types";
import { toGameView } from "./view";

const MAX_ATTEMPTS = 3;

type Decide = (snap: Snapshot, now: number) => Decision | Promise<Decision>;

const validation = (message: string): Decision => ({ kind: "error", status: 422, error: "validation", message });

/** The 409 for an action this status doesn't allow, or null if it's allowed. */
const gate = (snap: Snapshot, action: Action): Decision | null =>
  canDo(snap.game.status, action) ? null : statusError(snap.game.status);

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function gameRoutes(deps: Deps) {
  const notFound = (c: Context) => apiError(c, 404, "not_found", "Not found");

  async function run(c: Context<AppEnv>, decide: Decide) {
    const code = normalizeCode(c.req.param("code") ?? "");
    if (!code) return notFound(c);
    const db = c.env.DB;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const now = deps.now();
      const loaded = await loadSnapshot(db, code);
      if (!loaded) return notFound(c);
      const snap = await finalizeIfExpired(db, loaded, now);

      const decision = await decide(snap, now);
      if (decision.kind === "error") return apiError(c, decision.status, decision.error, decision.message);
      if (decision.kind === "noop") return c.json(toGameView(snap, now));
      if (await commitChange(db, snap.game.id, snap.game.version, decision.change)) {
        return c.json(toGameView((await loadSnapshot(db, code))!, now));
      }
    }
    return apiError(c, 409, "busy", "The game changed too quickly. Try again.");
  }

  const routes = new Hono<AppEnv>();

  routes.post("/games", async (c) => {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = generateCode(deps.randomInt);
      const now = deps.now();
      if (await insertGame(c.env.DB, code, now, DEFAULT_TEAM_NAMES)) {
        return c.json(toGameView((await loadSnapshot(c.env.DB, code))!, now), 201);
      }
    }
    // Practically unreachable: 31^5 codes. Surfaces as the generic 500.
    throw new Error(`No free game code after ${MAX_CODE_ATTEMPTS} attempts`);
  });

  routes.get("/games/:code", (c) => run(c, () => ({ kind: "noop" })));

  routes.patch("/games/:code/teams", async (c) => {
    const body = await readJson(c);
    return run(c, (snap) => {
      const blocked = gate(snap, "renameTeams");
      if (blocked) return blocked;
      if (!isObject(body)) return validation("Send JSON with team1 and team2");
      const result = validateTeamNames(body.team1, body.team2);
      if (!result.ok) return validation(result.message);
      const [one, two] = result.names;
      if (snap.teams[0]?.name === one && snap.teams[1]?.name === two) return { kind: "noop" };
      return { kind: "change", change: { kind: "rename", names: result.names } };
    });
  });

  routes.post("/games/:code/roll", (c) =>
    run(c, async (snap, now) => {
      const blocked = gate(snap, "roll");
      if (blocked) return blocked;
      // Read at roll time: the catalog sync may have just changed it.
      const catalog = await readActiveCatalog(c.env.DB);
      const result = rollTasks(catalog.categories, catalog.tasks, deps.randomInt);
      if (!result.ok) return { kind: "error", status: 409, error: "catalog_incomplete", message: result.message };
      return { kind: "change", change: { kind: "roll", at: now, tasks: result.tasks } };
    }),
  );

  routes.post("/games/:code/start", (c) =>
    run(c, (snap, now) => gate(snap, "start") ?? { kind: "change", change: { kind: "start", at: now, endsAt: now + GAME_DURATION_MS } }),
  );

  routes.post("/games/:code/abandon", (c) =>
    run(c, (snap, now) => gate(snap, "abandon") ?? { kind: "change", change: { kind: "abandon", at: now } }),
  );

  for (const action of ["complete", "undo"] as const) {
    const decideTask = action === "complete" ? decideComplete : decideUndo;
    routes.post(`/games/:code/tasks/:taskId/${action}`, async (c) => {
      const taskId = c.req.param("taskId");
      if (!/^\d+$/.test(taskId)) return notFound(c);
      const body = await readJson(c);
      const teamId = isObject(body) ? body.teamId : undefined;
      if (typeof teamId !== "number" || !Number.isSafeInteger(teamId)) {
        return apiError(c, 422, "validation", "Send JSON with a numeric teamId");
      }
      return run(c, (snap, now) => decideTask(snap, teamId, Number(taskId), now));
    });
  }

  return routes;
}
