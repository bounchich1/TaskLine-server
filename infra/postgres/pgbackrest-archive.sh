#!/bin/sh
set -eu

if [ -z "${BACKUP_REPO_TYPE:-}" ]; then
    exit 0
fi

exec pgbackrest archive-push "$1"
