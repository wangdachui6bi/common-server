import "dotenv/config";
import { resolve } from "path";

export const config = {
  port: parseInt(process.env.PORT || "3600", 10),
  adminApiKey: process.env.ADMIN_API_KEY || "change-me",
  uploadDir: resolve(process.env.UPLOAD_DIR || "./uploads"),
  databasePath: resolve(process.env.DATABASE_PATH || "./data/update-server.db"),
  baseUrl: process.env.BASE_URL || "http://localhost:3600",
};
