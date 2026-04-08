import { config } from "../config.js";
import { getUserByAccessToken, hasMenuPermission } from "../services/authSession.js";

function resolveBearerToken(req) {
  return req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : "";
}

export function resolveSessionToken(req) {
  return String(
    req.headers["x-session-token"] ||
      req.headers["x-app-token"] ||
      req.query.session_token ||
      req.query.auth_token ||
      req.query.access_token ||
      resolveBearerToken(req) ||
      ""
  ).trim();
}

export async function optionalAuth(req, res, next) {
  const token = resolveSessionToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    const session = await getUserByAccessToken(token);
    if (session) {
      req.authToken = token;
      req.authUser = session.user;
      req.authSession = session;
      res.locals.authUser = session.user;
      res.locals.authToken = token;
    }
  } catch (error) {
    console.error("[auth] optional auth failed", error);
  }

  next();
}

export async function requireAuth(req, res, next) {
  const token = resolveSessionToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized: access token is required" });
  }

  const session = await getUserByAccessToken(token);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized: invalid or expired session" });
  }

  req.authToken = token;
  req.authUser = session.user;
  req.authSession = session;
  res.locals.authUser = session.user;
  res.locals.authToken = token;
  next();
}

export function requireAdmin(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key;

  if (!key || key !== config.adminApiKey) {
    return res.status(401).json({ error: "Unauthorized: invalid API key" });
  }
  next();
}

export function requireSyncToken(req, res, next) {
  const key = req.headers["x-sync-token"] || req.query.sync_token || resolveBearerToken(req);

  if (!config.syncToken) {
    return res.status(503).json({ error: "Sync token is not configured on server" });
  }

  if (!key || key !== config.syncToken) {
    return res.status(401).json({ error: "Unauthorized: invalid sync token" });
  }

  next();
}

export function requireMenuPermission(permissionKey) {
  return (req, res, next) => {
    if (!req.authUser) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!hasMenuPermission(req.authUser, permissionKey)) {
      return res.status(403).json({ error: "Forbidden: insufficient permission" });
    }

    next();
  };
}
