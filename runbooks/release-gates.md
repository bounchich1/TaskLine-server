# Release gates

The automated suites run against mocked MAX, AI and storage. These gates need the real bot, a
public HTTPS host and real providers, so they are checked by hand on the deployed stack
([deploy.md](deploy.md)). For each gate record the date, the versions from
`/health/live` and Управление → Состояние системы, and the evidence (screenshots, log lines
without client data). Use test accounts, never real client data.

## Gate 1 — pilot with human support only

Configuration: `NODE_ENV=production`, `AI_ENABLED=false`, `MEMORY_ENABLED=false`.

1. **Start-up guards.** The stack starts; `api` is healthy only after `migrate`
   (`/health/ready` returns 503 while the schema is behind).
2. **Webhook.** `subscribe` succeeds. A message to the bot reaches the inbox within seconds.
   A request to `/webhooks/max` with a wrong `X-Max-Bot-Api-Secret` is rejected.
3. **Consent.** First message → consent prompt with the policy link. «Отказаться» → the
   alternative contact. «Согласен» → «Согласие принято». Text sent before consenting becomes the
   ticket after consenting.
4. **Ticket round trip.** The client gets the ticket number. A staff reply from the mini-app
   arrives in the same chat, from the bot. The client's answer appears in the open ticket
   without a reload.
5. **Files.** A photo, a video and a document from the client arrive (`MAX_MEDIA_HOSTS` set),
   pass the scanner and open in the mini-app on a phone and on desktop. A staff attachment
   reaches the client.
6. **Close and rating.** Closing sends the rating request. An invalid answer gets the retry
   prompt; a number from 1 to 10 gets the thanks. On a test ticket, the reminder comes after
   24 hours and the rating expires after 72 hours.
7. **Mini-app launch.** Opens from MAX on iOS, Android and desktop/web. An employee sees the
   queue; a MAX account that is not an employee gets «Доступ к службе поддержки не
   предоставлен». The back button works, and closing with an unsent draft asks for
   confirmation.
8. **Staff administration.** Adding an employee grants access; blocking one ends their session
   at once.
9. **Client commands.** «мои обращения» lists tickets. «отозвать согласие» closes the active
   ticket without a rating.
10. **Restart.** `docker compose restart api worker` in the middle of a conversation loses and
    duplicates nothing. Note what MAX does with webhooks sent while the API was down.
11. **Deploy and rollback.** `deploy.sh server <new>` and back to `<old>` both finish healthy.
12. **Backup.** Last night's dump restores into a scratch database and contains the test
    tickets.

## Gate 2 — AI triage

1. The provider is reachable from the host and approved for personal data. `AI_MODE=live`,
   `AI_API_KEY`, `AI_MODEL` set; then `AI_ENABLED=true` and `docker compose up -d`.
2. New tickets get tags, urgency and a suggested solution within 120 seconds.
3. With the provider unreachable (block egress for a minute), tickets still arrive and staff
   can answer; triage falls back to «Необходима проверка сотрудником».
4. The AI call grid in Управление → Состояние системы never shows more calls than the cap.

## Gate 3 — closure learning and recall

1. agentmemory runs with persistent volumes (`memory`, `memory-engine` in
   `deploy/compose.yaml`); `deploy/memory-check.sh` passes: remember, exact read, search,
   restart, delete, Cyrillic recall, wrong secret rejected.
2. `MEMORY_ENABLED=true`: a closed ticket produces a learning record; a similar new ticket
   recalls it; a reopened ticket's memory is no longer recalled.

## Provider facts to record

Still unknown from documentation alone (plan chapters 10 and 13): outbound text length and
per-chat send rate, accepted upload formats and link lifetime, edit and delete events,
whether MAX redelivers a webhook that failed, and the hosts it serves client files from.
