// PostgreSQL access. Portable: any Postgres reachable by connection string (Vercel Marketplace
// Postgres such as Neon, a self-hosted server, or the CI service container).
// Every tenant operation runs inside a transaction with app.user_id set LOCAL, so row-level
// security scopes all reads and writes to that tenant.
import pg from "pg";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

let pool: pg.Pool | null = null;

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.DATABASE_URL ?? env.POSTGRES_URL ?? env.FE_DATABASE_URL ?? null;
}

export function getDb(url = databaseUrl()): Db {
  if (!url) throw new Error("no database configured (DATABASE_URL / POSTGRES_URL)");
  if (!pool) {
    const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
    pool = new pg.Pool({ connectionString: url, max: Number(process.env.FE_DB_POOL_MAX ?? 3), idleTimeoutMillis: 10_000, ssl: local ? undefined : { rejectUnauthorized: true } });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const APP_ROLE = "fe_app";

/**
 * Drop to the least-privilege app role for this transaction and prove it cannot bypass RLS.
 * Fails closed: if the effective role is a superuser or has BYPASSRLS, the request is refused.
 */
async function enterAppRole(tx: Tx): Promise<void> {
  await tx.query(`SET LOCAL ROLE ${APP_ROLE}`);
  const r = await tx.query("SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  const row = r.rows[0];
  if (!row || row.u !== APP_ROLE || row.rolsuper || row.rolbypassrls) {
    throw new Error("fe: refusing to serve requests: effective database role could bypass row-level security");
  }
}

/** Run fn in a transaction scoped to one tenant (RLS). */
export async function withTenant<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new Error("invalid tenant id");
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await enterAppRole(tx);
    await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const out = await fn(tx);
    await tx.query("COMMIT");
    return out;
  } catch (e) {
    await tx.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

/** Run fn in a transaction with no tenant context (auth tables, invitation lookup by token). */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return ownerTx(db, async (tx) => {
    await enterAppRole(tx);
    return fn(tx);
  });
}

/** Transaction as the connection user (migrations only). */
async function ownerTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const out = await fn(tx);
    await tx.query("COMMIT");
    return out;
  } catch (e) {
    await tx.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

function sqlDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [resolve(here, "../../sql"), resolve(here, "../sql"), resolve(process.cwd(), "sql")]) if (existsSync(c)) return c;
  throw new Error("sql/ migrations directory not found");
}

/** Apply sql/NNN_*.sql files not yet recorded in fe_schema_migrations. Idempotent, serialised. */
export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  const applied: string[] = [];
  await ownerTx(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('fe_migrations'))");
    await tx.query("CREATE TABLE IF NOT EXISTS fe_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await tx.query("SELECT name FROM fe_schema_migrations")).rows.map((r) => r.name));
    for (const f of readdirSync(sqlDir()).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
      if (done.has(f)) continue;
      await tx.query(readFileSync(join(sqlDir(), f), "utf8"));
      await tx.query("INSERT INTO fe_schema_migrations(name) VALUES ($1)", [f]);
      applied.push(f);
      log(`applied ${f}`);
    }
  });
  return applied;
}
