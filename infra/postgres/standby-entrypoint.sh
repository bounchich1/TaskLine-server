#!/bin/sh
set -eu

: "${BACKUP_REPO_TYPE:?a standby restores from the backup repository, set BACKUP_REPO_TYPE}"

pgbackrest-config

if [ ! -s "$PGDATA/PG_VERSION" ]; then
    mkdir -p "$PGDATA"
    chown -R postgres:postgres "$(dirname "$PGDATA")"
    chmod 700 "$PGDATA"

    if [ -n "${STANDBY_PRIMARY_CONNINFO:-}" ]; then
        gosu postgres pgbackrest --type=standby --target-timeline=latest \
            "--recovery-option=primary_conninfo=$STANDBY_PRIMARY_CONNINFO" restore
    else
        gosu postgres pgbackrest --type=standby --target-timeline=latest restore
    fi
fi

exec docker-entrypoint.sh "$@"
