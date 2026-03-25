import "dotenv/config";
import { resolve } from "path";

export const config = {
  port: parseInt(process.env.PORT || "3600", 10),
  adminApiKey: process.env.ADMIN_API_KEY || "change-me",
  syncToken: process.env.SYNC_API_TOKEN || "",
  uploadDir: resolve(process.env.UPLOAD_DIR || "./uploads"),
  baseUrl: process.env.BASE_URL || "http://localhost:3600",
  mysql: {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: parseInt(process.env.MYSQL_PORT || "3306", 10),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "appdb",
  },
};
