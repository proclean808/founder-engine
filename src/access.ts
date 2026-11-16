// Investor access tokens. The engine does NOT verify accreditation itself: for Rule 506(c) raises
// that is a regulated "reasonable steps" verification done by a qualified third party (or counsel).
// After that check, the founder issues a short-lived signed token naming the investor, the access
// level, and the verification reference. Restricted (IP) facts are served only for "accredited".
// No secret configured => every viewer is "public" (fail closed).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AccessLevel } from "./pitch.js";

export interface AccessClaims {
  sub: string; // investor identity as verified, e.g. "Jane Doe <jane@acme.vc>"
  level: AccessLevel;
  verified_by?: string; // provider + reference of the identity/accreditation check
  exp: number; // unix seconds
  iat: number;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function issueAccess(claims: Omit<AccessClaims, "iat" | "exp"> & { days: number }, secret: string, now = Date.now()): string {
  if (!secret || secret.length < 32) throw new Error("FE_ACCESS_SECRET must be at least 32 characters");
  if (!["identified", "accredited"].includes(claims.level)) throw new Error("level must be identified or accredited");
  const body: AccessClaims = { sub: claims.sub, level: claims.level, verified_by: claims.verified_by, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + Math.round(claims.days * 86400) };
  const payload = b64u(JSON.stringify(body));
  return `${payload}.${b64u(createHmac("sha256", secret).update(payload).digest())}`;
}

export function verifyAccess(token: string | undefined | null, secret: string | undefined, now = Date.now()): AccessClaims | null {
  if (!token || !secret || secret.length < 32) return null;
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessClaims;
    if (typeof c.exp !== "number" || c.exp * 1000 < now) return null;
    if (!["identified", "accredited"].includes(c.level)) return null;
    return c;
  } catch {
    return null;
  }
}
