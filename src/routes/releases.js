import { Router } from "express";
import multer from "multer";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join, extname } from "path";
import { config } from "../config.js";
import { stmts } from "../db/index.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();

mkdirSync(config.uploadDir, { recursive: true });

const PLATFORM_EXTENSIONS = {
  android: [".apk", ".aab"],
  "electron-win": [".exe", ".msi", ".nsis"],
  "electron-mac": [".dmg", ".zip"],
  "electron-linux": [".AppImage", ".deb", ".rpm", ".snap"],
  ios: [".ipa"],
};

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    const dir = join(config.uploadDir, _req.params.appId);
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    const ext = extname(file.originalname);
    const safeName = `${_req.body.version}-${_req.body.platform || "android"}${ext}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
});

// ─── Admin: List all apps ─────────────────────────────────────────────────────
router.get("/", requireAdmin, (_req, res) => {
  const apps = stmts.listApps.all();
  res.json(
    apps.map((a) => ({
      appId: a.app_id,
      releaseCount: a.release_count,
      lastRelease: a.last_release,
    }))
  );
});

// ─── Public: Get latest release for an app + platform ────────────────────────
router.get("/:appId/releases/latest", (req, res) => {
  const { appId } = req.params;
  const platform = req.query.platform || "android";

  const release = stmts.getLatest.get({ appId, platform });
  if (!release) {
    return res.status(404).json({ error: "No release found" });
  }

  res.json({
    version: release.version,
    url: `${config.baseUrl}/api/apps/${appId}/releases/${release.version}/download?platform=${platform}`,
    changelog: release.changelog,
    filesize: release.filesize,
    forceUpdate: !!release.force_update,
    createdAt: release.created_at,
  });
});

// ─── Public: Download a specific release ─────────────────────────────────────
router.get("/:appId/releases/:version/download", (req, res) => {
  const { appId, version } = req.params;
  const platform = req.query.platform || "android";

  const release = stmts.getByVersion.get({ appId, version, platform });
  if (!release) {
    return res.status(404).json({ error: "Release not found" });
  }

  const filePath = join(config.uploadDir, appId, release.filename);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "File not found on disk" });
  }

  res.download(filePath, release.filename);
});

// ─── Admin: Upload a new release ─────────────────────────────────────────────
router.post("/:appId/releases", requireAdmin, upload.single("file"), (req, res) => {
  const { appId } = req.params;
  const { version, platform = "android", changelog = "", forceUpdate = "0" } = req.body;

  if (!version) {
    return res.status(400).json({ error: "version is required" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "file is required" });
  }

  const existing = stmts.getByVersion.get({ appId, version, platform });
  if (existing) {
    const oldPath = join(config.uploadDir, appId, existing.filename);
    if (existsSync(oldPath)) unlinkSync(oldPath);
    stmts.deleteRelease.run({ appId, version, platform });
  }

  try {
    stmts.insertRelease.run({
      appId,
      version,
      platform,
      changelog,
      filename: req.file.filename,
      filesize: req.file.size,
      forceUpdate: forceUpdate === "1" || forceUpdate === "true" ? 1 : 0,
    });
  } catch (err) {
    return res.status(409).json({ error: "Release already exists", detail: err.message });
  }

  res.status(201).json({
    message: "Release uploaded successfully",
    release: {
      appId,
      version,
      platform,
      changelog,
      downloadUrl: `${config.baseUrl}/api/apps/${appId}/releases/${version}/download?platform=${platform}`,
      filesize: req.file.size,
    },
  });
});

// ─── Admin: List releases ────────────────────────────────────────────────────
router.get("/:appId/releases", requireAdmin, (req, res) => {
  const { appId } = req.params;
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const offset = parseInt(req.query.offset || "0", 10);

  const releases = stmts.listReleases.all({ appId, limit, offset });
  const { total } = stmts.countReleases.get({ appId });

  res.json({
    total,
    limit,
    offset,
    releases: releases.map((r) => ({
      version: r.version,
      platform: r.platform,
      changelog: r.changelog,
      filesize: r.filesize,
      forceUpdate: !!r.force_update,
      downloadUrl: `${config.baseUrl}/api/apps/${appId}/releases/${r.version}/download?platform=${r.platform}`,
      createdAt: r.created_at,
    })),
  });
});

// ─── Admin: Delete a release ─────────────────────────────────────────────────
router.delete("/:appId/releases/:version", requireAdmin, (req, res) => {
  const { appId, version } = req.params;
  const platform = req.query.platform || "android";

  const release = stmts.getByVersion.get({ appId, version, platform });
  if (!release) {
    return res.status(404).json({ error: "Release not found" });
  }

  const filePath = join(config.uploadDir, appId, release.filename);
  if (existsSync(filePath)) unlinkSync(filePath);

  stmts.deleteRelease.run({ appId, version, platform });

  res.json({ message: "Release deleted" });
});

export default router;
