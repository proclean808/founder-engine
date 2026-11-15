// Shared adapter: framework-free handler -> Vercel Node function response.
import { HttpError } from "../dist/src/web.js";

export async function respond(req, res, methods, fn) {
  res.setHeader("cache-control", "no-store");
  if (!methods.includes(req.method)) {
    res.setHeader("allow", methods.join(", "));
    return res.status(405).json({ error: "method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    return res.status(200).json(await fn(body));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    return res.status(status).json({ error: status === 500 ? `engine error: ${e.message}` : e.message });
  }
}
