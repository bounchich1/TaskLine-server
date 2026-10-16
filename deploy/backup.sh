#!/bin/sh
set -eu
cd "$(dirname "$0")"

usage() {
    echo "usage: $0 init | full | diff | incr | check | info | verify | restore-time '<YYYY-MM-DD HH:MM:SS+TZ>' --confirm" >&2
    exit 2
}

pgbackrest() {
    docker compose exec -T -u postgres postgres pgbackrest "$@"
}

record() {
    docker compose exec -T postgres psql -U support -d support -qc \
        "INSERT INTO backup_runs(kind,label) VALUES ('$1','$(date -u +%Y-%m-%dT%H:%M:%SZ)')"
}

restore_time() {
    target="$1"

    docker compose stop api worker gateway
    docker compose stop postgres
    docker compose run --rm --no-deps --entrypoint sh postgres -c \
        "pgbackrest-config && gosu postgres pgbackrest --delta --type=time '--target=$target' --target-action=promote restore"
    docker compose up -d --wait postgres
    docker compose up -d --wait api worker gateway
}

case "${1:-}" in
    init)
        pgbackrest stanza-create
        pgbackrest check
        pgbackrest --type=full backup
        record full
        ;;
    full | diff | incr)
        pgbackrest --type="$1" backup
        record "$1"
        ;;
    check)
        pgbackrest check
        ;;
    info)
        pgbackrest info
        ;;
    verify)
        pgbackrest verify
        record verify
        ;;
    restore-time)
        [ "${3:-}" = --confirm ] || usage
        restore_time "${2:?}"
        ;;
    *)
        usage
        ;;
esac
