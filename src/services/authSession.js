import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import { config } from "../config.js";

const PASSWORD_SALT = "toolkit-password-v1";
const VALID_ROLES = new Set(["user", "admin"]);

export const DEFAULT_MENU_PERMISSIONS = {
  menuView: true,
  submitRequest: true,
  comment: true,
  manageDishes: false,
  manageRequests: false,
  managePermissions: false,
};

export const OWNER_MENU_PERMISSIONS = {
  menuView: true,
  submitRequest: true,
  comment: true,
  manageDishes: true,
  manageRequests: true,
  managePermissions: true,
};

function defaultPermissionsForRole(role = "user") {
  return role === "admin" ? { ...OWNER_MENU_PERMISSIONS } : { ...DEFAULT_MENU_PERMISSIONS };
}

function normalizePermissionShape(input = {}, role = "user") {
  return {
    ...defaultPermissionsForRole(role),
    ...(input && typeof input === "object" ? input : {}),
  };
}

function normalizeRole(role = "user") {
  return VALID_ROLES.has(role) ? role : "user";
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function parsePermissionJson(value, role = "user") {
  if (!value || typeof value !== "string") {
    return defaultPermissionsForRole(role);
  }

  try {
    return normalizePermissionShape(JSON.parse(value), role);
  } catch {
    return defaultPermissionsForRole(role);
  }
}

function parseDateAsIso(value) {
  if (!value) {
    return "";
  }

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  return new Date(timestamp).toISOString();
}

function assertJwtSecret() {
  if (!config.jwtSecret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return config.jwtSecret;
}

function hashLegacyPassword(password) {
  return scryptSync(password, PASSWORD_SALT, 64).toString("hex");
}

function verifyLegacyPasswordHash(password, storedHash) {
  const a = Buffer.from(hashLegacyPassword(password), "hex");
  const b = Buffer.from(String(storedHash || ""), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function toCommonUser(row) {
  const role = normalizeRole(row.role);
  const nickname = String(row.nickname || "").trim();
  return {
    id: String(row.id),
    username: row.username,
    nickname,
    role,
    displayName: nickname || row.username,
    isOwner: role === "admin",
    menuPermissions: parsePermissionJson(row.menu_permissions_json, role),
    createdAt: parseDateAsIso(row.created_at),
    updatedAt: parseDateAsIso(row.updated_at || row.created_at),
  };
}

function toLegacyUser(row) {
  const nickname = String(row.display_name || "").trim();
  const role = row.is_owner ? "admin" : "user";
  return {
    id: row.user_id,
    username: row.username,
    nickname,
    role,
    displayName: nickname || row.username,
    isOwner: Boolean(row.is_owner),
    menuPermissions: parsePermissionJson(row.menu_permissions_json, role),
    createdAt: parseDateAsIso(Number(row.created_at_ms)),
    updatedAt: parseDateAsIso(Number(row.updated_at_ms)),
    authSource: "legacy-app-users",
  };
}

function makeJwtExpiry() {
  const hours = Number.isFinite(config.authSessionHours) ? Math.max(config.authSessionHours, 1) : 720;
  return `${hours}h`;
}

function makeTokenPayload(user) {
  const numericId = Number(user.id);
  return {
    id: Number.isInteger(numericId) && numericId > 0 ? numericId : user.id,
    username: user.username,
    role: normalizeRole(user.role),
  };
}

export function createSessionToken() {
  return randomBytes(32).toString("hex");
}

export function hashSessionToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

async function fetchUserById(id) {
  const [rows] = await pool.execute(
    `SELECT id, username, password_hash, nickname, role, menu_permissions_json, created_at, updated_at
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [id]
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function fetchUserByUsername(username) {
  const [rows] = await pool.execute(
    `SELECT id, username, password_hash, nickname, role, menu_permissions_json, created_at, updated_at
     FROM users
     WHERE username = ?
     LIMIT 1`,
    [username]
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function fetchLegacyUserByUsername(username) {
  const [rows] = await pool.execute(`SELECT * FROM app_users WHERE username = ? LIMIT 1`, [username.toLowerCase()]);
  return Array.isArray(rows) ? rows[0] : null;
}

async function fetchCommonUserCount() {
  const [rows] = await pool.execute(`SELECT COUNT(*) AS total FROM users`);
  return Number(rows?.[0]?.total || 0);
}

function validateNewUsername(username) {
  if (!username || username.length < 2) {
    throw new Error("用户名至少2个字符");
  }
  if (/[^a-zA-Z0-9_\-]/.test(username)) {
    throw new Error("用户名只允许字母、数字、下划线、连字符");
  }
}

export async function registerUser({ username, displayName, password }) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedDisplayName = String(displayName || "").trim();
  validateNewUsername(normalizedUsername);

  if (!password || String(password).length < 6) {
    throw new Error("密码至少6位");
  }

  const existing = await fetchUserByUsername(normalizedUsername);
  if (existing) {
    throw new Error(`用户名 "${normalizedUsername}" 已存在`);
  }

  const role = (await fetchCommonUserCount()) === 0 ? "admin" : "user";
  const passwordHash = await bcrypt.hash(String(password), 10);
  const nickname = normalizedDisplayName || normalizedUsername;
  const permissions = normalizePermissionShape(undefined, role);
  const [result] = await pool.execute(
    `INSERT INTO users (username, password_hash, nickname, role, menu_permissions_json)
     VALUES (?, ?, ?, ?, ?)`,
    [normalizedUsername, passwordHash, nickname.slice(0, 100), role, JSON.stringify(permissions)]
  );

  const insertedId = result?.insertId;
  const row = await fetchUserById(insertedId);
  if (!row) {
    throw new Error("注册成功但读取用户失败");
  }
  return toCommonUser(row);
}

async function migrateLegacyUserIfMatched(username, password) {
  const legacy = await fetchLegacyUserByUsername(username);
  if (!legacy || !verifyLegacyPasswordHash(password, legacy.password_hash)) {
    return null;
  }

  const commonExisting = await fetchUserByUsername(username);
  if (commonExisting) {
    return toCommonUser(commonExisting);
  }

  const role = legacy.is_owner ? "admin" : "user";
  const passwordHash = await bcrypt.hash(String(password), 10);
  const nickname = String(legacy.display_name || "").trim();
  const permissions = parsePermissionJson(legacy.menu_permissions_json, role);

  const [result] = await pool.execute(
    `INSERT INTO users (username, password_hash, nickname, role, menu_permissions_json)
     VALUES (?, ?, ?, ?, ?)`,
    [username, passwordHash, nickname.slice(0, 100), role, JSON.stringify(permissions)]
  );

  const row = await fetchUserById(result?.insertId);
  return row ? toCommonUser(row) : null;
}

export async function loginUser({ username, password }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername || !password) {
    throw new Error("请输入用户名和密码");
  }

  const userRow = await fetchUserByUsername(normalizedUsername);
  if (userRow) {
    const match = await bcrypt.compare(String(password), String(userRow.password_hash || ""));
    if (!match) {
      throw new Error("用户名或密码错误");
    }
    return toCommonUser(userRow);
  }

  const migrated = await migrateLegacyUserIfMatched(normalizedUsername, String(password));
  if (migrated) {
    return migrated;
  }

  throw new Error("用户名或密码错误");
}

export async function createUserSession(userId) {
  const row = await fetchUserById(userId);
  if (!row) {
    throw new Error("用户不存在");
  }

  const user = toCommonUser(row);
  const token = jwt.sign(makeTokenPayload(user), assertJwtSecret(), { expiresIn: makeJwtExpiry() });
  const payload = jwt.decode(token);
  const expiresAt =
    payload && typeof payload === "object" && Number.isFinite(payload.exp)
      ? new Date(Number(payload.exp) * 1000).toISOString()
      : "";

  return {
    token,
    expiresAt,
  };
}

export async function getUserBySessionToken(token) {
  const tokenHash = hashSessionToken(token);
  const now = Date.now();
  const [rows] = await pool.execute(
    `SELECT s.session_id, s.user_id, s.expires_at_ms, u.*
     FROM app_sessions s
     JOIN app_users u ON u.user_id = s.user_id
     WHERE s.token_hash = ?
       AND s.expires_at_ms > ?
     LIMIT 1`,
    [tokenHash, now]
  );

  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    return null;
  }

  return {
    sessionId: row.session_id,
    expiresAt: new Date(Number(row.expires_at_ms)).toISOString(),
    provider: "legacy-session",
    user: toLegacyUser(row),
  };
}

export async function getUserByJwtToken(token) {
  if (!config.jwtSecret) {
    return null;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const userId = Number(payload?.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return null;
    }

    const row = await fetchUserById(userId);
    if (!row) {
      return null;
    }

    const expiresAt =
      payload && typeof payload === "object" && Number.isFinite(payload.exp)
        ? new Date(Number(payload.exp) * 1000).toISOString()
        : "";

    return {
      sessionId: `jwt_${userId}`,
      expiresAt,
      provider: "common-jwt",
      user: toCommonUser(row),
    };
  } catch {
    return null;
  }
}

export async function getUserByAccessToken(token) {
  const jwtSession = await getUserByJwtToken(token);
  if (jwtSession) {
    return jwtSession;
  }

  return getUserBySessionToken(token);
}

export async function invalidateSessionToken(token) {
  const tokenHash = hashSessionToken(token);
  await pool.execute(`DELETE FROM app_sessions WHERE token_hash = ?`, [tokenHash]);
}

export async function listUsers() {
  const [rows] = await pool.execute(
    `SELECT id, username, nickname, role, menu_permissions_json, created_at, updated_at
     FROM users
     ORDER BY role DESC, created_at ASC`
  );
  return Array.isArray(rows) ? rows.map(toCommonUser) : [];
}

export async function updateUserMenuPermissions({ userId, menuPermissions }) {
  const row = await fetchUserById(Number(userId));
  if (!row) {
    throw new Error("用户不存在");
  }

  const role = normalizeRole(row.role);
  const merged = normalizePermissionShape(menuPermissions, role);
  await pool.execute(`UPDATE users SET menu_permissions_json = ? WHERE id = ?`, [JSON.stringify(merged), row.id]);

  return {
    ...toCommonUser(row),
    menuPermissions: merged,
  };
}

export async function changeUserPassword({ userId, oldPassword, newPassword }) {
  if (!oldPassword || !newPassword) {
    throw new Error("请输入旧密码和新密码");
  }
  if (String(newPassword).length < 6) {
    throw new Error("新密码至少6位");
  }

  const row = await fetchUserById(Number(userId));
  if (!row) {
    throw new Error("用户不存在");
  }

  const match = await bcrypt.compare(String(oldPassword), String(row.password_hash || ""));
  if (!match) {
    throw new Error("旧密码错误");
  }

  const hash = await bcrypt.hash(String(newPassword), 10);
  await pool.execute(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, row.id]);
}

export async function listAdminUsers() {
  const [rows] = await pool.execute(
    `SELECT id, username, nickname, role, created_at
     FROM users
     ORDER BY created_at DESC`
  );
  return Array.isArray(rows) ? rows : [];
}

export async function createManagedUser({ username, password, nickname = "", role = "user" }) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedRole = normalizeRole(role);
  validateNewUsername(normalizedUsername);

  if (!password || String(password).length < 6) {
    throw new Error("密码至少6位");
  }

  const existing = await fetchUserByUsername(normalizedUsername);
  if (existing) {
    throw new Error(`用户名 "${normalizedUsername}" 已存在`);
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  const permissions = normalizePermissionShape(undefined, normalizedRole);
  const [result] = await pool.execute(
    `INSERT INTO users (username, password_hash, nickname, role, menu_permissions_json)
     VALUES (?, ?, ?, ?, ?)`,
    [normalizedUsername, passwordHash, String(nickname || "").trim().slice(0, 100), normalizedRole, JSON.stringify(permissions)]
  );

  return {
    id: Number(result?.insertId || 0),
    ok: true,
  };
}

export async function updateManagedUserRole({ targetUserId, role, operatorUserId }) {
  const nextRole = normalizeRole(role);
  const numericTargetId = Number(targetUserId);
  const numericOperatorId = Number(operatorUserId);
  if (!Number.isInteger(numericTargetId) || numericTargetId <= 0) {
    throw new Error("无效用户");
  }
  if (numericTargetId === numericOperatorId) {
    throw new Error("不能修改自己的角色");
  }

  const row = await fetchUserById(numericTargetId);
  if (!row) {
    throw new Error("用户不存在");
  }

  const permissions = normalizePermissionShape(parsePermissionJson(row.menu_permissions_json, row.role), nextRole);
  await pool.execute(`UPDATE users SET role = ?, menu_permissions_json = ? WHERE id = ?`, [
    nextRole,
    JSON.stringify(permissions),
    numericTargetId,
  ]);
}

export async function resetManagedUserPassword({ targetUserId, newPassword }) {
  if (!newPassword || String(newPassword).length < 6) {
    throw new Error("新密码至少6位");
  }

  const numericTargetId = Number(targetUserId);
  if (!Number.isInteger(numericTargetId) || numericTargetId <= 0) {
    throw new Error("无效用户");
  }

  const hash = await bcrypt.hash(String(newPassword), 10);
  await pool.execute(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, numericTargetId]);
}

export async function deleteManagedUser({ targetUserId, operatorUserId }) {
  const numericTargetId = Number(targetUserId);
  const numericOperatorId = Number(operatorUserId);
  if (!Number.isInteger(numericTargetId) || numericTargetId <= 0) {
    throw new Error("无效用户");
  }
  if (numericTargetId === numericOperatorId) {
    throw new Error("不能删除自己");
  }

  await pool.execute(`DELETE FROM users WHERE id = ?`, [numericTargetId]);
}

export function hasMenuPermission(user, key) {
  if (user?.isOwner || user?.role === "admin") {
    return true;
  }
  return Boolean(user?.menuPermissions?.[key]);
}
