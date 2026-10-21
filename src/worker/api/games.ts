// Game endpoints (SPEC.md §4, §5, §10). Every handler loads the game, finalizes it
// if time is up, asks a pure rule what to do, and commits the result guarded by the
// game's version. A lost race is retried from fresh state.
import { Hono, type Context } from "hono";
import type { AppEnv, Deps } from "../app";
import { commitChange, finalizeIfExpired, insertGame, loadSnapshot, readActiveCatalog } from "../db/games";
import { apiError } from "../errors";
import { generateCode, normalizeCode } from "../game/code";
import { DEFAULT_TEAM_NAMES, MAX_CODE_ATTEMPTS } from "../game/constants";
import { isExpired } from "../game/finalize";
import { decideAbandon, decideComplete, decideRename, decideRoll, decideStart, decideUndo } from "../game/state";
import type { Decision, Snapshot } from "../game/types";
import { toGameView } from "./view";

const MAX_ATTEMPTS = 3;

type Decide = (snap: Snapshot, now: number) => Decision | Promise<Decision>;

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
      // Finalizing lost a race to another write; retry from fresh state rather than
      // act on a game that is out of time but not yet marked finished.
      if (isExpired(snap.game, now)) continue;

      const decision = await decide(snap, now);
      if (decision.kind === "error") return apiError(c, decision.status, decision.error, decision.message);
      if (decision.kind === "noop") return c.json(toGameView(snap, now));
      if (await commitChange(db, snap.game.id, snap.game.version, decision.change)) {
        const saved = await loadSnapshot(db, code);
        return saved ? c.json(toGameView(saved, now)) : notFound(c);
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
        const created = await loadSnapshot(c.env.DB, code);
        if (created) return c.json(toGameView(created, now), 201);
      }
    }
    // Practically unreachable: 31^5 codes. Surfaces as the generic 500.
    throw new Error(`No free game code after ${MAX_CODE_ATTEMPTS} attempts`);
  });

  routes.get("/games/:code", (c) => run(c, () => ({ kind: "noop" })));

  routes.patch("/games/:code/teams", async (c) => {
    const body = await readJson(c);
    return run(c, (snap) => decideRename(snap, body));
  });

  routes.post("/games/:code/roll", (c) =>
    // Read at roll time: the catalog sync may have just changed it.
    run(c, async (snap, now) => decideRoll(snap, await readActiveCatalog(c.env.DB), deps.randomInt, now)),
  );

  routes.post("/games/:code/start", (c) => run(c, decideStart));
  routes.post("/games/:code/abandon", (c) => run(c, decideAbandon));

  for (const action of ["complete", "undo"] as const) {
    const decideTask = action === "complete" ? decideComplete : decideUndo;
    routes.post(`/games/:code/tasks/:taskId/${action}`, async (c) => {
      const taskId = c.req.param("taskId");
      if (!/^\d+$/.test(taskId)) return notFound(c);
      const body = await readJson(c);
      // Validated by the decision after the game and status checks.
      const teamId = isObject(body) ? body.teamId : undefined;
      return run(c, (snap, now) => decideTask(snap, teamId, Number(taskId), now));
    });
  }

  return routes;
}
