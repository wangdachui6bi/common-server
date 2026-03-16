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
};

export default pool;
