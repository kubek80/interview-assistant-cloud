#!/bin/sh
# A throwaway local PostgreSQL cluster for development and tests (HOST-8). No Docker needed.
#
#   sh scripts/dev-db.sh start    create (first time) and start the cluster on 127.0.0.1:$PGDEV_PORT
#   sh scripts/dev-db.sh stop     stop it
#   sh scripts/dev-db.sh status   is it running?
#   sh scripts/dev-db.sh reset    stop, delete every database and start again from nothing
#   sh scripts/dev-db.sh psql     open psql on the development database
#
# The cluster lives in $PGDEV_DIR (default .dev-db/ in the repository, git-ignored). It listens only on
# 127.0.0.1 with "trust" authentication: it is for one developer's machine or a CI runner, never for
# real data. It creates the role "ia" (allowed to create databases, which the server tests need) and
# the databases ia_dev and ia_test.
#
# PostgreSQL refuses to run as root. When this script runs as root (for example in a container) it
# runs the server as the "postgres" system user (or $PGDEV_OS_USER) and hands it the data directory.
#
# Binaries: found on PATH, else in $PG_BIN, else in /usr/lib/postgresql/<16|17|15>/bin.
#
# Then:  export DATABASE_URL=postgres://ia@127.0.0.1:54329/ia_dev
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PGDEV_DIR=${PGDEV_DIR:-"$ROOT/.dev-db"}
PGDEV_PORT=${PGDEV_PORT:-54329}
DATA="$PGDEV_DIR/data"
LOG="$PGDEV_DIR/postgres.log"
SOCK="$PGDEV_DIR/socket"

find_bin() {
  if [ -n "${PG_BIN:-}" ]; then echo "$PG_BIN"; return; fi
  if command -v pg_ctl >/dev/null 2>&1; then dirname "$(command -v pg_ctl)"; return; fi
  for v in 16 17 15 18; do
    if [ -x "/usr/lib/postgresql/$v/bin/pg_ctl" ]; then echo "/usr/lib/postgresql/$v/bin"; return; fi
  done
  echo "PostgreSQL binaries not found. Install PostgreSQL 16 or set PG_BIN to its bin directory." >&2
  exit 1
}
BIN=$(find_bin)

# Run a command as the cluster owner (ourselves, or the postgres system user when we are root).
as_owner() {
  if [ "$(id -u)" = "0" ]; then
    OWNER=${PGDEV_OS_USER:-postgres}
    if command -v runuser >/dev/null 2>&1; then runuser -u "$OWNER" -- "$@"; else su "$OWNER" -s /bin/sh -c "$(printf '%s ' "$@")"; fi
  else
    "$@"
  fi
}

running() { as_owner "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; }

psql_admin() { as_owner "$BIN/psql" -h "$SOCK" -p "$PGDEV_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

init() {
  mkdir -p "$PGDEV_DIR" "$SOCK"
  if [ "$(id -u)" = "0" ]; then chown -R "${PGDEV_OS_USER:-postgres}" "$PGDEV_DIR"; fi
  if [ ! -f "$DATA/PG_VERSION" ]; then
    echo "Creating a development cluster in $DATA"
    as_owner "$BIN/initdb" -D "$DATA" -U postgres --auth=trust --encoding=UTF8 --no-locale >/dev/null
  fi
}

start() {
  init
  if running; then echo "Development database already running on 127.0.0.1:$PGDEV_PORT"; return; fi
  as_owner "$BIN/pg_ctl" -D "$DATA" -l "$LOG" -w -t 30 \
    -o "-p $PGDEV_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$SOCK -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200" start >/dev/null
  psql_admin <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ia') THEN CREATE ROLE ia LOGIN CREATEDB; END IF;
END \$\$;
SQL
  for db in ia_dev ia_test; do
    if [ -z "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'")" ]; then psql_admin -c "CREATE DATABASE $db OWNER ia"; fi
  done
  echo "Development database running on 127.0.0.1:$PGDEV_PORT"
  echo "  DATABASE_URL=postgres://ia@127.0.0.1:$PGDEV_PORT/ia_dev"
  echo "  TEST_DATABASE_URL=postgres://ia@127.0.0.1:$PGDEV_PORT/ia_test"
}

stop() {
  if [ -f "$DATA/PG_VERSION" ] && running; then
    as_owner "$BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null
    echo "Development database stopped"
  else
    echo "Development database is not running"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) if [ -f "$DATA/PG_VERSION" ] && running; then echo "running on 127.0.0.1:$PGDEV_PORT"; else echo "stopped"; exit 3; fi ;;
  reset) stop; rm -rf "$PGDEV_DIR"; start ;;
  psql) shift; "$BIN/psql" "postgres://ia@127.0.0.1:$PGDEV_PORT/ia_dev" "$@" ;;
  *) echo "usage: sh scripts/dev-db.sh start|stop|status|reset|psql" >&2; exit 2 ;;
esac
