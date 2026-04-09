import archiver from "archiver";
import { randomBytes, randomUUID } from "crypto";
import { extname } from "path";
import { Router } from "express";
import multer from "multer";
import pool from "../db/index.js";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { listUsers } from "../services/authSession.js";
import {
  createStoredObjectReadStream,
  getStorageInfo,
  getUploadTempDir,
  removeStoredObject,
  sendStoredObject,
  storeUploadedFile,
} from "../services/mediaStorage.js";

const router = Router();
const upload = multer({
  dest: getUploadTempDir(),
  limits: {
    fileSize: 1024 * 1024 * 1024,
    files: 24,
  },
});

const SHARE_LINK_DEFAULT_HOURS = 24;
const SHARE_LINK_MAX_HOURS = 24 * 30;

function now() {
  return Date.now();
}

function makeId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function makeShareToken() {
  return randomBytes(24).toString("hex");
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

function normalizeMillis(value) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toIso(value) {
  return value ? new Date(Number(value)).toISOString() : null;
}

function pickMediaType(mimeType) {
  return String(mimeType || "").startsWith("video/") ? "video" : "image";
}

function actorFromRequest(req) {
  return String(req.authUser?.displayName || "未署名").trim().slice(0, 60) || "未署名";
}

function actorFromShareRequest(req) {
  return String(req.body.visitorName || req.body.nickname || "共享访客").trim().slice(0, 60) || "共享访客";
}

function safeFileName(value, fallback = "download") {
  return String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120) || fallback;
}

function buildContentDisposition(filename, disposition) {
  const safeName = safeFileName(filename, "download");
  return `${disposition}; filename="${safeName.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function buildAssetUrls(req, assetId, shareToken = "") {
  if (shareToken) {
    const base = `${config.baseUrl.replace(/\/$/, "")}/api/gallery/share/${encodeURIComponent(shareToken)}/assets/${assetId}/file`;
    return {
      previewUrl: base,
      downloadUrl: `${base}?download=1`,
    };
  }

  const token = req.authToken || "";
  const base = `${config.baseUrl.replace(/\/$/, "")}/api/gallery/assets/${assetId}/file`;
  const tokenQuery = token ? `auth_token=${encodeURIComponent(token)}` : "";

  return {
    previewUrl: `${base}${tokenQuery ? `?${tokenQuery}` : ""}`,
    downloadUrl: `${base}?download=1${tokenQuery ? `&${tokenQuery}` : ""}`,
  };
}

function parseSelectedAssetIds(value) {
  if (!value) {
    return [];
  }

  const raw = Array.isArray(value) ? value : [value];
  const result = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    for (const part of item.split(",")) {
      const normalized = part.trim();
      if (normalized && !result.includes(normalized)) {
        result.push(normalized);
      }
    }
  }
  return result;
}

async function fetchOne(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function ensureDefaultAlbum(user) {
  const existing = await fetchOne(
    `SELECT album_id FROM shared_gallery_albums
     WHERE owner_user_id = ? AND name = '我的相册'
     ORDER BY created_at_ms ASC
     LIMIT 1`,
    [user.id]
  );
  if (existing?.album_id) {
    return existing.album_id;
  }

  const albumId = makeId("album");
  const timestamp = now();
  await pool.execute(
    `INSERT INTO shared_gallery_albums
      (album_id, name, description, visibility, owner_user_id, created_by, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [albumId, "我的相册", "默认私人空间", "private", user.id, user.displayName, user.displayName, timestamp, timestamp]
  );
  return albumId;
}

async function refreshAlbumCover(albumId) {
  const nextCover = await fetchOne(
    `SELECT asset_id FROM shared_gallery_assets WHERE album_id = ? ORDER BY created_at_ms DESC LIMIT 1`,
    [albumId]
  );

  await pool.execute(
    `UPDATE shared_gallery_albums SET cover_asset_id = ?, updated_at_ms = ? WHERE album_id = ?`,
    [nextCover?.asset_id || null, now(), albumId]
  );
}

