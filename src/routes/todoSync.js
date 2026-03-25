import { Router } from "express";
import { db } from "../db/index.js";
import { requireSyncToken } from "../middleware/auth.js";

const router = Router();
const DEFAULT_NAMESPACE = "default";

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
  return {
    id: row.todo_id,
    text: row.text,
    completed: !!row.completed,
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    deletedAt: row.deleted_at_ms ? new Date(Number(row.deleted_at_ms)).toISOString() : null,
  };
}

router.get("/todos", requireSyncToken, async (req, res) => {
  const rows = await db.listSyncedTodos(DEFAULT_NAMESPACE);

  res.json({
    total: rows.length,
    serverTime: new Date().toISOString(),
    items: rows.map(serializeTodo),
  });
});

router.post("/todos/sync", requireSyncToken, async (req, res) => {
  const sourceApp = String(req.body.sourceApp || "").trim().slice(0, 100);
  const items = Array.isArray(req.body.items) ? req.body.items : [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const todoId = String(item.id || "").trim();
    if (!todoId) {
      continue;
    }

    const existing = await db.getSyncedTodo({ namespace: DEFAULT_NAMESPACE, todoId });
    const createdAtMs = toTimestamp(item.createdAt);
    const updatedAtMs = toTimestamp(item.updatedAt, createdAtMs);
    const deletedAtMs = item.deletedAt ? toTimestamp(item.deletedAt, updatedAtMs) : null;

    if (existing && Number(existing.updated_at_ms) > updatedAtMs) {
      continue;
    }

    await db.upsertSyncedTodo({
      namespace: DEFAULT_NAMESPACE,
      todoId,
      text: String(item.text || "").trim(),
      completed: deletedAtMs ? 0 : item.completed ? 1 : 0,
      deleted: deletedAtMs ? 1 : 0,
      createdAtMs: existing
        ? Math.min(Number(existing.created_at_ms), createdAtMs)
        : createdAtMs,
      updatedAtMs,
      deletedAtMs,
      sourceApp,
    });
  }

  const rows = await db.listSyncedTodos(DEFAULT_NAMESPACE);

  res.json({
    total: rows.length,
    serverTime: new Date().toISOString(),
    items: rows.map(serializeTodo),
  });
});

export default router;
