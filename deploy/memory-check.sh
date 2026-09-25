#!/bin/sh
set -eu
cd "$(dirname "$0")"

marker=memcheck-$(date +%s)
content="Проверка памяти $marker: принтер печатает пустые страницы, помогла замена картриджа."

call() {
  docker compose run --rm --no-deps -T -e SECRET="${SECRET_OVERRIDE:-}" api sh -c '
    auth=${SECRET:-$AGENTMEMORY_SECRET}
    if [ $# -gt 1 ]; then
      wget -qO- --header "Authorization: Bearer $auth" --header "Content-Type: application/json" --post-data "$2" "$AGENTMEMORY_URL$1"
    else
      wget -qO- --header "Authorization: Bearer $auth" "$AGENTMEMORY_URL$1"
    fi' sh "$@" 2>&1
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

pass() {
  echo "ok   $1"
}

wait_ready() {
  for _ in $(seq 30); do
    if call /agentmemory/memories/mem_readiness | grep -q 404; then
      return 0
    fi

    sleep 2
  done

  fail "agentmemory did not come back"
}

search_finds() {
  for _ in $(seq 10); do
    if call /agentmemory/smart-search '{"query":"принтер пустые страницы картридж","limit":20,"agentId":"support-knowledge"}' |
      grep -q "\"obsId\":\"$1\""; then
      return 0
    fi

    sleep 2
  done

  return 1
}

wait_ready
pass "agentmemory reachable at the api's AGENTMEMORY_URL"

SECRET_OVERRIDE=wrong-secret-wrong-secret-wrong-secret call /agentmemory/memories/mem_x | grep -Eq '401|403' ||
  fail "a wrong secret was not rejected"
pass "wrong secret rejected"

saved=$(call /agentmemory/remember "{\"content\":\"$content\",\"type\":\"workflow\",\"concepts\":[\"memcheck\"],\"project\":\"memcheck_$marker\",\"agentId\":\"support-knowledge\",\"ttlDays\":1}" || true)
id=$(printf '%s' "$saved" | grep -o '"id":"mem_[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$id" ] || fail "remember returned no id: $saved"
pass "remember -> $id"

call "/agentmemory/memories/$id" | grep -q "$marker" || fail "exact read did not return the content"
pass "exact read, Cyrillic content intact"

search_finds "$id" || fail "search did not find the new memory"
pass "search finds it"

docker compose restart memory-engine memory >/dev/null 2>&1
wait_ready
call "/agentmemory/memories/$id" | grep -q "$marker" || fail "memory lost on restart"
search_finds "$id" || fail "search lost the memory on restart"
pass "survives restart (read and search)"

call /agentmemory/forget "{\"memoryId\":\"$id\"}" | grep -q '"success":true' || fail "forget failed"
call "/agentmemory/memories/$id" | grep -q 404 || fail "memory still readable after forget"
pass "forget, then exact read is 404"

docker compose restart memory-engine memory >/dev/null 2>&1
wait_ready
call "/agentmemory/memories/$id" | grep -q 404 || fail "deleted memory came back after restart"
search_finds "$id" && fail "deleted memory still found by search"
pass "still absent after restart"

echo "agentmemory check passed; MEMORY_ENABLED=true is safe to set"
