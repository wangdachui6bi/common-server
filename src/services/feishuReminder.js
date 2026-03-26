import dayjs from "dayjs";
import { db } from "../db/index.js";

const DEFAULT_NAMESPACE = "default";
const FEISHU_SETTINGS_KEY = "feishu_todo_settings";
const CHECK_INTERVAL_MS = 60 * 1000;
const DAILY_SUMMARY_HOUR = 9;
const DAILY_SUMMARY_MINUTE = 30;
const SHANGHAI_TIMEZONE = "Asia/Shanghai";

const defaultFeishuSettings = {
  webhook: "",
  autoEnabled: false,
};

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

function normalizeFeishuSettings(settings) {
  return {
    webhook: String(settings?.webhook || "").trim(),
    autoEnabled: Boolean(settings?.autoEnabled),
  };
}

function getShanghaiNowParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    hour: Number(byType.hour || 0),
    minute: Number(byType.minute || 0),
  };
}

function parseTodoMeta(row) {
  return parseJson(row.extra_json, null) || {};
}

function buildTodoLines(rows) {
  return rows.map((row, index) => {
    const meta = parseTodoMeta(row);
    const priorityMap = {
      high: "高优先",
      medium: "中优先",
      low: "低优先",
    };
    const date = String(meta.date || dayjs(Number(row.created_at_ms)).format("YYYY-MM-DD"));
    const time = String(meta.time || "").trim();
    const priority = priorityMap[String(meta.priority || "medium")] || "中优先";
    return `${index + 1}. ${row.text}\n日期：${date}${time ? ` ${time}` : ""}｜优先级：${priority}`;
  }).join("\n\n");
}

async function sendFeishuBotMessage({ webhook, title, text }) {
  const response = await fetch(webhook, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      msg_type: "text",
      content: {
        text: `${title}\n${text}`,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `飞书机器人请求失败: ${response.status}`);
  }

  const data = await response.json();
  if (data?.StatusCode && data.StatusCode !== 0) {
    throw new Error(data?.StatusMessage || "飞书机器人返回失败");
  }

  if (typeof data?.code === "number" && data.code !== 0) {
    throw new Error(data?.msg || "飞书机器人返回失败");
  }
}

export async function getFeishuTodoSettings(namespace = DEFAULT_NAMESPACE) {
  const row = await db.getSyncSetting({ namespace, settingKey: FEISHU_SETTINGS_KEY });
  return {
    ...defaultFeishuSettings,
    ...normalizeFeishuSettings(parseJson(row?.value_json, defaultFeishuSettings)),
  };
}

export async function saveFeishuTodoSettings(settings, namespace = DEFAULT_NAMESPACE) {
  const next = {
    ...defaultFeishuSettings,
    ...normalizeFeishuSettings(settings),
  };

  await db.upsertSyncSetting({
    namespace,
    settingKey: FEISHU_SETTINGS_KEY,
    valueJson: JSON.stringify(next),
    updatedAtMs: Date.now(),
  });

  return next;
}

export async function checkFeishuTodoReminders(namespace = DEFAULT_NAMESPACE) {
  const settings = await getFeishuTodoSettings(namespace);
  if (!settings.autoEnabled || !settings.webhook) {
    return { sent: 0, items: [] };
  }

  const shanghaiNow = getShanghaiNowParts();
  if (
    shanghaiNow.hour < DAILY_SUMMARY_HOUR ||
    (shanghaiNow.hour === DAILY_SUMMARY_HOUR && shanghaiNow.minute < DAILY_SUMMARY_MINUTE)
  ) {
    return { sent: 0, items: [] };
  }

  const reminderKey = `daily-summary:${shanghaiNow.date}`;
  const sent = await db.getReminderLog({ namespace, reminderKey });
  if (sent) {
    return { sent: 0, items: [] };
  }

  const rows = await db.listSyncedTodos(namespace);
  const dueRows = rows.filter((row) => {
    if (row.deleted || row.completed) {
      return false;
    }

    const meta = parseTodoMeta(row);
    const date = String(meta.date || "").trim();
    return date === shanghaiNow.date;
  });

  if (dueRows.length === 0) {
    return { sent: 0, items: [] };
  }

  await sendFeishuBotMessage({
    webhook: settings.webhook,
    title: "今日待办摘要",
    text: buildTodoLines(dueRows),
  });

  const sentAtMs = Date.now();
  await db.upsertReminderLog({ namespace, reminderKey, sentAtMs });

  return { sent: dueRows.length, items: dueRows.map((row) => row.todo_id) };
}

export function startFeishuReminderScheduler(namespace = DEFAULT_NAMESPACE) {
  const run = async () => {
    try {
      const result = await checkFeishuTodoReminders(namespace);
      if (result.sent > 0) {
        console.log(`[feishu-reminder] sent ${result.sent} reminders`);
      }
    } catch (error) {
      console.error("[feishu-reminder] scheduler failed", error);
    }
  };

  run();
  return setInterval(run, CHECK_INTERVAL_MS);
}
