import { randomUUID } from "crypto";
import { Router } from "express";
import pool from "../db/index.js";
import { requireMenuAccess } from "../middleware/auth.js";
import { notifyMenuUpdate } from "../services/menuNotifier.js";

const router = Router();
const liveClients = new Set();

const RECOMMENDATIONS = [
  { name: "番茄牛腩", category: "家常炖菜", reason: "酸甜稳妥，适合两个人一起吃。", tags: ["下饭", "周末"] },
  { name: "蒜蓉粉丝虾", category: "海鲜", reason: "仪式感强，上桌就很有幸福感。", tags: ["约会", "快手"] },
  { name: "可乐鸡翅", category: "鸡肉", reason: "基本不挑人，做起来也很稳。", tags: ["甜口", "轻松"] },
  { name: "青椒牛肉丝", category: "快炒", reason: "十几分钟能出锅，工作日很友好。", tags: ["工作日", "下饭"] },
  { name: "麻婆豆腐", category: "川味", reason: "成本低但满足感很高。", tags: ["辣", "性价比"] },
  { name: "香菇滑鸡", category: "鸡肉", reason: "口味温和，比较适合反复做。", tags: ["电饭煲", "家常"] },
  { name: "酸汤肥牛", category: "汤锅", reason: "适合下班后快速提振胃口。", tags: ["开胃", "微辣"] },
  { name: "咖喱土豆鸡", category: "咖喱", reason: "一锅搞定，第二天拌饭也很好吃。", tags: ["一锅", "拌饭"] },
  { name: "照烧三文鱼", category: "轻食", reason: "适合想吃得清爽一点的晚上。", tags: ["轻负担", "好看"] },
  { name: "辣椒炒肉", category: "湘味", reason: "非常下饭，适合重口味日。", tags: ["重口", "快炒"] },
];

function now() {
  return Date.now();
}

