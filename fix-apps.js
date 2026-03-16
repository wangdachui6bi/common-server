import { initDB, db } from "./src/db/index.js";
import pool from "./src/db/index.js";

async function run() {
  await initDB();
  const releases = await pool.query("SELECT DISTINCT app_id FROM releases");
  console.log("Releases app_ids:", releases[0]);
  
  for (const row of releases[0]) {
    await db.upsertApp(row.app_id);
    console.log("Upserted app:", row.app_id);
  }
  
  const apps = await db.listApps();
  console.log("Apps list:", apps);
  process.exit(0);
}

run().catch(console.error);