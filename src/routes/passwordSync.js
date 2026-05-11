import { Router } from "express";
import { db } from "../db/index.js";
import { requireSyncToken } from "../middleware/auth.js";
import { decryptVaultSecret, encryptVaultSecret } from "../services/passwordVault.js";

const router = Router();
const DEFAULT_NAMESPACE = "default";

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function toTimestamp(value, fallback = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function normalizeText(value, maxLength = 0) {
  const text = String(value || "").trim();
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

function serializePasswordItem(row) {
  return {
    id: row.item_id,
    name: row.name,
    category: row.category || "other",
    host: row.host || "",
    port: row.port || "",
    username: row.username || "",
    password: decryptVaultSecret(row.password_ciphertext),
    remark: row.remark || "",
    deleted: Boolean(row.deleted),
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    deletedAt: row.deleted_at_ms ? new Date(Number(row.deleted_at_ms)).toISOString() : null,
  };
}

async function sendPasswordList(res) {
  const rows = await db.listWorkbenchPasswordItems(DEFAULT_NAMESPACE, { includeDeleted: true });
  const items = rows.map(serializePasswordItem);

  res.json({
    total: items.filter((item) => !item.deleted).length,
    serverTime: new Date().toISOString(),
    items,
  });
}

function resolvePasswordCiphertext({ password, existing, allowEmpty = false }) {
  if (typeof password === "string") {
    if (!password && !allowEmpty) {
      throw new Error("password cannot be empty");
    }
    return encryptVaultSecret(password);
  }

  if (existing?.password_ciphertext) {
    return existing.password_ciphertext;
  }

  if (allowEmpty) {
    return encryptVaultSecret("");
  }

  throw new Error("password is required");
}

async function importPasswords(req, res) {
  const sourceApp = normalizeText(req.body.sourceApp, 100);
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const itemIds = [];
  const seenItemIds = new Set();

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const itemId = normalizeText(item.id, 120);
    if (itemId && !seenItemIds.has(itemId)) {
      seenItemIds.add(itemId);
      itemIds.push(itemId);
    }
  }

  const existingRows = await db.getWorkbenchPasswordItemsByIds({
    namespace: DEFAULT_NAMESPACE,
    itemIds,
  });
  const currentById = new Map(existingRows.map((row) => [row.item_id, row]));
  const pendingUpserts = new Map();

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const itemId = normalizeText(item.id, 120);
    if (!itemId) {
      continue;
    }

    const existing = currentById.get(itemId) || null;
    const createdAtMs = toTimestamp(item.createdAt);
    const updatedAtMs = toTimestamp(item.updatedAt, createdAtMs);
    const deleted = Boolean(item.deleted);
    const deletedAtMs = deleted ? toTimestamp(item.deletedAt, updatedAtMs) : null;

    if (existing && Number(existing.updated_at_ms) > updatedAtMs) {
      continue;
    }

    const nextRow = {
      namespace: DEFAULT_NAMESPACE,
      itemId,
      name: normalizeText(item.name || existing?.name || "Deleted item", 120),
      category: normalizeText(item.category || existing?.category || "other", 40) || "other",
      host: Object.prototype.hasOwnProperty.call(item, "host")
        ? normalizeText(item.host, 255)
        : normalizeText(existing?.host, 255),
      port: Object.prototype.hasOwnProperty.call(item, "port")
        ? normalizeText(item.port, 40)
        : normalizeText(existing?.port, 40),
      username: normalizeText(item.username || existing?.username, 120),
      passwordCiphertext: resolvePasswordCiphertext({
        password: Object.prototype.hasOwnProperty.call(item, "password") ? item.password : undefined,
        existing,
        allowEmpty: deleted,
      }),
      remark: Object.prototype.hasOwnProperty.call(item, "remark")
        ? normalizeText(item.remark)
        : normalizeText(existing?.remark),
      deleted: deleted ? 1 : 0,
      createdAtMs: existing ? Math.min(Number(existing.created_at_ms), createdAtMs) : createdAtMs,
      updatedAtMs,
      deletedAtMs,
      sourceApp,
    };

    pendingUpserts.set(itemId, nextRow);
    currentById.set(itemId, {
      item_id: itemId,
      name: nextRow.name,
      category: nextRow.category,
      host: nextRow.host,
      port: nextRow.port,
      username: nextRow.username,
      password_ciphertext: nextRow.passwordCiphertext,
      remark: nextRow.remark,
      deleted: nextRow.deleted,
      created_at_ms: nextRow.createdAtMs,
      updated_at_ms: nextRow.updatedAtMs,
      deleted_at_ms: nextRow.deletedAtMs,
      source_app: nextRow.sourceApp,
    });
  }

  if (pendingUpserts.size > 0) {
    await db.bulkUpsertWorkbenchPasswordItems([...pendingUpserts.values()]);
  }

  return sendPasswordList(res);
}