async function fetchAccessibleAlbums(userId) {
  const [rows] = await pool.execute(
    `SELECT a.*,
            COALESCE(m.role, 'owner') AS current_role
     FROM shared_gallery_albums a
     LEFT JOIN shared_gallery_album_members m
       ON m.album_id = a.album_id
      AND m.user_id = ?
     WHERE a.owner_user_id = ?
        OR m.user_id IS NOT NULL
     ORDER BY a.updated_at_ms DESC`,
    [userId, userId]
  );

  return Array.isArray(rows) ? rows : [];
}

async function fetchAlbumMembers(albumIds) {
  if (!albumIds.length) {
    return [];
  }

  const placeholders = albumIds.map(() => "?").join(", ");
  const [rows] = await pool.execute(
    `SELECT m.*, u.username, u.display_name
     FROM shared_gallery_album_members m
     JOIN app_users u ON u.user_id = m.user_id
     WHERE m.album_id IN (${placeholders})
     ORDER BY m.updated_at_ms ASC`,
    albumIds
  );

  return Array.isArray(rows) ? rows : [];
}

async function fetchAlbumShareLinks(albumIds) {
  if (!albumIds.length) {
    return [];
  }

  const placeholders = albumIds.map(() => "?").join(", ");
  const [rows] = await pool.execute(
    `SELECT *
     FROM shared_gallery_share_links
     WHERE album_id IN (${placeholders})
     ORDER BY updated_at_ms DESC`,
    albumIds
  );

  return Array.isArray(rows) ? rows : [];
}

function serializeShareLink(row) {
  const revokedAt = row.revoked_at_ms === null || row.revoked_at_ms === undefined ? null : toIso(row.revoked_at_ms);
  const expiresAt = toIso(row.expires_at_ms);
  const expired = Boolean(row.revoked_at_ms) || Number(row.expires_at_ms) <= now();

  return {
    id: row.link_id,
    albumId: row.album_id,
    token: row.share_token,
    title: row.title,
    permission: row.permission === "viewer" ? "viewer" : "contributor",
    allowUpload: row.permission !== "viewer",
    allowDownload: Boolean(row.allow_download),
    isExpired: expired,
    expiresAt,
    createdAt: toIso(row.created_at_ms),
    updatedAt: toIso(row.updated_at_ms),
    revokedAt,
  };
}

function serializeAlbum(row, members, currentUserId, shareLinks) {
  return {
    id: row.album_id,
    name: row.name,
    description: row.description,
    visibility: row.visibility || "private",
    ownerUserId: row.owner_user_id,
    coverAssetId: row.cover_asset_id || null,
    assetCount: Number(row.asset_count || 0),
    currentRole: row.owner_user_id === currentUserId ? "owner" : row.current_role || "viewer",
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    members,
    shareLinks,
  };
}

function serializeComment(row) {
  return {
    id: row.comment_id,
    assetId: row.asset_id,
    content: row.content,
    author: row.author,
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
  };
}

function serializeAsset(row, albumMap, req, shareToken = "") {
  const urls = buildAssetUrls(req, row.asset_id, shareToken);
  return {
    id: row.asset_id,
    albumId: row.album_id,
    albumName: albumMap.get(row.album_id)?.name || "相册",
    originalName: row.original_name,
    caption: row.caption || "",
    mimeType: row.mime_type,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes || 0),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    isFavorite: Boolean(row.is_favorite),
    storageProvider: row.storage_provider,
    uploadedBy: row.uploaded_by,
    takenAt: toIso(row.taken_at_ms),
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    previewUrl: urls.previewUrl,
    downloadUrl: urls.downloadUrl,
  };
}

async function getAlbumAccess(albumId, userId) {
  const album = await fetchOne(
    `SELECT a.*,
            m.role AS member_role
     FROM shared_gallery_albums a
     LEFT JOIN shared_gallery_album_members m
       ON m.album_id = a.album_id
      AND m.user_id = ?
     WHERE a.album_id = ?
     LIMIT 1`,
    [userId, albumId]
  );

  if (!album) {
    return null;
  }

  const role = album.owner_user_id === userId ? "owner" : album.member_role || null;
  return {
    album,
    role,
    canView: Boolean(role),
    canEdit: role === "owner" || role === "editor",
    canManage: role === "owner",
  };
}

