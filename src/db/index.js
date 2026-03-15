import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "../config.js";

mkdirSync(dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS releases (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id    TEXT    NOT NULL,
    version   TEXT    NOT NULL,
    platform  TEXT    NOT NULL DEFAULT 'android',
    changelog TEXT    NOT NULL DEFAULT '',
    filename  TEXT    NOT NULL,
    filesize  INTEGER NOT NULL DEFAULT 0,
    force_update INTEGER NOT NULL DEFAULT 0,
    created_at TEXT   NOT NULL DEFAULT (datetime('now')),
    UNIQUE(app_id, version, platform)
  );

  CREATE INDEX IF NOT EXISTS idx_releases_app_platform
    ON releases(app_id, platform, created_at DESC);
`);

export const stmts = {
  insertRelease: db.prepare(`
    INSERT INTO releases (app_id, version, platform, changelog, filename, filesize, force_update)
    VALUES (@appId, @version, @platform, @changelog, @filename, @filesize, @forceUpdate)
  `),

  getLatest: db.prepare(`
    SELECT * FROM releases
    WHERE app_id = @appId AND platform = @platform
    ORDER BY created_at DESC
    LIMIT 1
  `),

  getByVersion: db.prepare(`
    SELECT * FROM releases
    WHERE app_id = @appId AND version = @version AND platform = @platform
  `),

  listReleases: db.prepare(`
    SELECT * FROM releases
    WHERE app_id = @appId
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `),

  deleteRelease: db.prepare(`
    DELETE FROM releases
    WHERE app_id = @appId AND version = @version AND platform = @platform
  `),

  countReleases: db.prepare(`
    SELECT COUNT(*) as total FROM releases WHERE app_id = @appId
  `),

  listApps: db.prepare(`
    SELECT app_id, COUNT(*) as release_count, MAX(created_at) as last_release
    FROM releases GROUP BY app_id ORDER BY last_release DESC
  `),
};

export default db;
