// /api/v1 router for the venture studio. Framework-free: (method, path, headers, query, body) -> response.
// Sessions: httpOnly SameSite=Strict cookie for browsers, or "Authorization: Bearer <token>" for agents.
// State-changing requests must be JSON (with SameSite=Strict this blocks cross-site form posts).
import type { Db } from "./db.js";
import { getDb, migrate, databaseUrl } from "./db.js";
import { AuthError, SESSION_DAYS, login, logout, signup, userFromToken } from "./auth.js";
import * as S from "./studio.js";
import { handleCurate } from "./web.js";

export interface V1Request {
  method: string;
  path: string; // e.g. "ventures/<id>/runs"
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  body: unknown;
}
export interface V1Response {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const COOKIE = "fe_session";

function header(req: V1Request, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function sessionToken(req: V1Request): string | null {
  const auth = header(req, "authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const m = (header(req, "cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

const cookie = (token: string, maxAge: number) => `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

let migrated: Promise<unknown> | null = null;
const defaultDeps: S.StudioDeps = { curate: (b) => handleCurate(b) as Promise<Record<string, unknown>> };

export async function route(req: V1Request, opts: { db?: Db; deps?: S.StudioDeps } = {}): Promise<V1Response> {
  try {
    if (!opts.db && !databaseUrl()) return { status: 503, body: { error: "venture studio database not configured on this deployment" } };
    const db = opts.db ?? getDb();
    if (!opts.db && process.env.FE_AUTO_MIGRATE !== "0") migrated ??= migrate(db).catch((e) => { migrated = null; throw e; });
    if (migrated) await migrated;
    const deps = opts.deps ?? defaultDeps;
    const m = req.method.toUpperCase();
    const p = req.path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (m !== "GET" && !/application\/json/i.test(header(req, "content-type") ?? "")) return { status: 415, body: { error: "content-type must be application/json" } };

    // ---- public: auth and investor links
    if (p[0] === "auth") {
      if (m === "POST" && p[1] === "signup") {
        const r = await signup(db, body.email, body.password);
        return { status: 201, headers: { "set-cookie": cookie(r.token, SESSION_DAYS * 86400) }, body: r };
      }
      if (m === "POST" && p[1] === "login") {
        const r = await login(db, body.email, body.password);
        return { status: 200, headers: { "set-cookie": cookie(r.token, SESSION_DAYS * 86400) }, body: r };
      }
      if (m === "POST" && p[1] === "logout") {
        await logout(db, sessionToken(req));
        return { status: 200, headers: { "set-cookie": cookie("", 0) }, body: { ok: true } };
      }
    }
    if (p[0] === "invite") {
      if (m === "POST" && p[1] === "open") return { status: 200, body: await S.openInvitation(db, body.token) };
      if (m === "POST" && p[1] === "ask") return { status: 200, body: await S.investorAsk(db, body.token, body) };
    }

    // ---- founder session required
    const user = await userFromToken(db, sessionToken(req));
    if (!user) return { status: 401, body: { error: "login required" } };
    const uid = user.user_id;

    if (p[0] === "auth" && p[1] === "me" && m === "GET") return { status: 200, body: user };
    if (p[0] === "lessons") {
      if (m === "POST") return { status: 201, body: await S.addLesson(db, uid, body) };
      if (m === "GET") return { status: 200, body: await S.queryLessons(db, uid, { component: req.query.component, environment: req.query.environment, symptom: req.query.symptom }) };
    }
    if (p[0] === "ventures") {
      if (p.length === 1 && m === "GET") return { status: 200, body: await S.listVentures(db, uid) };
      if (p.length === 1 && m === "POST") return { status: 201, body: await S.createVenture(db, uid, body) };
      const vid = p[1];
      if (!/^[0-9a-f-]{36}$/i.test(vid ?? "")) return { status: 404, body: { error: "venture not found" } };
      const sub = p.slice(2).join("/");
      if (m === "GET" && sub === "history") return { status: 200, body: await S.ventureHistory(db, uid, vid) };
      if (m === "POST" && sub === "runs") return { status: 201, body: await S.createRun(db, uid, vid, body, deps) };
      if (m === "POST" && sub === "pitches") return { status: 201, body: await S.createPitch(db, uid, vid, body) };
      if (m === "POST" && sub === "investors") return { status: 201, body: await S.addInvestor(db, uid, vid, body) };
      if (m === "POST" && sub === "invitations") return { status: 201, body: await S.inviteInvestor(db, uid, vid, body) };
      if (m === "POST" && p[2] === "invitations" && p[4] === "revoke") return { status: 200, body: await S.revokeInvitation(db, uid, vid, p[3]) };
      if (m === "POST" && sub === "sessions") return { status: 201, body: await S.recordSession(db, uid, vid, body) };
      if (m === "POST" && p[2] === "investors" && p[4] === "stage") return { status: 200, body: await S.transitionStage(db, uid, vid, p[3], body) };
    }
    return { status: 404, body: { error: "not found" } };
  } catch (e) {
    if (e instanceof AuthError || e instanceof S.StudioError) return { status: e.status, body: { error: e.message } };
    const pgCode = (e as { code?: string }).code;
    if (pgCode === "42501") return { status: 403, body: { error: (e as Error).message } }; // RLS / immutability
    if (pgCode === "22P02") return { status: 400, body: { error: "malformed identifier" } };
    console.error(e);
    return { status: 500, body: { error: "studio error" } };
  }
}
