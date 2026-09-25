#!/bin/sh
set -eu
cd "$(dirname "$0")"

usage() {
  echo "usage: $0 server|mini-app <tag>" >&2
  exit 2
}

[ $# -eq 2 ] || usage
component=$1
tag=$2
case "$component" in
  server) key=SERVER_TAG services="api worker gateway" ;;
  mini-app) key=MINI_APP_TAG services="mini-app" ;;
  *) usage ;;
esac
printf '%s' "$tag" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' || usage

exec 9>.deploy.lock
flock 9

previous=$(sed -n "s/^$key=//p" .env)
set_tag() {
  sed -i "s/^$key=.*/$key=$1/" .env
}

rollback() {
  echo "$component $tag: $1; staying on $previous" >&2
  set_tag "$previous"
  docker compose up -d --wait --wait-timeout 180 $services
  exit 1
}

set_tag "$tag"
docker compose pull --quiet $services || rollback "image pull failed"
if [ "$component" = server ]; then
  docker compose run --rm api node dist/cli.js migrate || rollback "migration failed"
fi
docker compose up -d --wait --wait-timeout 180 $services || rollback "health checks failed"
echo "$(date -u +%FT%TZ) $component $previous -> $tag" | tee -a deploy.log
