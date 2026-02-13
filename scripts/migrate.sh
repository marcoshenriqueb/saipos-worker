#!/usr/bin/env sh
set -eu

# Runs SQL migrations in ./migrations against DATABASE_URL.
# Tracks applied migrations in schema_migrations table.
# Usage:
#   DATABASE_URL=... ./scripts/migrate.sh

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ DATABASE_URL is not set"
  exit 1
fi

# Print without querystring if present
BASE_URL="${DATABASE_URL%%\\?*}"
echo "🗄️  Running migrations against: $BASE_URL"

node <<'NODE'
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

function listSqlMigrations(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

(async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  await client.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const migrationsDir = path.resolve(process.cwd(), "migrations");
  if (!fs.existsSync(migrationsDir)) {
    console.error(`❌ Migrations directory not found: ${migrationsDir}`);
    process.exit(1);
  }

  const files = listSqlMigrations(migrationsDir);

  const applied = new Set(
    (await client.query("select id from schema_migrations")).rows.map((r) => r.id)
  );

  let appliedCount = 0;

  for (const file of files) {
    if (applied.has(file)) continue;

    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, "utf8").trim();

    console.log(`➡️  Applying: ${file}`);
    await client.query("begin");
    try {
      if (sql) await client.query(sql);
      await client.query("insert into schema_migrations (id) values ($1)", [file]);
      await client.query("commit");
      console.log(`✅ Applied: ${file}`);
      appliedCount++;
    } catch (err) {
      await client.query("rollback");
      console.error(`❌ Failed: ${file}`);
      console.error(err && err.message ? err.message : err);
      process.exit(1);
    }
  }

  await client.end();
  console.log(`🎉 Migrations OK. Newly applied: ${appliedCount}`);
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
NODE