function parseJson(value, fallback) {
  if (!value || typeof value !== "string") {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function makeId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function normalizeActor(value) {
  const actor = String(value || "").trim().slice(0, 60);
  return actor || "未署名";
}

function serializeDish(row) {
  return {
    id: row.dish_id,
    name: row.name,
    category: row.category,
    description: row.description,
    imageData: row.image_data || "",
    tags: parseJson(row.tags_json, []),
    sourceType: row.source_type,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
  };
}

function serializeRequest(row) {
  return {
    id: row.request_id,
    dishId: row.dish_id || "",
    dishName: row.dish_name,
    requestType: row.request_type,
    note: row.note,
    requestedBy: row.requested_by,
    status: row.status,
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
  };
}

function serializeComment(row) {
  return {
    id: row.comment_id,
    targetType: row.target_type,
    targetId: row.target_id,
    content: row.content,
    author: row.author,
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
  };
}

function serializeEvent(row) {
  return {
    id: Number(row.id),
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    payload: parseJson(row.payload_json, null),
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
  };
}

async function fetchOne(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function fetchState() {
  const [dishesRows, requestRows, commentRows, eventRows] = await Promise.all([
    pool.execute(`SELECT * FROM couple_menu_dishes ORDER BY updated_at_ms DESC`),
    pool.execute(`SELECT * FROM couple_menu_requests ORDER BY updated_at_ms DESC`),
    pool.execute(`SELECT * FROM couple_menu_comments ORDER BY created_at_ms DESC LIMIT 300`),
    pool.execute(`SELECT * FROM couple_menu_events ORDER BY created_at_ms DESC LIMIT 120`),
  ]);

  return {
    serverTime: new Date().toISOString(),
    dishes: dishesRows[0].map(serializeDish),
    requests: requestRows[0].map(serializeRequest),
    comments: commentRows[0].map(serializeComment),
    events: eventRows[0].map(serializeEvent),
    recommendations: RECOMMENDATIONS,
  };
}

async function sendState(res) {
  res.json(await fetchState());
}

async function recordEvent({ eventType, entityType, entityId, summary, payload }) {
  await pool.execute(
    `INSERT INTO couple_menu_events (event_type, entity_type, entity_id, summary, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      eventType,
      entityType,
      entityId,
      summary,
      payload ? JSON.stringify(payload) : null,
      now(),
    ]
  );
}

function broadcastRefresh(reason) {
  const message = `event: refresh\ndata: ${JSON.stringify({
    reason,
    timestamp: new Date().toISOString(),
  })}\n\n`;

  for (const client of liveClients) {
    try {
      client.write(message);
    } catch {
      liveClients.delete(client);
    }
  }
}

function notifyAsync(title, lines) {
  notifyMenuUpdate(title, lines).catch((error) => {
    console.error("[menu-board] feishu push failed", error);
  });
}

router.use(requireMenuAccess);

router.get("/bootstrap", async (_req, res) => {
  await sendState(res);
});

router.get("/recommendations", (_req, res) => {
  res.json({ items: RECOMMENDATIONS });
});

router.get("/events/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, timestamp: new Date().toISOString() })}\n\n`);
  liveClients.add(res);

  req.on("close", () => {
    liveClients.delete(res);
  });
});

router.post("/dishes", async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  const actor = normalizeActor(req.body.actor);
  const timestamp = now();
  const dishId = makeId("dish");
  await pool.execute(
    `INSERT INTO couple_menu_dishes
      (dish_id, name, category, description, image_data, tags_json, source_type, created_by, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dishId,
      name,
      String(req.body.category || "").trim().slice(0, 80),
      String(req.body.description || "").trim(),
      req.body.imageData ? String(req.body.imageData) : null,
      JSON.stringify(Array.isArray(req.body.tags) ? req.body.tags.filter(Boolean).slice(0, 12) : []),
      String(req.body.sourceType || "custom").trim().slice(0, 30) || "custom",
      actor,
      actor,
      timestamp,
      timestamp,
    ]
  );

  await recordEvent({
    eventType: "dish_created",
    entityType: "dish",
    entityId: dishId,
    summary: `${actor} 添加了「${name}」到共享菜单`,
    payload: { actor, name },
  });

  broadcastRefresh("dish_created");
  await sendState(res);
});

router.put("/dishes/:id", async (req, res) => {
  const dishId = String(req.params.id || "").trim();
  const existing = await fetchOne(`SELECT * FROM couple_menu_dishes WHERE dish_id = ? LIMIT 1`, [dishId]);
  if (!existing) {
    return res.status(404).json({ error: "Dish not found" });
  }

  const name = String(req.body.name || existing.name).trim();
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  const actor = normalizeActor(req.body.actor || existing.updated_by);
  await pool.execute(
    `UPDATE couple_menu_dishes
     SET name = ?, category = ?, description = ?, image_data = ?, tags_json = ?, source_type = ?, updated_by = ?, updated_at_ms = ?
     WHERE dish_id = ?`,
    [
      name,
      String(req.body.category ?? existing.category).trim().slice(0, 80),
      String(req.body.description ?? existing.description).trim(),
      Object.prototype.hasOwnProperty.call(req.body, "imageData")
        ? (req.body.imageData ? String(req.body.imageData) : null)
        : existing.image_data,
      JSON.stringify(
        Array.isArray(req.body.tags)
          ? req.body.tags.filter(Boolean).slice(0, 12)
          : parseJson(existing.tags_json, [])
      ),
      String(req.body.sourceType || existing.source_type).trim().slice(0, 30) || "custom",
      actor,
      now(),
      dishId,
    ]
  );

  await recordEvent({
    eventType: "dish_updated",
    entityType: "dish",
    entityId: dishId,
    summary: `${actor} 更新了「${name}」`,
    payload: { actor, name },
  });

  broadcastRefresh("dish_updated");
  await sendState(res);
});

router.delete("/dishes/:id", async (req, res) => {
  const dishId = String(req.params.id || "").trim();
  const existing = await fetchOne(`SELECT * FROM couple_menu_dishes WHERE dish_id = ? LIMIT 1`, [dishId]);
  if (!existing) {
    return res.status(404).json({ error: "Dish not found" });
  }

  const actor = normalizeActor(req.body?.actor || "未署名");
  await pool.execute(`DELETE FROM couple_menu_dishes WHERE dish_id = ?`, [dishId]);
  await pool.execute(`DELETE FROM couple_menu_comments WHERE target_type = 'dish' AND target_id = ?`, [dishId]);

  await recordEvent({
    eventType: "dish_deleted",
    entityType: "dish",
    entityId: dishId,
    summary: `${actor} 删除了「${existing.name}」`,
    payload: { actor, name: existing.name },
  });

  broadcastRefresh("dish_deleted");
  await sendState(res);
});

router.post("/dishes/import", async (req, res) => {
  const actor = normalizeActor(req.body.actor);
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const imported = [];

  for (const item of items) {
    const name = String(item?.name || "").trim();
    if (!name) {
      continue;
    }

    const duplicate = await fetchOne(
      `SELECT dish_id FROM couple_menu_dishes WHERE LOWER(name) = LOWER(?) LIMIT 1`,
      [name]
    );
    if (duplicate) {
      continue;
    }

    const dishId = makeId("dish");
    const timestamp = now();
    await pool.execute(
      `INSERT INTO couple_menu_dishes
        (dish_id, name, category, description, image_data, tags_json, source_type, created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dishId,
        name,
        String(item.category || "").trim().slice(0, 80),
        String(item.description || "").trim(),
        item.imageData ? String(item.imageData) : null,
        JSON.stringify(Array.isArray(item.tags) ? item.tags.filter(Boolean).slice(0, 12) : []),
        String(item.sourceType || "import").trim().slice(0, 30) || "import",
        actor,
        actor,
        timestamp,
        timestamp,
      ]
    );
    imported.push(name);
  }

  await recordEvent({
    eventType: "dish_imported",
    entityType: "dish",
    entityId: imported[0] ? "batch" : "none",
    summary: imported.length
      ? `${actor} 批量导入了 ${imported.length} 道菜`
      : `${actor} 尝试导入菜品，但没有新增内容`,
    payload: { actor, imported },
  });

  broadcastRefresh("dish_imported");
  await sendState(res);
});