async function getShareLinkAccess(shareToken) {
  const row = await fetchOne(
    `SELECT l.*,
            a.name AS album_name,
            a.description AS album_description,
            a.visibility AS album_visibility,
            a.owner_user_id,
            a.cover_asset_id,
            a.created_by,
            a.updated_by,
            a.created_at_ms AS album_created_at_ms,
            a.updated_at_ms AS album_updated_at_ms
     FROM shared_gallery_share_links l
     JOIN shared_gallery_albums a ON a.album_id = l.album_id
     WHERE l.share_token = ?
     LIMIT 1`,
    [shareToken]
  );

  if (!row) {
    return null;
  }

  const isExpired = Boolean(row.revoked_at_ms) || Number(row.expires_at_ms) <= now();
  return {
    shareLink: {
      id: row.link_id,
      albumId: row.album_id,
      token: row.share_token,
      title: row.title,
      permission: row.permission === "viewer" ? "viewer" : "contributor",
      allowUpload: row.permission !== "viewer",
      allowDownload: Boolean(row.allow_download),
      expiresAt: toIso(row.expires_at_ms),
      revokedAt: toIso(row.revoked_at_ms),
      isExpired,
    },
    album: {
      album_id: row.album_id,
      name: row.album_name,
      description: row.album_description,
      visibility: row.album_visibility,
      owner_user_id: row.owner_user_id,
      cover_asset_id: row.cover_asset_id,
      created_by: row.created_by,
      updated_by: row.updated_by,
      created_at_ms: row.album_created_at_ms,
      updated_at_ms: row.album_updated_at_ms,
    },
    canView: !isExpired,
    canUpload: !isExpired && row.permission !== "viewer",
    canDownload: !isExpired && Boolean(row.allow_download),
    isExpired,
  };
}

function shareErrorStatus(access) {
  return access?.isExpired ? 410 : 404;
}

function shareErrorMessage(access) {
  return access?.isExpired ? "Share link expired" : "Share link not found";
}

async function fetchGalleryState(req) {
  await ensureDefaultAlbum(req.authUser);

  const albumsRaw = await fetchAccessibleAlbums(req.authUser.id);
  const albumIds = albumsRaw.map((item) => item.album_id);
  const [countRows, assetRows, commentRows, memberRows, shareLinkRows] = await Promise.all([
    albumIds.length
      ? pool.execute(
          `SELECT album_id, COUNT(*) AS asset_count
           FROM shared_gallery_assets
           WHERE album_id IN (${albumIds.map(() => "?").join(", ")})
           GROUP BY album_id`,
          albumIds
        )
      : Promise.resolve([[]]),
    albumIds.length
      ? pool.execute(
          `SELECT * FROM shared_gallery_assets
           WHERE album_id IN (${albumIds.map(() => "?").join(", ")})
           ORDER BY COALESCE(taken_at_ms, created_at_ms) DESC, created_at_ms DESC`,
          albumIds
        )
      : Promise.resolve([[]]),
    albumIds.length
      ? pool.execute(
          `SELECT c.*
           FROM shared_gallery_comments c
           JOIN shared_gallery_assets a ON a.asset_id = c.asset_id
           WHERE a.album_id IN (${albumIds.map(() => "?").join(", ")})
           ORDER BY c.created_at_ms DESC
           LIMIT 500`,
          albumIds
        )
      : Promise.resolve([[]]),
    fetchAlbumMembers(albumIds),
    fetchAlbumShareLinks(albumIds),
  ]);

  const counts = new Map((countRows[0] || []).map((item) => [item.album_id, Number(item.asset_count || 0)]));
  const memberMap = new Map();
  for (const row of memberRows) {
    if (!memberMap.has(row.album_id)) {
      memberMap.set(row.album_id, []);
    }
    memberMap.get(row.album_id).push({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
    });
  }

  const shareLinkMap = new Map();
  for (const row of shareLinkRows) {
    if (!shareLinkMap.has(row.album_id)) {
      shareLinkMap.set(row.album_id, []);
    }
    shareLinkMap.get(row.album_id).push(serializeShareLink(row));
  }

  const albums = albumsRaw.map((row) =>
    serializeAlbum(
      { ...row, asset_count: counts.get(row.album_id) || 0 },
      memberMap.get(row.album_id) || [],
      req.authUser.id,
      row.owner_user_id === req.authUser.id ? shareLinkMap.get(row.album_id) || [] : []
    )
  );
  const albumMap = new Map(albums.map((item) => [item.id, item]));

  return {
    serverTime: new Date().toISOString(),
    albums,
    assets: (assetRows[0] || []).map((row) => serializeAsset(row, albumMap, req)),
    comments: (commentRows[0] || []).map(serializeComment),
    storage: getStorageInfo(),
    users: await listUsers(),
  };
}

