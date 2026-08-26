import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const connectionString = String(process.env.SUPABASE_DB_URL ?? "").trim();
if (!connectionString) throw new Error("Isi SUPABASE_DB_URL dengan connection string Postgres dari Supabase terlebih dahulu.");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Semua .sql dijalankan berurutan; tiap file idempoten (create if not exists)
// jadi aman dieksekusi ulang kapan pun.
const files = (await readdir(join(root, "db/migrations"))).filter((name) => name.endsWith(".sql")).sort();
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  for (const name of files) {
    const sql = await readFile(join(root, "db/migrations", name), "utf8");
    await client.query(sql);
    console.log("Migrasi selesai:", name);
  }
} finally {
  await client.end();
}
