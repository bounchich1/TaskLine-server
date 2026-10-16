# Backup, point-in-time recovery and standby

PostgreSQL holds every ticket, message, consent and audit record, so it is backed up continuously
with [pgBackRest](https://pgbackrest.org/). The production image (`infra/postgres`, built by
`deploy/compose.yaml`) is the official `postgres:18.3-alpine` plus pgBackRest 2.57. Nothing else
in the data directory changes, so switching an existing installation to it keeps the same volume.

What you get once it is configured:

| Capability             | How                                                                   | Target                                |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| Continuous WAL archive | `archive_command` pushes every WAL segment to the repository          | RPO ≤ 60 s (`BACKUP_ARCHIVE_TIMEOUT`) |
| Base backups           | `deploy/backup.sh full` weekly, `diff` daily from cron                | kept: last 2 full chains              |
| Point-in-time recovery | `deploy/backup.sh restore-time '<timestamp>' --confirm`               | any second inside the kept chains     |
| Warm standby           | `deploy/compose.standby.yaml` on a second host restores from the repo | RTO ≈ 1–5 min (promote)               |
| Encryption at rest     | `repo1-cipher-type=aes-256-cbc` with `BACKUP_CIPHER_PASS`             | backups unreadable without the pass   |

The drill below (primary → PITR → streaming standby → failover) was run locally on 2026-10-15 with
this exact image: the restore stopped at the target second, the standby received rows through
streaming, and the promoted standby accepted writes.

## Choose the repository

Keep backups **off the database host** and, for Russian personal data (152-ФЗ, art. 18 part 5),
**inside Russia**. Any S3-compatible storage works; examples (confirm the endpoint in the provider's
current documentation):

| Provider                | `BACKUP_S3_ENDPOINT`           | `BACKUP_S3_REGION` | `BACKUP_S3_URI_STYLE` |
| ----------------------- | ------------------------------ | ------------------ | --------------------- |
| Yandex Object Storage   | `storage.yandexcloud.net`      | `ru-central1`      | `host`                |
| Selectel S3             | `s3.ru-1.storage.selcloud.ru`  | `ru-1`             | `path`                |
| VK Cloud Object Storage | `hb.ru-msk.vkcloud-storage.ru` | `ru-msk`           | `host`                |

pgBackRest talks to S3 over HTTPS only. Create a private bucket and a key limited to that bucket.

`BACKUP_REPO_TYPE=posix` keeps the repository in the `backup-repo` volume on the same host. That
gives point-in-time recovery after a mistake in the data, but not protection from losing the host;
use it only until S3 is ready.

## Enable

In `deploy/.env`:

```sh
BACKUP_REPO_TYPE=s3
BACKUP_S3_ENDPOINT=storage.yandexcloud.net
BACKUP_S3_REGION=ru-central1
BACKUP_S3_BUCKET=taskline-backups
BACKUP_S3_KEY=...
BACKUP_S3_KEY_SECRET=...
BACKUP_CIPHER_PASS=...   # init-env.sh generates one; store a copy outside the server
BACKUP_RETENTION_FULL=2
```

Then, from `deploy/`:

```sh
docker compose build postgres
docker compose up -d postgres          # recreates PostgreSQL (a few seconds of downtime)
./backup.sh init                       # stanza-create, check, first full backup
./backup.sh info
```

Until `init` has run, WAL segments cannot be archived and stay on disk (`pg_stat_archiver` shows
failures, the `WalArchiveFailing` alert fires). Run `init` right after enabling.

Losing `BACKUP_CIPHER_PASS` makes every backup unreadable. Keep it in the company password vault.

## Schedule

Host crontab (`crontab -e` as root), times in the host time zone:

```cron
15 2 * * 0     cd /opt/max-support/deploy && ./backup.sh full   >> /var/log/taskline-backup.log 2>&1
15 2 * * 1-6   cd /opt/max-support/deploy && ./backup.sh diff   >> /var/log/taskline-backup.log 2>&1
45 3 1 * *     cd /opt/max-support/deploy && ./backup.sh verify >> /var/log/taskline-backup.log 2>&1
```

Each successful run adds a row to `backup_runs`; `/metrics` exposes the latest one as
`taskline_backup_last_success_timestamp`, and `BackupStale` fires after 26 hours without one.