async function fetchShareState(req, shareToken) {
  const access = await getShareLinkAccess(shareToken);
  if (!access || !access.canView) {
    return { access, payload: null };
  }

  const [countRow, assetRows, commentRows] = await Promise.all([
    fetchOne(`SELECT COUNT(*) AS asset_count FROM shared_gallery_assets WHERE album_id = ?`, [access.album.album_id]),
    pool.execute(
      `SELECT * FROM shared_gallery_assets
       WHERE album_id = ?
       ORDER BY COALESCE(taken_at_ms, created_at_ms) DESC, created_at_ms DESC`,
      [access.album.album_id]
    ),
    pool.execute(
      `SELECT c.*
       FROM shared_gallery_comments c
       JOIN shared_gallery_assets a ON a.asset_id = c.asset_id
       WHERE a.album_id = ?
       ORDER BY c.created_at_ms DESC
       LIMIT 500`,
      [access.album.album_id]
    ),
  ]);

  const album = serializeAlbum(
    { ...access.album, current_role: "viewer", asset_count: Number(countRow?.asset_count || 0) },
    [],
    "",
    []
  );
  const albumMap = new Map([[album.id, album]]);

  return {
    access,
    payload: {
      serverTime: new Date().toISOString(),
      album,
      assets: (assetRows[0] || []).map((row) => serializeAsset(row, albumMap, req, shareToken)),
      comments: (commentRows[0] || []).map(serializeComment),
      storage: getStorageInfo(),
      shareLink: access.shareLink,
    },
  };
}

async function sendState(req, res) {
  res.json(await fetchGalleryState(req));
}

function clampShareExpiry(body) {
  const requestedAt = normalizeMillis(body?.expiresAt);
  if (requestedAt) {
    const maxFuture = now() + SHARE_LINK_MAX_HOURS * 60 * 60 * 1000;
    return Math.min(requestedAt, maxFuture);
  }

  const requestedHours = Number(body?.expiresInHours || SHARE_LINK_DEFAULT_HOURS);
  const normalizedHours = Number.isFinite(requestedHours)
    ? Math.min(Math.max(requestedHours, 1), SHARE_LINK_MAX_HOURS)
    : SHARE_LINK_DEFAULT_HOURS;
  return now() + normalizedHours * 60 * 60 * 1000;
}

async function fetchAssetById(assetId) {
  return fetchOne(`SELECT * FROM shared_gallery_assets WHERE asset_id = ? LIMIT 1`, [assetId]);
}

async function fetchArchiveAssets(albumId, selectedIds) {
  if (selectedIds.length) {
    const placeholders = selectedIds.map(() => "?").join(", ");
    const [rows] = await pool.execute(
      `SELECT * FROM shared_gallery_assets
       WHERE album_id = ?
         AND asset_id IN (${placeholders})
       ORDER BY COALESCE(taken_at_ms, created_at_ms) DESC, created_at_ms DESC`,
      [albumId, ...selectedIds]
    );
    return Array.isArray(rows) ? rows : [];
  }

  const [rows] = await pool.execute(
    `SELECT * FROM shared_gallery_assets
     WHERE album_id = ?
     ORDER BY COALESCE(taken_at_ms, created_at_ms) DESC, created_at_ms DESC`,
    [albumId]
  );
  return Array.isArray(rows) ? rows : [];
}

