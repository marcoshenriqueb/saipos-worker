#!/usr/bin/env bash
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-db}"
DB_NAME="${DB_NAME:-saipos}"
DB_USER="${DB_USER:-postgres}"

echo "==> ensuring schema_migrations table"
docker compose exec -T "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" < migrations/000_schema_migrations.sql

for f in migrations/*.sql; do
  base="$(basename "$f")"
  # pula o 000 (ele já rodou acima)
  if [[ "$base" == "000_schema_migrations.sql" ]]; then
    continue
  fi

  already="$(docker compose exec -T "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "select 1 from schema_migrations where id='$base' limit 1;")"

  if [[ "$already" == "1" ]]; then
    echo "==> skip $base (already applied)"
    continue
  fi

  echo "==> apply $base"
  docker compose exec -T "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" < "$f"

  docker compose exec -T "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
    "insert into schema_migrations(id) values('$base') on conflict do nothing;"
done

echo "==> done"