router.get(
  "/passwords",
  requireSyncToken,
  asyncHandler(async (_req, res) => {
    await sendPasswordList(res);
  })
);

router.post(
  "/passwords",
  requireSyncToken,
  asyncHandler(async (req, res) => {
    const itemId = normalizeText(req.body.id, 120);
    const name = normalizeText(req.body.name, 120);
    const category = normalizeText(req.body.category, 40) || "other";
    const username = normalizeText(req.body.username, 120);

    if (!itemId) {
      return res.status(400).json({ error: "id is required" });
    }
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!username) {
      return res.status(400).json({ error: "username is required" });
    }
    if (typeof req.body.password !== "string" || !req.body.password) {
      return res.status(400).json({ error: "password is required" });
    }

    const existing = await db.getWorkbenchPasswordItem({ namespace: DEFAULT_NAMESPACE, itemId });
    if (existing && !existing.deleted) {
      return res.status(409).json({ error: "Password item already exists" });
    }

    const createdAtMs = toTimestamp(req.body.createdAt);

    await db.upsertWorkbenchPasswordItem({
      namespace: DEFAULT_NAMESPACE,
      itemId,
      name,
      category,
      host: normalizeText(req.body.host, 255),
      port: normalizeText(req.body.port, 40),
      username,
      passwordCiphertext: encryptVaultSecret(req.body.password),
      remark: normalizeText(req.body.remark),
      deleted: 0,
      createdAtMs: existing ? Number(existing.created_at_ms) : createdAtMs,
      updatedAtMs: Date.now(),
      deletedAtMs: null,
      sourceApp: normalizeText(req.body.sourceApp, 100),
    });

    return sendPasswordList(res);
  })
);

router.patch(
  "/passwords/:id",
  requireSyncToken,
  asyncHandler(async (req, res) => {
    const itemId = normalizeText(req.params.id, 120);
    const existing = await db.getWorkbenchPasswordItem({ namespace: DEFAULT_NAMESPACE, itemId });

    if (!existing || existing.deleted) {
      return res.status(404).json({ error: "Password item not found" });
    }

    const nextName = typeof req.body.name === "string" ? normalizeText(req.body.name, 120) : existing.name;
    const nextCategory =
      typeof req.body.category === "string" ? normalizeText(req.body.category, 40) || "other" : existing.category;
    const nextUsername =
      typeof req.body.username === "string" ? normalizeText(req.body.username, 120) : existing.username;

    if (!nextName) {
      return res.status(400).json({ error: "name cannot be empty" });
    }
    if (!nextUsername) {
      return res.status(400).json({ error: "username cannot be empty" });
    }

    await db.upsertWorkbenchPasswordItem({
      namespace: DEFAULT_NAMESPACE,
      itemId,
      name: nextName,
      category: nextCategory,
      host: Object.prototype.hasOwnProperty.call(req.body, "host")
        ? normalizeText(req.body.host, 255)
        : existing.host || "",
      port: Object.prototype.hasOwnProperty.call(req.body, "port")
        ? normalizeText(req.body.port, 40)
        : existing.port || "",
      username: nextUsername,
      passwordCiphertext: resolvePasswordCiphertext({
        password: Object.prototype.hasOwnProperty.call(req.body, "password") ? req.body.password : undefined,
        existing,
      }),
      remark: Object.prototype.hasOwnProperty.call(req.body, "remark")
        ? normalizeText(req.body.remark)
        : existing.remark || "",
      deleted: 0,
      createdAtMs: Number(existing.created_at_ms),
      updatedAtMs: Date.now(),
      deletedAtMs: null,
      sourceApp: normalizeText(req.body.sourceApp, 100) || existing.source_app || "",
    });

    return sendPasswordList(res);
  })
);

router.delete(
  "/passwords/:id",
  requireSyncToken,
  asyncHandler(async (req, res) => {
    const itemId = normalizeText(req.params.id, 120);
    const existing = await db.getWorkbenchPasswordItem({ namespace: DEFAULT_NAMESPACE, itemId });

    if (!existing || existing.deleted) {
      return res.status(404).json({ error: "Password item not found" });
    }

    const now = Date.now();
    await db.upsertWorkbenchPasswordItem({
      namespace: DEFAULT_NAMESPACE,
      itemId,
      name: existing.name,
      category: existing.category || "other",
      host: existing.host || "",
      port: existing.port || "",
      username: existing.username || "",
      passwordCiphertext: existing.password_ciphertext,
      remark: existing.remark || "",
      deleted: 1,
      createdAtMs: Number(existing.created_at_ms),
      updatedAtMs: now,
      deletedAtMs: now,
      sourceApp: normalizeText(req.body?.sourceApp, 100) || existing.source_app || "",
    });

    return sendPasswordList(res);
  })
);

router.post("/passwords/import", requireSyncToken, asyncHandler(importPasswords));
router.post("/passwords/sync", requireSyncToken, asyncHandler(importPasswords));

export default router;