function uniqueArchiveEntryName(asset, usedNames) {
  const rawName = safeFileName(asset.original_name || `${asset.asset_id}${extname(asset.storage_key || "")}`, asset.asset_id);
  const dotIndex = rawName.lastIndexOf(".");
  const stem = dotIndex > 0 ? rawName.slice(0, dotIndex) : rawName;
  const ext = dotIndex > 0 ? rawName.slice(dotIndex) : extname(asset.storage_key || "");
  let candidate = rawName;
  let suffix = 1;

  while (usedNames.has(candidate)) {
    candidate = `${stem}-${suffix}${ext}`;
    suffix += 1;
  }

  usedNames.add(candidate);
  return `${asset.media_type === "video" ? "videos" : "photos"}/${candidate}`;
}

async function sendArchive(res, album, assets) {
  const zipName = `${safeFileName(album.name || "album")}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", buildContentDisposition(zipName, "attachment"));

  const archive = archiver("zip", {
    zlib: { level: 6 },
  });

  archive.on("error", (error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: error instanceof Error ? error.message : "压缩失败" });
      return;
    }
    res.destroy(error);
  });

  archive.pipe(res);
  const usedNames = new Set();
  for (const asset of assets) {
    const { stream } = await createStoredObjectReadStream(asset);
    archive.append(stream, { name: uniqueArchiveEntryName(asset, usedNames) });
  }

  await archive.finalize();
}

async function handleUpload({ album, actor, ownerUserId, files, metaItems }) {
  const monthPrefix = new Date().toISOString().slice(0, 7).replace("-", "/");

  for (const [index, file] of files.entries()) {
    const assetId = makeId("asset");
    const ext = extname(file.originalname || "").toLowerCase() || "";
    const storageKey = `${config.cos.pathPrefix}/${ownerUserId}/${monthPrefix}/${assetId}${ext}`;
    const itemMeta = Array.isArray(metaItems) ? metaItems[index] || {} : {};
    const stored = await storeUploadedFile({
      tempFilePath: file.path,
      storageKey,
      mimeType: file.mimetype,
    });
    const timestamp = now();

    await pool.execute(
      `INSERT INTO shared_gallery_assets
        (asset_id, album_id, original_name, caption, mime_type, media_type, size_bytes, width, height, duration_seconds, storage_provider, storage_key, is_favorite, uploaded_by, taken_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assetId,
        album.album_id,
        String(file.originalname || assetId).slice(0, 255),
        String(itemMeta.caption || "").trim(),
        file.mimetype || "application/octet-stream",
        pickMediaType(file.mimetype),
        Number(file.size || 0),
        itemMeta.width === null || itemMeta.width === undefined ? null : Number(itemMeta.width),
        itemMeta.height === null || itemMeta.height === undefined ? null : Number(itemMeta.height),
        itemMeta.durationSeconds === null || itemMeta.durationSeconds === undefined
          ? null
          : Number(itemMeta.durationSeconds),
        stored.storageProvider,
        stored.storageKey,
        0,
        actor,
        normalizeMillis(itemMeta.takenAt),
        timestamp,
        timestamp,
      ]
    );
  }

  await pool.execute(`UPDATE shared_gallery_albums SET updated_by = ?, updated_at_ms = ? WHERE album_id = ?`, [
    actor,
    now(),
    album.album_id,
  ]);
  await refreshAlbumCover(album.album_id);
}

router.get("/share/:token/bootstrap", async (req, res) => {
  const shareToken = String(req.params.token || "").trim();
  const state = await fetchShareState(req, shareToken);
  if (!state.payload) {
    return res.status(shareErrorStatus(state.access)).json({ error: shareErrorMessage(state.access) });
  }

  res.json(state.payload);
});

