import { Router } from "express";
import { db } from "../db/index.js";
import { requireSyncToken } from "../middleware/auth.js";
import {
  checkFeishuTodoReminders,
  getFeishuTodoSettings,
  saveFeishuTodoSettings,
} from "../services/feishuReminder.js";

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

function serializeTodo(row) {
  let meta = null;

  if (row.extra_json) {
    try {
      meta = JSON.parse(row.extra_json);
    } catch {
      meta = null;
    }
  }

  return {
    id: row.todo_id,
    text: row.text,
    completed: !!row.completed,
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    deletedAt: row.deleted_at_ms ? new Date(Number(row.deleted_at_ms)).toISOString() : null,
    meta,
  };
}

async function sendTodoList(res, options = {}) {
  const rows = await db.listSyncedTodos(DEFAULT_NAMESPACE, options);
  res.json({
    total: rows.length,
    serverTime: new Date().toISOString(),
    items: rows.map(serializeTodo),
  });
}

async function importTodos(req, res) {
  const sourceApp = String(req.body.sourceApp || "").trim().slice(0, 100);
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const todoIds = [];
  const seenTodoIds = new Set();

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const todoId = String(item.id || "").trim();
    if (todoId && !seenTodoIds.has(todoId)) {
      seenTodoIds.add(todoId);
      todoIds.push(todoId);
    }
  }

  const existingRows = await db.getSyncedTodosByIds({
    namespace: DEFAULT_NAMESPACE,
    todoIds,
  });
  const currentById = new Map(existingRows.map((row) => [row.todo_id, row]));
  const pendingUpserts = new Map();

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const todoId = String(item.id || "").trim();
    const text = String(item.text || "").trim();
    if (!todoId || !text) {
      continue;
    }

    const existing = currentById.get(todoId) || null;
    const createdAtMs = toTimestamp(item.createdAt);
    const updatedAtMs = toTimestamp(item.updatedAt, createdAtMs);
    const deletedAtMs = item.deletedAt ? toTimestamp(item.deletedAt, updatedAtMs) : null;

    if (existing && Number(existing.updated_at_ms) > updatedAtMs) {
      continue;
    }

    const nextRow = {
      namespace: DEFAULT_NAMESPACE,
      todoId,
      text,
      extraJson: item.meta ? JSON.stringify(item.meta) : null,
      completed: deletedAtMs ? 0 : item.completed ? 1 : 0,
      deleted: deletedAtMs ? 1 : 0,
      createdAtMs: existing
        ? Math.min(Number(existing.created_at_ms), createdAtMs)
        : createdAtMs,
      updatedAtMs,
      deletedAtMs,
      sourceApp,
    };

    pendingUpserts.set(todoId, nextRow);
    currentById.set(todoId, {
      todo_id: todoId,
      text: nextRow.text,
      extra_json: nextRow.extraJson,
      completed: nextRow.completed,
      deleted: nextRow.deleted,
      created_at_ms: nextRow.createdAtMs,
      updated_at_ms: nextRow.updatedAtMs,
      deleted_at_ms: nextRow.deletedAtMs,
      source_app: nextRow.sourceApp,
    });
  }

  if (pendingUpserts.size > 0) {
    await db.bulkUpsertSyncedTodos([...pendingUpserts.values()]);
  }

  return sendTodoList(res);
}

router.get("/todos", requireSyncToken, asyncHandler(async (_req, res) => {
  await sendTodoList(res);
}));

router.post("/todos", requireSyncToken, asyncHandler(async (req, res) => {
  const todoId = String(req.body.id || "").trim();
  const text = String(req.body.text || "").trim();

  if (!todoId) {
    return res.status(400).json({ error: "id is required" });
  }

  if (!text) {
    return res.status(400).json({ error: "text is required" });
  }

  const existing = await db.getSyncedTodo({ namespace: DEFAULT_NAMESPACE, todoId });
  if (existing && !existing.deleted) {
    return res.status(409).json({ error: "Todo already exists" });
  }

  const createdAtMs = toTimestamp(req.body.createdAt);
  const updatedAtMs = Date.now();

  await db.upsertSyncedTodo({
    namespace: DEFAULT_NAMESPACE,
    todoId,
    text,
    extraJson: req.body.meta ? JSON.stringify(req.body.meta) : null,
    completed: req.body.completed ? 1 : 0,
    deleted: 0,
    createdAtMs: existing ? Number(existing.created_at_ms) : createdAtMs,
    updatedAtMs,
    deletedAtMs: null,
    sourceApp: String(req.body.sourceApp || "").trim().slice(0, 100),
  });

  return sendTodoList(res);
}));

