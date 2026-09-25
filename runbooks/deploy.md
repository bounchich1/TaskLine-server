# Deployment

One Linux host runs everything with Docker Compose (`deploy/compose.yaml`):

| Service                     | Role                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| caddy                       | HTTPS for `DOMAIN`; `/v1`, `/download`, `/webhooks`, `/health` → api; the rest → mini-app |
| mini-app                    | Static staff app (image from the mini-app repository)                                     |
| api                         | HTTP API and MAX webhook                                                                  |
| worker                      | Delivery, files, timers, AI jobs                                                          |
| gateway                     | AI gateway (idle while `AI_ENABLED=false`)                                                |
| memory, memory-engine       | agentmemory recall store for AI learning (used only with `MEMORY_ENABLED=true`)           |
| postgres, redis, clamav, s3 | Database, job transport, virus scanner, private file storage (SeaweedFS)                  |

The API and the mini-app share one origin, so `PUBLIC_URL` and `APP_ORIGIN` are both
`https://DOMAIN` and no CORS setup is needed.

## Requirements

- A Linux VPS hosted in Russia (personal data of Russian citizens stays in Russia, 152-ФЗ):
  2 vCPU, 4 GB RAM (ClamAV alone needs about 1.5 GB), 40 GB disk. The `memory` image is built on
  the host from `infra/agentmemory`, so keep the repository checkout next to `deploy/`.
