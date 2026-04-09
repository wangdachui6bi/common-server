import mysql from "mysql2/promise";
import { config } from "../config.js";

const pool = mysql.createPool({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 100,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000,
});

async function hasColumn(tableName, columnName) {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [config.mysql.database, tableName, columnName]
  );

  return Array.isArray(rows) && rows.length > 0;
}

export async function initDB() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS apps (
      app_id       VARCHAR(100)  PRIMARY KEY,
      update_url   VARCHAR(255)  NOT NULL DEFAULT '',
      created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS releases (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      app_id       VARCHAR(100)  NOT NULL,
      version      VARCHAR(50)   NOT NULL,
      platform     VARCHAR(30)   NOT NULL DEFAULT 'android',
      changelog    TEXT          NOT NULL,
      filename     VARCHAR(255)  NOT NULL,
      filesize     BIGINT        NOT NULL DEFAULT 0,
      force_update TINYINT       NOT NULL DEFAULT 0,
      created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_release (app_id, version, platform),
      INDEX idx_app_platform (app_id, platform, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS synced_todos (
      namespace_key VARCHAR(120) NOT NULL,
      todo_id       VARCHAR(120) NOT NULL,
      text          TEXT         NOT NULL,
      extra_json    MEDIUMTEXT   NULL,
      completed     TINYINT      NOT NULL DEFAULT 0,
      deleted       TINYINT      NOT NULL DEFAULT 0,
      created_at_ms BIGINT       NOT NULL,
      updated_at_ms BIGINT       NOT NULL,
      deleted_at_ms BIGINT       NULL,
      source_app    VARCHAR(100) NOT NULL DEFAULT '',
      PRIMARY KEY (namespace_key, todo_id),
      INDEX idx_synced_todos_namespace_updated (namespace_key, updated_at_ms DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sync_settings (
      namespace_key VARCHAR(120) NOT NULL,
      setting_key   VARCHAR(120) NOT NULL,
      value_json    MEDIUMTEXT   NOT NULL,
      updated_at_ms BIGINT       NOT NULL,
      PRIMARY KEY (namespace_key, setting_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS todo_reminder_logs (
      namespace_key VARCHAR(120) NOT NULL,
      reminder_key  VARCHAR(191) NOT NULL,
      sent_at_ms    BIGINT       NOT NULL,
      PRIMARY KEY (namespace_key, reminder_key),
      INDEX idx_todo_reminder_logs_sent (namespace_key, sent_at_ms DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  if (!(await hasColumn("synced_todos", "extra_json"))) {
    await pool.execute(`ALTER TABLE synced_todos ADD COLUMN extra_json MEDIUMTEXT NULL AFTER text`);
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS app_users (
      user_id                VARCHAR(120) NOT NULL PRIMARY KEY,
      username               VARCHAR(80)  NOT NULL,
      display_name           VARCHAR(60)  NOT NULL,
      password_hash          VARCHAR(255) NOT NULL,
      is_owner               TINYINT      NOT NULL DEFAULT 0,
      menu_permissions_json  MEDIUMTEXT   NOT NULL,
      created_at_ms          BIGINT       NOT NULL,
      updated_at_ms          BIGINT       NOT NULL,
      UNIQUE KEY uniq_app_users_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      session_id      VARCHAR(120) NOT NULL PRIMARY KEY,
      user_id         VARCHAR(120) NOT NULL,
      token_hash      VARCHAR(128) NOT NULL,
      created_at_ms   BIGINT       NOT NULL,
      expires_at_ms   BIGINT       NOT NULL,
      UNIQUE KEY uniq_app_sessions_token_hash (token_hash),
      INDEX idx_app_sessions_user (user_id, expires_at_ms DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      username              VARCHAR(80)  NOT NULL,
      password_hash         VARCHAR(255) NOT NULL,
      nickname              VARCHAR(100) NOT NULL DEFAULT '',
      role                  VARCHAR(20)  NOT NULL DEFAULT 'user',
      menu_permissions_json MEDIUMTEXT   NULL,
      created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_users_username (username),
      INDEX idx_users_role (role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  if (!(await hasColumn("users", "role"))) {
    await pool.execute(`ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'user' AFTER nickname`);
  }

  if (!(await hasColumn("users", "menu_permissions_json"))) {
    await pool.execute(`ALTER TABLE users ADD COLUMN menu_permissions_json MEDIUMTEXT NULL AFTER role`);
  }

  if (!(await hasColumn("users", "updated_at"))) {
    await pool.execute(
      `ALTER TABLE users ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at`
    );
  }

  await pool.execute(`UPDATE users SET role = 'admin' WHERE username = 'admin' AND role != 'admin'`);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS couple_menu_dishes (
      dish_id         VARCHAR(120)  NOT NULL PRIMARY KEY,
      name            VARCHAR(120)  NOT NULL,
      category        VARCHAR(80)   NOT NULL DEFAULT '',
      description     TEXT          NOT NULL,
      image_data      MEDIUMTEXT    NULL,
      tags_json       MEDIUMTEXT    NULL,
      source_type     VARCHAR(30)   NOT NULL DEFAULT 'custom',
      created_by      VARCHAR(60)   NOT NULL DEFAULT '',
      updated_by      VARCHAR(60)   NOT NULL DEFAULT '',
      created_at_ms   BIGINT        NOT NULL,
      updated_at_ms   BIGINT        NOT NULL,
      INDEX idx_couple_menu_dishes_updated (updated_at_ms DESC),
      INDEX idx_couple_menu_dishes_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS couple_menu_requests (
      request_id      VARCHAR(120)  NOT NULL PRIMARY KEY,
      dish_id         VARCHAR(120)  NULL,
      dish_name       VARCHAR(120)  NOT NULL,
      request_type    VARCHAR(20)   NOT NULL DEFAULT 'wish',
      note            TEXT          NOT NULL,
      requested_by    VARCHAR(60)   NOT NULL DEFAULT '',
      status          VARCHAR(20)   NOT NULL DEFAULT 'pending',
      created_at_ms   BIGINT        NOT NULL,
      updated_at_ms   BIGINT        NOT NULL,
      INDEX idx_couple_menu_requests_updated (updated_at_ms DESC),
      INDEX idx_couple_menu_requests_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS couple_menu_comments (
      comment_id      VARCHAR(120)  NOT NULL PRIMARY KEY,
      target_type     VARCHAR(20)   NOT NULL,
      target_id       VARCHAR(120)  NOT NULL,
      content         TEXT          NOT NULL,
      author          VARCHAR(60)   NOT NULL DEFAULT '',
      created_at_ms   BIGINT        NOT NULL,
      INDEX idx_couple_menu_comments_target (target_type, target_id, created_at_ms DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS couple_menu_events (
      id              BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
      event_type      VARCHAR(40)   NOT NULL,
      entity_type     VARCHAR(30)   NOT NULL,
      entity_id       VARCHAR(120)  NOT NULL,
      summary         VARCHAR(255)  NOT NULL,
      payload_json    MEDIUMTEXT    NULL,
      created_at_ms   BIGINT        NOT NULL,
      INDEX idx_couple_menu_events_created (created_at_ms DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shared_gallery_albums (
      album_id         VARCHAR(120) NOT NULL PRIMARY KEY,
      name             VARCHAR(120) NOT NULL,
      description      TEXT         NOT NULL,
      visibility       VARCHAR(20)  NOT NULL DEFAULT 'private',
      owner_user_id    VARCHAR(120) NULL,
      cover_asset_id   VARCHAR(120) NULL,
      created_by       VARCHAR(60)  NOT NULL DEFAULT '',
      updated_by       VARCHAR(60)  NOT NULL DEFAULT '',
      created_at_ms    BIGINT       NOT NULL,
      updated_at_ms    BIGINT       NOT NULL,
      INDEX idx_shared_gallery_albums_updated (updated_at_ms DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shared_gallery_assets (
      asset_id          VARCHAR(120) NOT NULL PRIMARY KEY,
      album_id          VARCHAR(120) NOT NULL,
      original_name     VARCHAR(255) NOT NULL,
      caption           TEXT         NOT NULL,
      mime_type         VARCHAR(120) NOT NULL,
      media_type        VARCHAR(20)  NOT NULL DEFAULT 'image',
      size_bytes        BIGINT       NOT NULL DEFAULT 0,
      width             INT          NULL,
      height            INT          NULL,
      duration_seconds  DECIMAL(10,2) NULL,
      storage_provider  VARCHAR(20)  NOT NULL DEFAULT 'local',
      storage_key       VARCHAR(255) NOT NULL,
      is_favorite       TINYINT      NOT NULL DEFAULT 0,
      uploaded_by       VARCHAR(60)  NOT NULL DEFAULT '',
      taken_at_ms       BIGINT       NULL,
      created_at_ms     BIGINT       NOT NULL,
      updated_at_ms     BIGINT       NOT NULL,
      INDEX idx_shared_gallery_assets_album_created (album_id, created_at_ms DESC),
      INDEX idx_shared_gallery_assets_favorite (is_favorite, created_at_ms DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shared_gallery_comments (
      comment_id        VARCHAR(120) NOT NULL PRIMARY KEY,
      asset_id          VARCHAR(120) NOT NULL,
      content           TEXT         NOT NULL,
      author            VARCHAR(60)  NOT NULL DEFAULT '',
      created_at_ms     BIGINT       NOT NULL,
      INDEX idx_shared_gallery_comments_asset (asset_id, created_at_ms DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shared_gallery_album_members (
      album_id          VARCHAR(120) NOT NULL,
      user_id           VARCHAR(120) NOT NULL,
      role              VARCHAR(20)  NOT NULL DEFAULT 'viewer',
      created_at_ms     BIGINT       NOT NULL,
      updated_at_ms     BIGINT       NOT NULL,
      PRIMARY KEY (album_id, user_id),
      INDEX idx_shared_gallery_album_members_user (user_id, updated_at_ms DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shared_gallery_share_links (
      link_id            VARCHAR(120) NOT NULL PRIMARY KEY,
      album_id           VARCHAR(120) NOT NULL,
      share_token        VARCHAR(180) NOT NULL,
      title              VARCHAR(120) NOT NULL,
      permission         VARCHAR(20)  NOT NULL DEFAULT 'contributor',
      allow_download     TINYINT      NOT NULL DEFAULT 1,
      expires_at_ms      BIGINT       NOT NULL,
      created_by_user_id VARCHAR(120) NOT NULL,
      created_at_ms      BIGINT       NOT NULL,
      updated_at_ms      BIGINT       NOT NULL,
      revoked_at_ms      BIGINT       NULL,
      UNIQUE KEY uniq_shared_gallery_share_links_token (share_token),
      INDEX idx_shared_gallery_share_links_album (album_id, updated_at_ms DESC),
      INDEX idx_shared_gallery_share_links_expire (expires_at_ms, revoked_at_ms)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  if (!(await hasColumn("shared_gallery_albums", "visibility"))) {
    await pool.execute(
      `ALTER TABLE shared_gallery_albums
       ADD COLUMN visibility VARCHAR(20) NOT NULL DEFAULT 'private' AFTER description`
    );
  }

  if (!(await hasColumn("shared_gallery_albums", "owner_user_id"))) {
    await pool.execute(
      `ALTER TABLE shared_gallery_albums
       ADD COLUMN owner_user_id VARCHAR(120) NULL AFTER visibility`
    );
  }

  if (!(await hasColumn("shared_gallery_share_links", "allow_download"))) {
    await pool.execute(
      `ALTER TABLE shared_gallery_share_links
       ADD COLUMN allow_download TINYINT NOT NULL DEFAULT 1 AFTER permission`
    );
  }
}

export const db = {
  async insertRelease({ appId, version, platform, changelog, filename, filesize, forceUpdate }) {
    const [result] = await pool.execute(
      `INSERT INTO releases (app_id, version, platform, changelog, filename, filesize, force_update)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [appId, version, platform, changelog, filename, filesize, forceUpdate]
    );
    return result;
  },

  async getLatest({ appId, platform }) {
    const [rows] = await pool.execute(
      `SELECT * FROM releases WHERE app_id = ? AND platform = ? ORDER BY created_at DESC LIMIT 1`,
      [appId, platform]
    );
    return rows[0] || null;
  },

  async getByVersion({ appId, version, platform }) {
    const [rows] = await pool.execute(
      `SELECT * FROM releases WHERE app_id = ? AND version = ? AND platform = ?`,
      [appId, version, platform]
    );
    return rows[0] || null;
  },

  async listReleases({ appId, limit, offset }) {
    const [rows] = await pool.query(
      `SELECT * FROM releases WHERE app_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [appId, Number(limit), Number(offset)]
    );
    return rows;
  },

  async deleteRelease({ appId, version, platform }) {
    const [result] = await pool.execute(
      `DELETE FROM releases WHERE app_id = ? AND version = ? AND platform = ?`,
      [appId, version, platform]
    );
    return result;
  },

  async countReleases({ appId }) {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) as total FROM releases WHERE app_id = ?`,
      [appId]
    );
    return rows[0];
  },

  async listApps() {
    const [rows] = await pool.execute(
      `SELECT a.app_id, a.update_url, a.created_at as app_created_at,
              COUNT(r.id) as release_count, MAX(r.created_at) as last_release
       FROM apps a
       LEFT JOIN releases r ON a.app_id = r.app_id
       GROUP BY a.app_id
       ORDER BY last_release DESC, a.created_at DESC`
    );
    return rows;
  },

  async getApp(appId) {
    const [rows] = await pool.execute(
      `SELECT * FROM apps WHERE app_id = ?`,
      [appId]
    );
    return rows[0] || null;
  },

  async upsertApp(appId, updateUrl = "") {
    const [result] = await pool.execute(
      `INSERT INTO apps (app_id, update_url) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE update_url = VALUES(update_url)`,
      [appId, updateUrl]
    );
    return result;
  },

  async deleteApp(appId) {
    // Delete all releases for this app
    await pool.execute(`DELETE FROM releases WHERE app_id = ?`, [appId]);
    // Delete the app
    const [result] = await pool.execute(`DELETE FROM apps WHERE app_id = ?`, [appId]);
    return result;
  },

  async getSyncedTodo({ namespace, todoId }) {
    const [rows] = await pool.execute(
      `SELECT * FROM synced_todos WHERE namespace_key = ? AND todo_id = ? LIMIT 1`,
      [namespace, todoId]
    );
    return rows[0] || null;
  },

  async upsertSyncedTodo({
    namespace,
    todoId,
    text,
    extraJson,
    completed,
    deleted,
    createdAtMs,
    updatedAtMs,
    deletedAtMs,
    sourceApp,
  }) {
    const [result] = await pool.execute(
      `INSERT INTO synced_todos
        (namespace_key, todo_id, text, extra_json, completed, deleted, created_at_ms, updated_at_ms, deleted_at_ms, source_app)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        text = VALUES(text),
        extra_json = VALUES(extra_json),
        completed = VALUES(completed),
        deleted = VALUES(deleted),
        created_at_ms = VALUES(created_at_ms),
        updated_at_ms = VALUES(updated_at_ms),
        deleted_at_ms = VALUES(deleted_at_ms),
        source_app = VALUES(source_app)`,
      [namespace, todoId, text, extraJson, completed, deleted, createdAtMs, updatedAtMs, deletedAtMs, sourceApp]
    );
    return result;
  },

  async listSyncedTodos(namespace, options = {}) {
    const { includeDeleted = false } = options;
    const [rows] = await pool.execute(
      `SELECT * FROM synced_todos
       WHERE namespace_key = ?
         AND (? = 1 OR deleted = 0)
       ORDER BY updated_at_ms DESC`,
      [namespace, includeDeleted ? 1 : 0]
    );
    return rows;
  },

  async getSyncSetting({ namespace, settingKey }) {
    const [rows] = await pool.execute(
      `SELECT * FROM sync_settings WHERE namespace_key = ? AND setting_key = ? LIMIT 1`,
      [namespace, settingKey]
    );
    return rows[0] || null;
  },

  async upsertSyncSetting({ namespace, settingKey, valueJson, updatedAtMs }) {
    const [result] = await pool.execute(
      `INSERT INTO sync_settings (namespace_key, setting_key, value_json, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        value_json = VALUES(value_json),
        updated_at_ms = VALUES(updated_at_ms)`,
      [namespace, settingKey, valueJson, updatedAtMs]
    );
    return result;
  },

  async getReminderLog({ namespace, reminderKey }) {
    const [rows] = await pool.execute(
      `SELECT * FROM todo_reminder_logs WHERE namespace_key = ? AND reminder_key = ? LIMIT 1`,
      [namespace, reminderKey]
    );
    return rows[0] || null;
  },

  async upsertReminderLog({ namespace, reminderKey, sentAtMs }) {
    const [result] = await pool.execute(
      `INSERT INTO todo_reminder_logs (namespace_key, reminder_key, sent_at_ms)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
        sent_at_ms = VALUES(sent_at_ms)`,
      [namespace, reminderKey, sentAtMs]
    );
    return result;
  },

  async listReminderLogs({ namespace, reminderKeys }) {
    const keys = Array.isArray(reminderKeys)
      ? reminderKeys.filter((item) => typeof item === "string" && item)
      : [];

    if (keys.length === 0) {
      return [];
    }

    const placeholders = keys.map(() => "?").join(", ");
    const [rows] = await pool.execute(
      `SELECT * FROM todo_reminder_logs
       WHERE namespace_key = ?
         AND reminder_key IN (${placeholders})`,
      [namespace, ...keys]
    );
    return rows;
  },
};

export default pool;
