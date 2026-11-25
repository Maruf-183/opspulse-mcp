// Idempotent, additive-only migrations, run before each Vercel build
// (`vercel-build`). Applies every statement in drizzle/*.sql with IF NOT
// EXISTS guards and skips objects that already exist, so it is safe on a
// database created earlier with `drizzle-kit push`. Refuses destructive SQL.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("[migrate] DATABASE_URL not set; skipping.");
  process.exit(0);
}

const dir = path.resolve(import.meta.dirname, "../drizzle");
const statements = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .flatMap((f) => readFileSync(path.join(dir, f), "utf8").split("--> statement-breakpoint"))
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) =>
    s
      .replace(/^CREATE TABLE "/, 'CREATE TABLE IF NOT EXISTS "')
      .replace(/^CREATE (UNIQUE )?INDEX "/, (_, unique) => `CREATE ${unique ?? ""}INDEX IF NOT EXISTS "`),
  );

// Loosening a NOT NULL is safe; dropping tables/columns/data or changing a column's type is not.
const destructive = statements.filter(
  (s) =>
    /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|SCHEMA|VIEW)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i.test(s) ||
    /ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i.test(s),
);
if (destructive.length) {
  console.error("[migrate] Refusing to run destructive statements:\n" + destructive.join("\n"));
  process.exit(1);
}

const local = /localhost|127\.0\.0\.1/.test(url);
const client = new pg.Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } });
await client.connect();
let applied = 0;
let skipped = 0;
for (const sql of statements) {
  try {
    await client.query(sql);
    applied++;
  } catch (error) {
    // 42P07 relation exists, 42710 object exists, 42P16 multiple primary keys
    if (["42P07", "42710", "42P16"].includes(error.code) || /already exists/.test(error.message)) skipped++;
    else {
      console.error(`[migrate] Failed: ${sql.split("\n")[0]}\n${error.message}`);
      await client.end();
      process.exit(1);
    }
  }
}
await client.end();
console.log(`[migrate] done: ${applied} statements ran (existing objects left unchanged), ${skipped} skipped.`);
