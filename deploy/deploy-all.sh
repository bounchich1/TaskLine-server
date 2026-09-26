#!/bin/sh
set -eu
cd "$(dirname "$0")"

[ $# -eq 2 ] || { echo "usage: $0 server|mini-app <tag>" >&2; exit 2; }

./deploy.sh "$1" "$2"

demo=${DEMO_DEPLOY_DIR:-/opt/max-support-demo/deploy}
if [ -f "$demo/.env" ]; then
  git -C "$demo" pull --ff-only --quiet
  "$demo/deploy.sh" "$1" "$2"
fi