A nightly logical dump is still useful for moving data between versions or into analytics:

```sh
0 4 * * * cd /opt/max-support/deploy && docker compose exec -T postgres pg_dump -U support -Fc support > /var/backups/support-$(date +\%F).dump
```

## Point-in-time recovery

Use it after a destructive mistake (wrong mass update, deleted rows) or corruption. Everything
written after the target is lost, so pick the last good second and tell the team first.

```sh
./backup.sh info                                        # check the target is inside a kept chain
./backup.sh restore-time '2026-10-15 14:03:00+07' --confirm
```

The script stops `api`, `worker` and `gateway`, stops PostgreSQL, restores with `--delta` (only
changed files are rewritten), lets PostgreSQL replay WAL up to the target and promote, then starts
the application again. Afterwards:

1. Check the data (`docker compose exec postgres psql -U support -d support`).
2. Run `./backup.sh full` — the restore starts a new timeline and the next backup should be full.
3. Note in the incident log what was lost after the target. Client messages that arrived in that
   window are not in MAX history for the bot to refetch; ask clients to repeat if needed.

To rehearse without touching production, restore into a scratch container on another host with
the same `BACKUP_*` settings and `--type=time`.

## Warm standby on a second host

The standby is a read-only copy that replays WAL from the repository (and, when it can reach the
primary, streams changes directly for near-zero lag). Use a host in another data center.

On the standby host, copy `deploy/` and `infra/postgres/`, then create `deploy/.env` with:

```sh
POSTGRES_PASSWORD=<same as primary>
BACKUP_REPO_TYPE=s3
BACKUP_S3_ENDPOINT=...       # same repository settings and BACKUP_CIPHER_PASS as the primary
STANDBY_PRIMARY_CONNINFO=    # optional, see streaming below
```

```sh
docker compose -f compose.standby.yaml up -d --build
docker compose -f compose.standby.yaml exec postgres-standby psql -U support -d support -c 'SELECT pg_is_in_recovery()'
```

The first start restores the latest backup, then follows the archive. Lag without streaming is at
most `BACKUP_ARCHIVE_TIMEOUT` seconds.

### Streaming (optional)

Streaming needs a private network between the hosts (WireGuard, a cloud VPC); never publish
PostgreSQL to the internet. On the primary, in `deploy/.env`:

```sh
PG_REPLICATION_HBA=10.0.0.0/24        # standby network allowed to replicate
PG_REPLICATION_BIND=10.0.0.2:5432     # private address PostgreSQL listens on
```

```sh
docker compose -f compose.yaml -f compose.replication.yaml up -d postgres
```

On the standby: `STANDBY_PRIMARY_CONNINFO=host=10.0.0.2 port=5432 user=support password=... application_name=standby`.
The primary then reports the replica in `taskline_pg_replicas`, and `ReplicaLagging` fires above 5 minutes.

### Failover

1. Make sure the old primary is down and stays down (stop its containers, or power off the VM).
   Two primaries writing to one repository corrupt the archive history.
2. Promote: `docker compose -f compose.standby.yaml exec postgres-standby psql -U support -d support -c 'SELECT pg_promote()'`.
3. Point the application at the new database: run the full stack on the standby host with the same
   `deploy/.env` (S3 files, agentmemory volumes and Redis are separate — restore the agentmemory
   volumes from their own backup or refill them with `memory-reconcile`), or change `DATABASE_URL`
   if the application stays on the old host.
4. Run `./backup.sh full` on the new primary.
5. Rebuild the old host as the new standby (empty its PostgreSQL volume first).

## Other state

| Data           | Where                                      | Backup                                                                             |
| -------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Attachments    | SeaweedFS `object-data` volume (versioned) | `rclone sync` the bucket to the same off-site storage nightly                      |
| Knowledge base | agentmemory `memory-*` volumes             | stop `memory` + `memory-engine`, copy volumes; PostgreSQL keeps the source records |
| Redis          | `redis-data` (AOF)                         | not needed: jobs and deliveries are rebuilt from PostgreSQL                        |
| `deploy/.env`  | host                                       | password vault (contains every secret)                                             |
