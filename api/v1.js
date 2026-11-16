// Venture studio API (Milestone 3). vercel.json rewrites /api/v1/<path> -> /api/v1?path=<path>.
import { route } from "../dist/src/v1.js";
export const config = { maxDuration: 60 };
export default async function handler(req, res) {
  const { path = "", ...query } = req.query ?? {};
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { return res.status(400).json({ error: "invalid JSON" }); } }
  const out = await route({ method: req.method, path: Array.isArray(path) ? path.join("/") : String(path), headers: req.headers, query, body });
  res.setHeader("cache-control", "no-store");
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
  res.status(out.status).json(out.body);
}
