import { config } from "../config.js";

export function requireAdmin(req, res, next) {
  const key =
    req.headers["x-api-key"] ||
    req.query.api_key;

  if (!key || key !== config.adminApiKey) {
    return res.status(401).json({ error: "Unauthorized: invalid API key" });
  }
  next();
}
