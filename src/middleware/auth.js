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

export function requireSyncToken(req, res, next) {
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  const key =
    req.headers["x-sync-token"] ||
    req.query.sync_token ||
    bearer;

  if (!config.syncToken) {
    return res.status(503).json({ error: "Sync token is not configured on server" });
  }

  if (!key || key !== config.syncToken) {
    return res.status(401).json({ error: "Unauthorized: invalid sync token" });
  }

  next();
}

export function requireMenuAccess(req, res, next) {
  if (!config.menuBoardToken) {
    next();
    return;
  }

  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  const key =
    req.headers["x-menu-token"] ||
    req.query.menu_token ||
    bearer;

  if (!key || key !== config.menuBoardToken) {
    return res.status(401).json({ error: "Unauthorized: invalid menu token" });
  }

  next();
}