router.patch("/todos/:id", requireSyncToken, asyncHandler(async (req, res) => {
  const todoId = String(req.params.id || "").trim();
  const existing = await db.getSyncedTodo({ namespace: DEFAULT_NAMESPACE, todoId });

  if (!existing || existing.deleted) {
    return res.status(404).json({ error: "Todo not found" });
  }

  const nextText = typeof req.body.text === "string" ? req.body.text.trim() : existing.text;
  if (!nextText) {
    return res.status(400).json({ error: "text cannot be empty" });
  }

  await db.upsertSyncedTodo({
    namespace: DEFAULT_NAMESPACE,
    todoId,
    text: nextText,
    extraJson: Object.prototype.hasOwnProperty.call(req.body, "meta")
      ? (req.body.meta ? JSON.stringify(req.body.meta) : null)
      : existing.extra_json,
    completed: typeof req.body.completed === "boolean" ? (req.body.completed ? 1 : 0) : Number(existing.completed),
    deleted: 0,
    createdAtMs: Number(existing.created_at_ms),
    updatedAtMs: Date.now(),
    deletedAtMs: null,
    sourceApp: String(req.body.sourceApp || "").trim().slice(0, 100) || existing.source_app || "",
  });

  return sendTodoList(res);
}));

router.delete("/todos/:id", requireSyncToken, asyncHandler(async (req, res) => {
  const todoId = String(req.params.id || "").trim();
  const existing = await db.getSyncedTodo({ namespace: DEFAULT_NAMESPACE, todoId });

  if (!existing || existing.deleted) {
    return res.status(404).json({ error: "Todo not found" });
  }

  const now = Date.now();
  await db.upsertSyncedTodo({
    namespace: DEFAULT_NAMESPACE,
    todoId,
    text: existing.text,
    extraJson: existing.extra_json,
    completed: 0,
    deleted: 1,
    createdAtMs: Number(existing.created_at_ms),
    updatedAtMs: now,
    deletedAtMs: now,
    sourceApp: String(req.body?.sourceApp || "").trim().slice(0, 100) || existing.source_app || "",
  });

  return sendTodoList(res);
}));

router.post("/todos/clear-completed", requireSyncToken, asyncHandler(async (req, res) => {
  const now = Date.now();
  const sourceApp = String(req.body?.sourceApp || "").trim().slice(0, 100);
  await db.softDeleteCompletedSyncedTodos({
    namespace: DEFAULT_NAMESPACE,
    updatedAtMs: now,
    sourceApp,
  });

  return sendTodoList(res);
}));

router.post("/todos/import", requireSyncToken, asyncHandler(importTodos));
router.post("/todos/sync", requireSyncToken, asyncHandler(importTodos));

router.get("/feishu/settings", requireSyncToken, asyncHandler(async (_req, res) => {
  const settings = await getFeishuTodoSettings(DEFAULT_NAMESPACE);
  res.json({
    settings,
    serverTime: new Date().toISOString(),
  });
}));

router.put("/feishu/settings", requireSyncToken, asyncHandler(async (req, res) => {
  const settings = await saveFeishuTodoSettings(req.body || {}, DEFAULT_NAMESPACE);
  res.json({
    settings,
    serverTime: new Date().toISOString(),
  });
}));

router.post("/feishu/check", requireSyncToken, asyncHandler(async (_req, res) => {
  const result = await checkFeishuTodoReminders(DEFAULT_NAMESPACE);
  res.json({
    ...result,
    serverTime: new Date().toISOString(),
  });
}));

export default router;