router.post("/requests", async (req, res) => {
  const actor = normalizeActor(req.body.actor);
  const dishId = String(req.body.dishId || "").trim();
  let dishName = String(req.body.dishName || "").trim();

  if (dishId) {
    const dish = await fetchOne(`SELECT * FROM couple_menu_dishes WHERE dish_id = ? LIMIT 1`, [dishId]);
    if (!dish) {
      return res.status(404).json({ error: "Dish not found" });
    }
    dishName = dish.name;
  }

  if (!dishName) {
    return res.status(400).json({ error: "dishName is required" });
  }

  const requestId = makeId("req");
  const timestamp = now();
  await pool.execute(
    `INSERT INTO couple_menu_requests
      (request_id, dish_id, dish_name, request_type, note, requested_by, status, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      requestId,
      dishId || null,
      dishName,
      dishId ? "menu" : "wish",
      String(req.body.note || "").trim(),
      actor,
      "pending",
      timestamp,
      timestamp,
    ]
  );

  const note = String(req.body.note || "").trim();
  await recordEvent({
    eventType: "request_created",
    entityType: "request",
    entityId: requestId,
    summary: `${actor} 想吃「${dishName}」`,
    payload: { actor, dishName, note },
  });

  broadcastRefresh("request_created");
  notifyAsync("点菜单来了", [
    `${actor} 想吃：${dishName}`,
    note ? `备注：${note}` : "",
    "打开共享点菜台看看要不要安排上桌。",
  ]);
  await sendState(res);
});

router.patch("/requests/:id", async (req, res) => {
  const requestId = String(req.params.id || "").trim();
  const existing = await fetchOne(`SELECT * FROM couple_menu_requests WHERE request_id = ? LIMIT 1`, [requestId]);
  if (!existing) {
    return res.status(404).json({ error: "Request not found" });
  }

  const actor = normalizeActor(req.body.actor);
  const nextStatus = String(req.body.status || existing.status).trim().slice(0, 20) || existing.status;
  const nextNote = Object.prototype.hasOwnProperty.call(req.body, "note")
    ? String(req.body.note || "").trim()
    : existing.note;

  await pool.execute(
    `UPDATE couple_menu_requests
     SET status = ?, note = ?, updated_at_ms = ?
     WHERE request_id = ?`,
    [nextStatus, nextNote, now(), requestId]
  );

  await recordEvent({
    eventType: "request_updated",
    entityType: "request",
    entityId: requestId,
    summary: `${actor} 把「${existing.dish_name}」改成了 ${nextStatus}`,
    payload: { actor, dishName: existing.dish_name, status: nextStatus, note: nextNote },
  });

  broadcastRefresh("request_updated");
  notifyAsync("点单状态更新", [
    `${actor} 更新了「${existing.dish_name}」`,
    `状态：${nextStatus}`,
    nextNote ? `备注：${nextNote}` : "",
  ]);
  await sendState(res);
});

router.post("/comments", async (req, res) => {
  const actor = normalizeActor(req.body.actor);
  const targetType = String(req.body.targetType || "").trim();
  const targetId = String(req.body.targetId || "").trim();
  const content = String(req.body.content || "").trim();

  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }
  if (!["dish", "request"].includes(targetType)) {
    return res.status(400).json({ error: "targetType must be dish or request" });
  }
  if (!targetId) {
    return res.status(400).json({ error: "targetId is required" });
  }

  const targetTable = targetType === "dish" ? "couple_menu_dishes" : "couple_menu_requests";
  const targetIdField = targetType === "dish" ? "dish_id" : "request_id";
  const target = await fetchOne(`SELECT * FROM ${targetTable} WHERE ${targetIdField} = ? LIMIT 1`, [targetId]);
  if (!target) {
    return res.status(404).json({ error: "Target not found" });
  }

  const commentId = makeId("comment");
  await pool.execute(
    `INSERT INTO couple_menu_comments (comment_id, target_type, target_id, content, author, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [commentId, targetType, targetId, content, actor, now()]
  );

  const targetName = targetType === "dish" ? target.name : target.dish_name;
  await recordEvent({
    eventType: "comment_created",
    entityType: targetType,
    entityId: targetId,
    summary: `${actor} 评论了「${targetName}」`,
    payload: { actor, targetType, targetId, content, targetName },
  });

  broadcastRefresh("comment_created");
  notifyAsync("共享菜单有新评论", [
    `${actor} 评论了：${targetName}`,
    `内容：${content}`,
  ]);
  await sendState(res);
});

export default router;
