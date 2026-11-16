// Founder accounts: scrypt password hashes, random session tokens stored only as SHA-256 hashes.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import { withTx } from "./db.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_DAYS = 7;

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, key] = stored.split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(key, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return got.length === want.length && timingSafeEqual(got, want);
}

export const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");

function normEmail(e: unknown): string {
  const s = String(e ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 200) throw new AuthError(400, "valid email required");
  return s;
}

function checkPassword(pw: unknown): string {
  const s = String(pw ?? "");
  if (s.length < 12 || s.length > 200) throw new AuthError(400, "password must be 12-200 characters");
  return s;
}

async function newSession(db: Db, userId: string): Promise<{ token: string; expires_at: string }> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await withTx(db, (tx) => tx.query("INSERT INTO fe_sessions(token_hash, user_id, expires_at) VALUES ($1,$2,$3)", [tokenHash(token), userId, expires]));
  return { token, expires_at: expires.toISOString() };
}

export async function signup(db: Db, email: unknown, password: unknown) {
  const e = normEmail(email);
  const pw = checkPassword(password);
  const hash = await hashPassword(pw);
  const row = await withTx(db, async (tx) => {
    const r = await tx.query("INSERT INTO fe_users(email, pw_hash) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING RETURNING id", [e, hash]);
    return r.rows[0] as { id: string } | undefined;
  });
  if (!row) throw new AuthError(409, "an account with that email already exists");
  return { user_id: row.id, email: e, ...(await newSession(db, row.id)) };
}

export async function login(db: Db, email: unknown, password: unknown) {
  const e = normEmail(email);
  const pw = String(password ?? "");
  const r = await withTx(db, (tx) => tx.query("SELECT id, pw_hash FROM fe_users WHERE email = $1", [e]));
  const u = r.rows[0] as { id: string; pw_hash: string } | undefined;
  // Same work whether or not the account exists.
  const ok = u ? await verifyPassword(pw, u.pw_hash) : (await hashPassword(pw), false);
  if (!u || !ok) throw new AuthError(401, "invalid email or password");
  return { user_id: u.id, email: e, ...(await newSession(db, u.id)) };
}

export async function userFromToken(db: Db, token: string | null): Promise<{ user_id: string; email: string } | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const r = await withTx(db, (tx) =>
    tx.query("SELECT u.id, u.email FROM fe_sessions s JOIN fe_users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()", [tokenHash(token)]),
  );
  return r.rows[0] ? { user_id: r.rows[0].id, email: r.rows[0].email } : null;
}

export async function logout(db: Db, token: string | null): Promise<void> {
  if (token) await withTx(db, (tx) => tx.query("DELETE FROM fe_sessions WHERE token_hash = $1", [tokenHash(token)]));
}
