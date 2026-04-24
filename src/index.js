import express from "express";
import cors from "cors";
import morgan from "morgan";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { initDB } from "./db/index.js";
import authRouter from "./routes/auth.js";
import adminRouter from "./routes/admin.js";
import releasesRouter from "./routes/releases.js";
import todoSyncRouter from "./routes/todoSync.js";
import menuBoardRouter from "./routes/menuBoard.js";
import sharedGalleryRouter from "./routes/sharedGallery.js";
import { startFeishuReminderScheduler } from "./services/feishuReminder.js";
import { ensureMediaDirs } from "./services/mediaStorage.js";

process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[process] uncaughtException:", error);
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(morgan("short"));
app.use(express.json({ limit: "12mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/apps", releasesRouter);
app.use("/api/sync", todoSyncRouter);
app.use("/api/menu", menuBoardRouter);
app.use("/api/gallery", sharedGalleryRouter);

const adminDist = resolve(__dirname, "../admin-ui/dist");
if (existsSync(adminDist)) {
  app.use("/admin", express.static(adminDist));
  app.get("/admin/*", (_req, res) => {
    res.sendFile(resolve(adminDist, "index.html"));
  });
}

app.get("/", (_req, res) => {
  res.redirect("/admin/");
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

initDB()
  .then(() => {
    return ensureMediaDirs();
  })
  .then(() => {
    startFeishuReminderScheduler();
    const server = app.listen(config.port, "0.0.0.0", () => {
      console.log(`Update server running on http://0.0.0.0:${config.port}`);
      console.log(`Admin API key: ${config.adminApiKey.slice(0, 4)}****`);
    });
    server.requestTimeout = config.gallery.requestTimeoutMs;
    server.headersTimeout = Math.max(server.headersTimeout, 65000);
    server.keepAliveTimeout = 65000;
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
