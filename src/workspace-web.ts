// HTTP handler for the founder workspace: POST /api/workspace { action, ... }.
import { HttpError, str } from "./web.js";
import { conciergeSession, conciergeStatus, defineVenture } from "./concierge.js";
import { liveStatus } from "./live.js";
import { listModels } from "./provider.js";

export async function handleWorkspace(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (b.action) {
    case "status":
      return { concierge: conciergeStatus(), live: liveStatus(), models: listModels(), database: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL), engine_commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null };
    case "define": {
      const statement = str(b.statement, "statement", 20, 4000)!;
      return { spec: await defineVenture(statement) };
    }
    case "concierge_session": {
      const context = typeof b.context === "string" ? b.context : null;
      try { return await conciergeSession(context); } catch (e) { throw new HttpError(503, (e as Error).message); }
    }
    default:
      throw new HttpError(400, "action must be status, define or concierge_session");
  }
}
