import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const DEFAULT_TIMEOUT_MS = 15000;

function getRequestImpl(protocol) {
  if (protocol === "https:") {
    return httpsRequest;
  }

  if (protocol === "http:") {
    return httpRequest;
  }

  throw new Error(`Unsupported protocol: ${protocol}`);
}

async function postJson(url, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof fetch === "function") {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
    };
  }

  const target = new URL(url);
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = getRequestImpl(target.protocol)(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];

        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        res.on("end", () => {
          resolve({
            ok: Number(res.statusCode || 0) >= 200 && Number(res.statusCode || 0) < 300,
            status: Number(res.statusCode || 0),
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function postFeishuTextMessage({ webhook, text }) {
  const response = await postJson(webhook, {
    msg_type: "text",
    content: {
      text,
    },
  });

  if (!response.ok) {
    throw new Error(response.text || `Feishu webhook failed: ${response.status}`);
  }

  const data = parseJson(response.text);
  if (typeof data?.StatusCode === "number" && data.StatusCode !== 0) {
    throw new Error(data?.StatusMessage || "Feishu webhook returned an error");
  }

  if (typeof data?.code === "number" && data.code !== 0) {
    throw new Error(data?.msg || "Feishu webhook returned an error");
  }

  return data;
}
