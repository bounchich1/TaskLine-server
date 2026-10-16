#!/bin/sh
set -eu

hba="$PGDATA/pg_hba.conf"

if [ -n "${PG_REPLICATION_HBA:-}" ] && [ -f "$hba" ] && ! grep -q '^host replication ' "$hba"; then
    echo "host replication all $PG_REPLICATION_HBA scram-sha-256" >> "$hba"
fi
