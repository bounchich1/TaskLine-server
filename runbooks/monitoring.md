# Monitoring and alerts

Prometheus scrapes the API's `/metrics`, evaluates the rules in
[deploy/monitoring/alerts.yml](../deploy/monitoring/alerts.yml) and hands firing alerts to
Alertmanager, which posts them back to the API at `/internal/alerts`. The API forwards each batch
to every active administrator as a MAX message from the staff bot (or the client bot when no staff
bot is configured):

```
Тревога · TaskLine
• InboxBacklog — Сообщения клиентов не обрабатываются больше 2 минут — проверьте worker.
```

Resolved alerts arrive the same way under «Решено».

## Enable

`deploy/.env`:

```sh
OPS_TOKEN=<64 hex, init-env.sh generates it>
COMPOSE_PROFILES=monitoring
```

```sh
docker compose up -d
docker compose ps prometheus alertmanager node-exporter
```

`OPS_TOKEN` turns on `/metrics` and `/internal/alerts`; without it both answer 404. The token
reaches Prometheus and Alertmanager as the compose secret `ops_token`. Caddy does not route either
path, so they are reachable only inside the compose network.

Neither Prometheus nor Alertmanager publishes a port. Quick checks from the host:

```sh
docker compose exec prometheus wget -qO- 'http://localhost:9090/api/v1/alerts'
docker compose exec alertmanager wget -qO- 'http://localhost:9093/api/v2/alerts'
```

## What is measured

All series come from PostgreSQL at scrape time, so they are correct whichever process (api,
worker, gateway) did the work.

| Metric                                                                                                       | Meaning                                        |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `taskline_inbox_pending`, `…_oldest_pending_seconds`                                                         | client updates not yet processed by the worker |
| `taskline_jobs{kind,state}`, `taskline_job_overdue_seconds{kind}`                                            | background jobs and how late they are          |
| `taskline_deliveries{state}`, `taskline_delivery_oldest_seconds{state}`                                      | replies not yet in MAX                         |
| `taskline_ai_permits{state}`, `taskline_ai_calls_last_hour{state}`                                           | model concurrency and call outcomes            |
| `taskline_ai_call_p50_seconds`, `…_p95_seconds`                                                              | model latency, last hour                       |
| `taskline_triage_last_hour{ai_status}`                                                                       | new tickets by AI analysis result              |
| `taskline_tickets_active{status}`, `taskline_ticket_oldest_unassigned_seconds`                               | queue size and wait                            |
| `taskline_sla_at_risk`, `taskline_sla_breached_active`                                                       | open tickets past the SLA warning / deadline   |
| `taskline_closures{learning_status}`, `taskline_memory_records{state}`                                       | closure learning and knowledge base            |
| `taskline_backup_last_success_timestamp{kind}`                                                               | last successful `deploy/backup.sh` run         |
| `taskline_pg_wal_*`, `taskline_pg_replicas`, `taskline_pg_replica_lag_seconds`, `taskline_pg_database_bytes` | archiving, standby, size                       |
| `process_*`, `nodejs_*`, `taskline_build_info{version}`                                                      | API process health and running version         |
| `node_*` (node-exporter)                                                                                     | host disk, memory, CPU                         |

## Alerts

| Alert                    | Fires when                                       | First thing to check                                        |
| ------------------------ | ------------------------------------------------ | ----------------------------------------------------------- |
| `ApiDown`                | scrape fails 2 min                               | `docker compose ps api`, logs; this alert may not reach MAX |
| `InboxBacklog`           | oldest unprocessed update > 2 min                | `docker compose logs worker`, Redis health                  |
| `JobsOverdue`            | a due job waits > 10 min                         | worker, Redis, AI gateway                                   |
| `JobsFailing`            | failed jobs grew in 30 min                       | Управление → Состояние системы, retry                       |
| `DeliveriesStuck`        | queued reply older than 5 min                    | MAX reachability (MTU, CA), bot token                       |
| `DeliveryOutcomeUnknown` | unknown send outcome for 15 min                  | resolve in Состояние системы                                |
| `TicketWaiting`          | open ticket unassigned for 30 min                | staffing, not a technical fault                             |
| `EventLoopBlocked`       | API event loop p99 > 0.5 s                       | CPU, a slow request in logs                                 |
| `AiPermitsUncertain`     | permit stuck uncertain 15 min                    | `node dist/cli.js permit-resolve`                           |
| `TriageFailing`          | > 30 % of new tickets without AI analysis        | provider status, `ai_calls` reasons                         |
| `WalArchiveFailing`      | archive failures and nothing archived for 10 min | repository credentials, `./backup.sh check`                 |
| `BackupStale`            | no successful base backup for 26 h               | cron, `/var/log/taskline-backup.log`                        |
| `BackupMissing`          | backups never ran                                | [backup-and-recovery.md](backup-and-recovery.md)            |
| `ReplicaLagging`         | standby more than 5 min behind                   | network to the standby, its disk                            |
| `DiskAlmostFull`         | a filesystem under 15 % free                     | WAL piling up (archive failing), logs, Docker images        |
| `MemoryLow`              | under 10 % memory available                      | ClamAV and agentmemory are the largest consumers            |

Alerts that describe the API itself (`ApiDown`) cannot be delivered through the API. Add an
external uptime check of `https://DOMAIN/health/ready` (any monitoring service, or a cron job on
another machine) so an outage of the whole host is noticed too.

## Changing rules

Edit `deploy/monitoring/alerts.yml`, validate, and reload:

```sh
docker run --rm -v "$PWD/monitoring:/cfg:ro" --entrypoint promtool prom/prometheus:v3.5.0 check rules /cfg/alerts.yml
docker compose restart prometheus
```