router.post("/share/:token/assets/upload", upload.array("files", 24), async (req, res) => {
  const shareToken = String(req.params.token || "").trim();
  const access = await getShareLinkAccess(shareToken);
  if (!access || !access.canView) {
    return res.status(shareErrorStatus(access)).json({ error: shareErrorMessage(access) });
  }
  if (!access.canUpload) {
    return res.status(403).json({ error: "Forbidden: upload is disabled for this share link" });
  }

  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  await handleUpload({
    album: access.album,
    actor: actorFromShareRequest(req),
    ownerUserId: access.album.owner_user_id || "shared",
    files,
    metaItems: parseJson(req.body.items, []),
  });

  const state = await fetchShareState(req, shareToken);
  if (!state.payload) {
    return res.status(shareErrorStatus(state.access)).json({ error: shareErrorMessage(state.access) });
  }
  res.json(state.payload);
});

router.get("/share/:token/assets/:id/file", async (req, res) => {
  const shareToken = String(req.params.token || "").trim();
  const access = await getShareLinkAccess(shareToken);
  if (!access || !access.canView) {
    return res.status(shareErrorStatus(access)).json({ error: shareErrorMessage(access) });
  }

  const asset = await fetchAssetById(String(req.params.id || "").trim());
  if (!asset || asset.album_id !== access.album.album_id) {
    return res.status(404).json({ error: "Asset not found" });
  }

  const isDownload = ["1", "true"].includes(String(req.query.download || ""));
  if (isDownload && !access.canDownload) {
    return res.status(403).json({ error: "Forbidden: download is disabled for this share link" });
  }

  await sendStoredObject({
    req,
    res,
    asset,
    download: isDownload,
  });
});

router.get("/share/:token/archive", async (req, res) => {
  const shareToken = String(req.params.token || "").trim();
  const access = await getShareLinkAccess(shareToken);
  if (!access || !access.canView) {
    return res.status(shareErrorStatus(access)).json({ error: shareErrorMessage(access) });
  }
  if (!access.canDownload) {
    return res.status(403).json({ error: "Forbidden: download is disabled for this share link" });
  }

  const assets = await fetchArchiveAssets(
    access.album.album_id,
    parseSelectedAssetIds(req.query.assetId || req.query.assetIds)
  );
  if (!assets.length) {
    return res.status(404).json({ error: "No assets found" });
  }

  await sendArchive(res, access.album, assets);
});

router.use(requireAuth);

router.get("/bootstrap", async (req, res) => {
  await sendState(req, res);
});

router.post("/albums", async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  const visibility = String(req.body.visibility || "private").trim() === "shared" ? "shared" : "private";
  const timestamp = now();
  await pool.execute(
    `INSERT INTO shared_gallery_albums
      (album_id, name, description, visibility, owner_user_id, created_by, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      makeId("album"),
      name.slice(0, 120),
      String(req.body.description || "").trim(),
      visibility,
      req.authUser.id,
      actorFromRequest(req),
      actorFromRequest(req),
      timestamp,
      timestamp,
    ]
  );

  await sendState(req, res);
});

router.patch("/albums/:id", async (req, res) => {
  const access = await getAlbumAccess(String(req.params.id || "").trim(), req.authUser.id);
  if (!access || !access.canManage) {
    return res.status(403).json({ error: "Forbidden: cannot manage this album" });
  }

  await pool.execute(
    `UPDATE shared_gallery_albums
     SET name = ?, description = ?, visibility = ?, updated_by = ?, updated_at_ms = ?
     WHERE album_id = ?`,
    [
      String(req.body.name || access.album.name).trim().slice(0, 120) || access.album.name,
      String(req.body.description ?? access.album.description).trim(),
      String(req.body.visibility || access.album.visibility).trim() === "shared" ? "shared" : "private",
      actorFromRequest(req),
      now(),
      access.album.album_id,
    ]
  );

  await sendState(req, res);
});

router.put("/albums/:id/members", async (req, res) => {
  const access = await getAlbumAccess(String(req.params.id || "").trim(), req.authUser.id);
  if (!access || !access.canManage) {
    return res.status(403).json({ error: "Forbidden: cannot manage members" });
  }

  const members = Array.isArray(req.body.members) ? req.body.members : [];
  await pool.execute(`DELETE FROM shared_gallery_album_members WHERE album_id = ?`, [access.album.album_id]);

  const timestamp = now();
  for (const item of members) {
    const userId = String(item?.userId || "").trim();
    if (!userId || userId === req.authUser.id) {
      continue;
    }

    const role = String(item?.role || "viewer").trim() === "editor" ? "editor" : "viewer";
    await pool.execute(
      `INSERT INTO shared_gallery_album_members (album_id, user_id, role, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      [access.album.album_id, userId, role, timestamp, timestamp]
    );
  }

  await pool.execute(
    `UPDATE shared_gallery_albums SET updated_by = ?, updated_at_ms = ? WHERE album_id = ?`,
    [actorFromRequest(req), timestamp, access.album.album_id]
  );

  await sendState(req, res);
});

