#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -e .env ]; then
  echo ".env already exists; remove it first to regenerate secrets" >&2
  exit 1
fi
umask 077
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *=GENERATE) printf '%s=%s\n' "${line%=GENERATE}" "$(openssl rand -hex 32)" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < .env.example > .env
echo "Wrote .env with fresh secrets. Now set DOMAIN, the images, MAX_BOT_TOKEN, MAX_STAFF_BOT_TOKEN and the policy."
