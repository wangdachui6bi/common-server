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

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const todoId = String(item.id || "").trim();
    const text = String(item.text || "").trim();
    if (!todoId || !text) {
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
    });
  }

  return sendTodoList(res);
}

router.get("/todos", requireSyncToken, async (_req, res) => {
  await sendTodoList(res);
});

router.post("/todos", requireSyncToken, async (req, res) => {
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
});

router.patch("/todos/:id", requireSyncToken, async (req, res) => {
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
});

router.delete("/todos/:id", requireSyncToken, async (req, res) => {
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
});

router.post("/todos/clear-completed", requireSyncToken, async (req, res) => {
  const rows = await db.listSyncedTodos(DEFAULT_NAMESPACE);
  const now = Date.now();
  const sourceApp = String(req.body?.sourceApp || "").trim().slice(0, 100);

  for (const row of rows) {
    if (!row.completed) {
      continue;
    }

    await db.upsertSyncedTodo({
      namespace: DEFAULT_NAMESPACE,
      todoId: row.todo_id,
      text: row.text,
      extraJson: row.extra_json,
      completed: 0,
      deleted: 1,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: now,
      deletedAtMs: now,
      sourceApp: sourceApp || row.source_app || "",
    });
  }

  return sendTodoList(res);
});

router.post("/todos/import", requireSyncToken, importTodos);
router.post("/todos/sync", requireSyncToken, importTodos);

export default router;
