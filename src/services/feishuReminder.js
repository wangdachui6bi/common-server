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

function pad2(value) {
  return String(value).padStart(2, "0");
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

function formatShanghaiDateFromTimestamp(timestamp) {
  return getShanghaiNowParts(new Date(Number(timestamp) || Date.now())).date;
}

function normalizeTodoDate(value, fallbackTimestamp) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  if (text) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
      return getShanghaiNowParts(parsed).date;
    }
  }

  return formatShanghaiDateFromTimestamp(fallbackTimestamp);
}

function normalizeTodoTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{1,2})/);
  if (!match) {
    return "";
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return "";
  }

  return `${pad2(hour)}:${pad2(minute)}`;
}

function getTodoSchedule(row) {
  const meta = parseTodoMeta(row);
  return {
    date: normalizeTodoDate(meta.date, row.created_at_ms),
    time: normalizeTodoTime(meta.time),
    priority: String(meta.priority || "medium"),
  };
}

function parseTodoMeta(row) {
  return parseJson(row.extra_json, null) || {};
}

function buildTodoLines(rows) {
  return rows.map((row, index) => {
    const schedule = getTodoSchedule(row);
    const priorityMap = {
      high: "高优先",
      medium: "中优先",
      low: "低优先",
    };
    const priority = priorityMap[schedule.priority] || "中优先";
    return `${index + 1}. ${row.text}\n日期：${schedule.date}${schedule.time ? ` ${schedule.time}` : ""}｜优先级：${priority}`;
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
    return { sent: 0, dueSent: 0, summarySent: 0, dueItems: [], summaryItems: [] };
  }

  const shanghaiNow = getShanghaiNowParts();
  const rows = await db.listSyncedTodos(namespace);
  const activeRows = rows.filter((row) => !row.deleted && !row.completed);

  const currentTimeKey = `${shanghaiNow.date} ${pad2(shanghaiNow.hour)}:${pad2(shanghaiNow.minute)}`;
  const dueCandidates = [];
  for (const row of activeRows) {
    const schedule = getTodoSchedule(row);
    if (!schedule.time) {
      continue;
    }

    const dueTimeKey = `${schedule.date} ${schedule.time}`;
    if (dueTimeKey > currentTimeKey) {
      continue;
    }

    const reminderKey = `todo-due:${row.todo_id}:${schedule.date}:${schedule.time}`;
    const sentLog = await db.getReminderLog({ namespace, reminderKey });
    if (sentLog) {
      continue;
    }

    dueCandidates.push({ row, reminderKey });
  }

  let dueSent = 0;
  const dueItems = [];
  if (dueCandidates.length > 0) {
    const dueRows = dueCandidates.map((item) => item.row);
    await sendFeishuBotMessage({
      webhook: settings.webhook,
      title: dueRows.length === 1 ? "待办到时间了" : "有几条待办到时间了",
      text: buildTodoLines(dueRows),
    });

    const sentAtMs = Date.now();
    await Promise.all(
      dueCandidates.map((item) => db.upsertReminderLog({
        namespace,
        reminderKey: item.reminderKey,
        sentAtMs,
      }))
    );
    dueSent = dueRows.length;
    dueItems.push(...dueRows.map((row) => row.todo_id));
  }

  let summarySent = 0;
  const summaryItems = [];
  const afterSummaryTime = (
    shanghaiNow.hour > DAILY_SUMMARY_HOUR ||
    (shanghaiNow.hour === DAILY_SUMMARY_HOUR && shanghaiNow.minute >= DAILY_SUMMARY_MINUTE)
  );

  if (afterSummaryTime) {
    const reminderKey = `daily-summary:${shanghaiNow.date}`;
    const sent = await db.getReminderLog({ namespace, reminderKey });
    if (!sent) {
      const todayRows = activeRows.filter((row) => getTodoSchedule(row).date === shanghaiNow.date);
      if (todayRows.length > 0) {
        await sendFeishuBotMessage({
          webhook: settings.webhook,
          title: "今日待办摘要",
          text: buildTodoLines(todayRows),
        });

        const sentAtMs = Date.now();
        await db.upsertReminderLog({ namespace, reminderKey, sentAtMs });
        summarySent = todayRows.length;
        summaryItems.push(...todayRows.map((row) => row.todo_id));
      }
    }
  }

  return {
    sent: dueSent + summarySent,
    dueSent,
    summarySent,
    dueItems,
    summaryItems,
  };
}

export function startFeishuReminderScheduler(namespace = DEFAULT_NAMESPACE) {
  const run = async () => {
    try {
      const result = await checkFeishuTodoReminders(namespace);
      if (result.sent > 0) {
        console.log(
          `[feishu-reminder] sent total=${result.sent}, due=${result.dueSent}, summary=${result.summarySent}`
        );
      }
    } catch (error) {
      console.error("[feishu-reminder] scheduler failed", error);
    }
  };

  run();
  return setInterval(run, CHECK_INTERVAL_MS);
}
