#!/bin/sh
set -eu

conf=/etc/pgbackrest/pgbackrest.conf
repo_path="${BACKUP_REPO_PATH:-/pgbackrest}"

{
    echo '[global]'

    if [ -n "${BACKUP_REPO_TYPE:-}" ]; then
        echo "repo1-type=$BACKUP_REPO_TYPE"
        echo "repo1-path=$repo_path"
        echo "repo1-retention-full=${BACKUP_RETENTION_FULL:-2}"
    fi

    if [ "${BACKUP_REPO_TYPE:-}" = s3 ]; then
        echo "repo1-s3-endpoint=${BACKUP_S3_ENDPOINT:?set BACKUP_S3_ENDPOINT}"
        echo "repo1-s3-bucket=${BACKUP_S3_BUCKET:?set BACKUP_S3_BUCKET}"
        echo "repo1-s3-region=${BACKUP_S3_REGION:?set BACKUP_S3_REGION}"
        echo "repo1-s3-key=${BACKUP_S3_KEY:?set BACKUP_S3_KEY}"
        echo "repo1-s3-key-secret=${BACKUP_S3_KEY_SECRET:?set BACKUP_S3_KEY_SECRET}"
        echo "repo1-s3-uri-style=${BACKUP_S3_URI_STYLE:-host}"
    fi

    if [ -n "${BACKUP_CIPHER_PASS:-}" ]; then
        echo 'repo1-cipher-type=aes-256-cbc'
        echo "repo1-cipher-pass=$BACKUP_CIPHER_PASS"
    fi

    echo
    echo "[$PGBACKREST_STANZA]"
    echo "pg1-path=$PGDATA"
    echo "pg1-user=${POSTGRES_USER:-postgres}"
} > "$conf"

chown root:postgres "$conf"
chmod 640 "$conf"

if [ "${BACKUP_REPO_TYPE:-}" = posix ]; then
    install -d -o postgres -g postgres -m 750 "$repo_path"
fi
