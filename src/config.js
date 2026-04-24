import "dotenv/config";
import { resolve } from "path";

export const config = {
  port: parseInt(process.env.PORT || "3600", 10),
  adminApiKey: process.env.ADMIN_API_KEY || "change-me",
  syncToken: process.env.SYNC_API_TOKEN || "",
  appAccessToken: process.env.APP_ACCESS_TOKEN || process.env.MENU_BOARD_TOKEN || "",
  menuBoardToken: process.env.MENU_BOARD_TOKEN || process.env.APP_ACCESS_TOKEN || "",
  menuFeishuWebhook:
    process.env.MENU_FEISHU_WEBHOOK ||
    "https://open.feishu.cn/open-apis/bot/v2/hook/2df88983-45e4-4ab8-9e41-91df24c6455f",
  uploadDir: resolve(process.env.UPLOAD_DIR || "./uploads"),
  baseUrl: process.env.BASE_URL || "http://localhost:3600",
  authSessionHours: parseInt(process.env.AUTH_SESSION_HOURS || "720", 10),
  jwtSecret: process.env.JWT_SECRET || "",
  cos: {
    secretId: process.env.COS_SECRET_ID || "",
    secretKey: process.env.COS_SECRET_KEY || "",
    bucket: process.env.COS_BUCKET || "",
    region: process.env.COS_REGION || "",
    publicDomain: process.env.COS_PUBLIC_DOMAIN || "",
    pathPrefix: process.env.COS_PATH_PREFIX || "shared-gallery",
    signedUrlExpires: parseInt(process.env.COS_SIGNED_URL_EXPIRES || "900", 10),
  },
  gallery: {
    previewWidth: parseInt(process.env.GALLERY_PREVIEW_WIDTH || "960", 10),
    previewQuality: parseInt(process.env.GALLERY_PREVIEW_QUALITY || "78", 10),
    requestTimeoutMs: parseInt(process.env.GALLERY_REQUEST_TIMEOUT_MS || String(30 * 60 * 1000), 10),
  },
  mysql: {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: parseInt(process.env.MYSQL_PORT || "3306", 10),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "appdb",
  },
};
