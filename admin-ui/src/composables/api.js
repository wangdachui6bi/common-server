const BASE = import.meta.env.DEV ? "" : window.location.origin;

function getApiKey() {
  return sessionStorage.getItem("apiKey") || "";
}

export function setApiKey(key) {
  sessionStorage.setItem("apiKey", key);
}

export function clearApiKey() {
  sessionStorage.removeItem("apiKey");
}

export function isLoggedIn() {
  return !!getApiKey();
}

async function request(path, opts = {}) {
  const headers = { "X-API-Key": getApiKey(), ...opts.headers };
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });

  if (res.status === 401) {
    clearApiKey();
    window.location.hash = "#/login";
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export function fetchApps() {
  return request("/api/apps");
}

export function fetchReleases(appId, limit = 50, offset = 0) {
  return request(`/api/apps/${appId}/releases?limit=${limit}&offset=${offset}`);
}

export function deleteRelease(appId, version, platform) {
  return request(
    `/api/apps/${appId}/releases/${version}?platform=${platform}`,
    { method: "DELETE" }
  );
}

export async function uploadRelease(appId, form) {
  const res = await fetch(`${BASE}/api/apps/${appId}/releases`, {
    method: "POST",
    headers: { "X-API-Key": getApiKey() },
    body: form,
  });

  if (res.status === 401) {
    clearApiKey();
    window.location.hash = "#/login";
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}
