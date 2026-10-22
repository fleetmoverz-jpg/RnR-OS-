#!/usr/bin/env bash
# Applies every migration to a disposable Postgres database, then runs the SQL tests.
# The tests run inside a transaction and roll back.
#   TEST_DATABASE_URL=postgres://postgres@localhost:5432/rnr_test npm run test:db
# Never point this at production: the migrations are applied for real.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "Set TEST_DATABASE_URL to a disposable Postgres 15+ database." >&2
  exit 1
fi

for f in supabase/migrations/*.sql; do
  psql "$TEST_DATABASE_URL" -q -v ON_ERROR_STOP=1 -c "set client_min_messages = warning" -f "$f" >/dev/null
done
for f in supabase/tests/*.sql; do
  echo "== $f"
  psql "$TEST_DATABASE_URL" -q -v ON_ERROR_STOP=1 -o /dev/null -f "$f" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //'
done
