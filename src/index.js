import express from "express";
import cors from "cors";
import morgan from "morgan";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { initDB } from "./db/index.js";
import releasesRouter from "./routes/releases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(morgan("short"));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/apps", releasesRouter);

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
    app.listen(config.port, "0.0.0.0", () => {
      console.log(`Update server running on http://0.0.0.0:${config.port}`);
      console.log(`Admin API key: ${config.adminApiKey.slice(0, 4)}****`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