- Docker Engine with Compose v2.20 or newer, `openssl`, `flock`.
- A DNS `A` record for `DOMAIN` pointing at the host; ports 80 and 443 open.
- The MAX bot token, and the privacy policy published at an HTTPS URL.
- Images published by CI (see [Releasing](#releasing)). GHCR packages are private by default:
  run `docker login ghcr.io` on the host with a token that has `read:packages`, or make the
  two packages public.

## First setup

```sh
git clone <server repository> /opt/max-support
cd /opt/max-support/deploy
sh init-env.sh          # .env with fresh secrets
nano .env               # DOMAIN, image tags, MAX_BOT_TOKEN, POLICY_*, ALTERNATIVE_CONTACT, BOOTSTRAP_MAX_USER_ID
docker compose up -d postgres redis s3 clamav
docker compose run --rm api node dist/cli.js storage-init
docker compose run --rm api node dist/cli.js migrate
docker compose run --rm api node dist/cli.js bootstrap
docker compose up -d
docker compose run --rm api node dist/cli.js subscribe
```

The server refuses to start in production with placeholders left in: an empty
`MAX_BOT_TOKEN`, a `POLICY_VERSION` starting with `dev-`, or a non-HTTPS / `.invalid` URL.
`BOOTSTRAP_MAX_USER_ID` is your own MAX user id; it becomes the first administrator.

To use a managed S3 bucket (Yandex Object Storage, Selectel, VK Cloud) instead of the local
`s3` service, set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` and the key pair in `.env`, skip
`storage-init` if the bucket already exists with versioning, and stop the `s3` service.

Then, on the MAX partner platform, set the bot's mini-app URL to `https://DOMAIN/`. Other
staff are added in the app: Управление → Сотрудники, by MAX user id.

### Allowed media hosts

Client attachments are downloaded only from hosts listed in `MAX_MEDIA_HOSTS`. On a new
install, send a photo to the bot, then:

```sh
docker compose run --rm api node dist/cli.js media-hosts
```

Put the printed hosts (comma-separated) into `MAX_MEDIA_HOSTS`, run `docker compose up -d`,
and retry the failed file job in Управление → Состояние системы (or ask the client to send the file again).

### AI and memory

AI stays off until `AI_ENABLED=true`, `AI_API_KEY` and `AI_MODEL` are set in `.env` (then
`docker compose up -d`). The provider must accept OpenAI-style chat completions over HTTPS.

agentmemory (`memory` + `memory-engine`) starts with the stack and is reachable only inside the
compose network at `http://memory-engine:3111`, authenticated with `AGENTMEMORY_SECRET`. Before
turning recall on, prove it on this host:

```sh
./memory-check.sh       # remember, exact read, search, restart, forget, Cyrillic text, wrong secret
```

When it prints `agentmemory check passed`, set `MEMORY_ENABLED=true` and run `docker compose up -d`.
Memory has no effect while `AI_ENABLED=false`.

## Releasing

Each repository builds its image when a `v*` tag is pushed:

```sh
git tag v0.2.0
git push origin v0.2.0
```

CI runs the checks, pushes `ghcr.io/<owner>/max-support-server:v0.2.0` (or
`max-support-mini-app`), and, when the repository variable `DEPLOY_HOST` is set, runs
`deploy.sh` on the host over SSH. GitHub settings for that:

| Kind     | Name                 | Value                              |
| -------- | -------------------- | ---------------------------------- |
| variable | `DEPLOY_HOST`        | host name or IP                    |
| variable | `DEPLOY_USER`        | a user in the `docker` group       |
| variable | `DEPLOY_PATH`        | `/opt/max-support/deploy`          |
| secret   | `DEPLOY_SSH_KEY`     | private key of that user (ed25519) |
| secret   | `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan <host>`     |

By hand on the host:

```sh
./deploy.sh server v0.2.0
./deploy.sh mini-app v0.3.0
```

`deploy.sh` writes the tag into `.env`, pulls the image, runs `migrate` (server only), restarts
that component and waits for its health checks. If any step fails it puts the previous tag
back and restarts that. Every deploy is appended to `deploy.log`.

- When a release changes the API contract, deploy the server first, then the mini-app.
- Staff get a new mini-app version the next time they open it: `index.html` is served with
  `no-cache` and the assets are content-hashed. The URL registered in MAX never changes.
- What is running: `curl https://DOMAIN/health/live`, or Управление → Состояние
  системы, which shows both the app and the server version.

## Rollback

```sh
./deploy.sh server v0.1.0
```

Migrations only go forward, so each one must leave the schema usable by the previous image
(add columns and tables; drop them a release later).

## Configuration changes

Edit `.env`, then `docker compose up -d` (it recreates only the changed services). For a new
`compose.yaml` or `Caddyfile`: `git pull` in `/opt/max-support`, then `docker compose up -d`.

## Backups

Nightly database dump from cron, copied off the host:

```sh
0 3 * * * cd /opt/max-support/deploy && docker compose exec -T postgres pg_dump -U support -Fc support > /var/backups/support-$(date +\%F).dump
```

Restore into the running stack:

```sh
docker compose exec -T postgres pg_restore -U support -d support --clean --if-exists < /var/backups/support-YYYY-MM-DD.dump
```

agentmemory keeps its state in the `memory-engine-data` and `memory-index-data` volumes. Stop
`memory` and `memory-engine` before copying them (a live copy is not consistent), then start them
again; PostgreSQL keeps the learning records, so a lost memory volume can be refilled from there.

Files live in the `object-data` volume (SeaweedFS, versioning on); back it up with the volume
or copy the bucket with any S3 client (`rclone sync`, `aws s3 sync`). Continuous WAL archiving (point-in-time recovery) is still needed before full
production, see plan chapter 09.

## Operations

```sh
docker compose ps
docker compose logs -f api worker
docker compose run --rm api node dist/cli.js <command>   # ai-cap, permit-resolve, memory-reconcile
```

## Known limits

- MAX serves its API from a certificate issued by the Russian Trusted Root CA (Минцифры), which
  Node does not trust by default. The image ships that root in `certs/` (SHA-256
  `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`,
  valid until 2032, from gosuslugi.ru/crt) and trusts it only for MAX API calls and MAX file
  transfers (`MAX_CA_FILE`). AI provider and S3 connections keep the default trust store.
- The compose network runs with MTU 1400. Some VPS uplinks carry less than 1500 bytes per packet
  (1462 on the first production host) and drop larger ones without a reliable "fragmentation
  needed" reply; containers on a 1500 network then stall on TLS handshakes to MAX at random
  (`max_transport_uncertain`, `UND_ERR_CONNECT_TIMEOUT`) while the host itself looks fine. Check
  with `ip route get <MAX API IP>` on the host: a cached `mtu` below 1500 means the uplink is
  smaller. After changing the network MTU, recreate it: `docker compose down && docker compose up -d`.
- ClamAV updates its signatures with freshclam; if `docker compose logs clamav` shows download
  errors, point freshclam at a mirror. Scanning keeps working on the signatures in the image.
- The API allows 180 requests per minute per client IP, MAX webhook deliveries included. Watch
  for `429` on `/webhooks/max` as traffic grows.
- The agentmemory engine keeps its state in memory and writes it to disk every 500 ms
  (`save_interval_ms` in `infra/agentmemory/engine.yaml`); it does not flush on shutdown, so a
  write acknowledged less than 500 ms before the engine stops (crash, kill or restart) is lost.
  After changing `engine.yaml`, recreate the engine:
  `docker compose up -d --force-recreate memory-engine memory`.
- Turn AI on (`AI_ENABLED=true`, `AI_API_KEY`, `AI_MODEL`) only with a provider that is reachable
  from the host and approved for personal data.
