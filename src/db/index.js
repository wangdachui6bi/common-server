import mysql from "mysql2/promise";
import { config } from "../config.js";

const pool = mysql.createPool({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
  waitForConnections: true,
  connectionLimit: 10,
});

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

  const [columns] = await pool.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = 'synced_todos'
       AND COLUMN_NAME = 'extra_json'`,
    [config.mysql.database]
  );

  if (!Array.isArray(columns) || columns.length === 0) {
    await pool.execute(`ALTER TABLE synced_todos ADD COLUMN extra_json MEDIUMTEXT NULL AFTER text`);
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
};

export default pool;
