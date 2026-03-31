import { config } from "../config.js";
import { postFeishuTextMessage } from "./feishuWebhook.js";

async function postToFeishu(webhook, text) {
  await postFeishuTextMessage({ webhook, text });
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