router.post("/albums/:id/share-links", async (req, res) => {
  const access = await getAlbumAccess(String(req.params.id || "").trim(), req.authUser.id);
  if (!access || !access.canManage) {
    return res.status(403).json({ error: "Forbidden: cannot create share links for this album" });
  }

  const title =
    String(req.body.title || "").trim().slice(0, 120) ||
    `${safeFileName(access.album.name, "相册")} · 协作链接`;
  const permission = String(req.body.permission || "contributor").trim() === "viewer" ? "viewer" : "contributor";
  const allowDownload = req.body.allowDownload === false ? 0 : 1;
  const timestamp = now();

  await pool.execute(
    `INSERT INTO shared_gallery_share_links
      (link_id, album_id, share_token, title, permission, allow_download, expires_at_ms, created_by_user_id, created_at_ms, updated_at_ms, revoked_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      makeId("share"),
      access.album.album_id,
      makeShareToken(),
      title,
      permission,
      allowDownload,
      clampShareExpiry(req.body),
      req.authUser.id,
      timestamp,
      timestamp,
    ]
  );

  await sendState(req, res);
});

router.delete("/share-links/:id", async (req, res) => {
  const linkId = String(req.params.id || "").trim();
  const link = await fetchOne(`SELECT * FROM shared_gallery_share_links WHERE link_id = ? LIMIT 1`, [linkId]);
  if (!link) {
    return res.status(404).json({ error: "Share link not found" });
  }

  const access = await getAlbumAccess(link.album_id, req.authUser.id);
  if (!access || !access.canManage) {
    return res.status(403).json({ error: "Forbidden: cannot revoke this share link" });
  }

  await pool.execute(`UPDATE shared_gallery_share_links SET revoked_at_ms = ?, updated_at_ms = ? WHERE link_id = ?`, [
    now(),
    now(),
    linkId,
  ]);

  await sendState(req, res);
});

router.delete("/share-links/:id/permanent", async (req, res) => {
  const linkId = String(req.params.id || "").trim();
  const link = await fetchOne(`SELECT * FROM shared_gallery_share_links WHERE link_id = ? LIMIT 1`, [linkId]);
  if (!link) {
    return res.status(404).json({ error: "Share link not found" });
  }

  const access = await getAlbumAccess(link.album_id, req.authUser.id);
  if (!access || !access.canManage) {
    return res.status(403).json({ error: "Forbidden: cannot delete this share link" });
  }

  const isExpired = Boolean(link.revoked_at_ms) || Number(link.expires_at_ms) <= now();
  if (!isExpired) {
    return res.status(400).json({ error: "Only revoked or expired share links can be permanently deleted" });
  }

  await pool.execute(`DELETE FROM shared_gallery_share_links WHERE link_id = ?`, [linkId]);

  await sendState(req, res);
});

router.post("/assets/upload", upload.array("files", 24), async (req, res) => {
  const albumId = String(req.body.albumId || "").trim() || (await ensureDefaultAlbum(req.authUser));
  const access = await getAlbumAccess(albumId, req.authUser.id);
  if (!access || !access.canEdit) {
    return res.status(403).json({ error: "Forbidden: cannot upload to this album" });
  }

  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  await handleUpload({
    album: access.album,
    actor: actorFromRequest(req),
    ownerUserId: req.authUser.id,
    files,
    metaItems: parseJson(req.body.items, []),
  });

  await sendState(req, res);
});

router.patch("/assets/:id/favorite", async (req, res) => {
  const asset = await fetchAssetById(String(req.params.id || "").trim());
  if (!asset) {
    return res.status(404).json({ error: "Asset not found" });
  }

  const access = await getAlbumAccess(asset.album_id, req.authUser.id);
  if (!access || !access.canView) {
    return res.status(403).json({ error: "Forbidden: cannot access this asset" });
  }

  await pool.execute(
    `UPDATE shared_gallery_assets SET is_favorite = ?, updated_at_ms = ? WHERE asset_id = ?`,
    [req.body.isFavorite ? 1 : 0, now(), asset.asset_id]
  );

  await sendState(req, res);
});

router.delete("/assets/:id", async (req, res) => {
  const asset = await fetchAssetById(String(req.params.id || "").trim());
  if (!asset) {
    return res.status(404).json({ error: "Asset not found" });
  }

  const access = await getAlbumAccess(asset.album_id, req.authUser.id);
  if (!access || !access.canEdit) {
    return res.status(403).json({ error: "Forbidden: cannot delete this asset" });
  }

  await removeStoredObject(asset);
  await pool.execute(`DELETE FROM shared_gallery_comments WHERE asset_id = ?`, [asset.asset_id]);
  await pool.execute(`DELETE FROM shared_gallery_assets WHERE asset_id = ?`, [asset.asset_id]);
  await refreshAlbumCover(asset.album_id);
  await sendState(req, res);
});

router.post("/comments", async (req, res) => {
  const assetId = String(req.body.assetId || "").trim();
  const content = String(req.body.content || "").trim();
  if (!assetId || !content) {
    return res.status(400).json({ error: "assetId and content are required" });
  }

  const asset = await fetchAssetById(assetId);
  if (!asset) {
    return res.status(404).json({ error: "Asset not found" });
  }

  const access = await getAlbumAccess(asset.album_id, req.authUser.id);
  if (!access || !access.canView) {
    return res.status(403).json({ error: "Forbidden: cannot comment on this asset" });
  }

  await pool.execute(
    `INSERT INTO shared_gallery_comments (comment_id, asset_id, content, author, created_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
    [makeId("comment"), assetId, content, actorFromRequest(req), now()]
  );

  await sendState(req, res);
});

router.get("/assets/:id/file", async (req, res) => {
  const asset = await fetchAssetById(String(req.params.id || "").trim());
  if (!asset) {
    return res.status(404).json({ error: "Asset not found" });
  }

  const access = await getAlbumAccess(asset.album_id, req.authUser.id);
  if (!access || !access.canView) {
    return res.status(403).json({ error: "Forbidden: cannot access this asset" });
  }

  await sendStoredObject({
    req,
    res,
    asset,
    download: ["1", "true"].includes(String(req.query.download || "")),
  });
});

router.get("/albums/:id/archive", async (req, res) => {
  const access = await getAlbumAccess(String(req.params.id || "").trim(), req.authUser.id);
  if (!access || !access.canView) {
    return res.status(403).json({ error: "Forbidden: cannot archive this album" });
  }

  const assets = await fetchArchiveAssets(
    access.album.album_id,
    parseSelectedAssetIds(req.query.assetId || req.query.assetIds)
  );
  if (!assets.length) {
    return res.status(404).json({ error: "No assets found" });
  }

  await sendArchive(res, access.album, assets);
});

export default router;
