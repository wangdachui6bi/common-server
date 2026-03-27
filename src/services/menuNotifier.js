import { config } from "../config.js";

async function postToFeishu(webhook, text) {
  const response = await fetch(webhook, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      msg_type: "text",
      content: {
        text,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Feishu webhook failed: ${response.status}`);
  }

  const data = await response.json();
  if (typeof data?.StatusCode === "number" && data.StatusCode !== 0) {
    throw new Error(data?.StatusMessage || "Feishu webhook returned an error");
  }
  if (typeof data?.code === "number" && data.code !== 0) {
    throw new Error(data?.msg || "Feishu webhook returned an error");
  }
}

export async function notifyMenuUpdate(title, lines = []) {
  const webhook = String(config.menuFeishuWebhook || "").trim();
  if (!webhook) {
    return { sent: false };
  }

  const body = [title, ...lines.filter(Boolean)].join("\n");
  await postToFeishu(webhook, body);
  return { sent: true };
}
