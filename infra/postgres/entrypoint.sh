#!/bin/sh
set -eu

pgbackrest-config

if [ -s "$PGDATA/PG_VERSION" ]; then
    gosu postgres replication-hba
fi

exec docker-entrypoint.sh "$@"
