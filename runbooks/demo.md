# Demo stand for judges

A second copy of the stack on the production host, for hackathon judges. It runs the same
images as production with its own `.env`, database, files, agentmemory and AI key, and differs
only in configuration:

|                 | Production (`/opt/max-support`) | Demo (`/opt/max-support-demo`)                                   |
| --------------- | ------------------------------- | ---------------------------------------------------------------- |
| Domain          | `DOMAIN`                        | `demo.<DOMAIN>`                                                  |
| Bots            | client bot + staff bot          | one bot issued by the organizers: client chat and staff mini-app |
| Staff access    | added by an administrator       | `/code <CODE>` in the bot chat                                   |
| Compose project | `max-support`                   | `max-support-demo` (`compose.demo.yaml`)                         |

The production Caddy serves both domains. It joins the `max-support-edge` network, where the
demo `api` and `mini-app` containers are reachable by container name; `deploy/sites/demo.caddy`
routes `DEMO_DOMAIN` to them. Without `DEMO_DOMAIN` that site answers only
`http://demo.localhost`, so it is inert.

## Role codes

`DEMO_ROLE_CODES=support:CODE,supervisor:CODE,admin:CODE` turns the feature on. Codes are 12–64
letters, digits or dashes, case-insensitive; the server refuses to start with a malformed list.
Generate them with:

```sh
for role in support supervisor admin; do printf '%s:%s,' $role "$(openssl rand -hex 8 | tr a-f A-F)"; done
```

When a MAX user sends `/code <CODE>` to the bot, the API handles it before the inbox, so the
message never becomes a client message, a ticket or an AI request:

- no employee with that MAX id: one is created with the code's role and the sender's name,
  pending until the first mini-app login;
- an existing employee gets the new role; their sessions are revoked, so the app asks them to
  reopen it;
- a blocked employee stays blocked and gets no role;
- a wrong code gets a reply and nothing else.

Every change is in the audit log as `employee.demo_role`. The same MAX account stays a client of
the bot, so a judge can write to the bot and answer their own ticket from the app.

## First setup

1. DNS: an `A` record `demo.<DOMAIN>` pointing at the host (Cloudflare: DNS only).
2. Production: deploy a server checkout that has this runbook (`git pull`, then
   `docker compose up -d caddy` in `/opt/max-support/deploy`), put `DEMO_DOMAIN=demo.<DOMAIN>`
   into its `.env`, and run `docker compose up -d caddy` again.
3. Demo checkout and settings:

   ```sh
   git clone <server repository> /opt/max-support-demo
   cd /opt/max-support-demo/deploy
   sh init-env.sh
   nano .env
   ```

   Set in `.env`:

   ```sh
   COMPOSE_FILE=compose.yaml:compose.demo.yaml
   DOMAIN=demo.<DOMAIN>
   SERVER_IMAGE=, SERVER_TAG=, MINI_APP_IMAGE=, MINI_APP_TAG=   # same as production
   MAX_BOT_TOKEN=               # the organizers' bot
   MAX_STAFF_BOT_TOKEN=         # empty
   MAX_STAFF_WEBHOOK_SECRET=    # empty, or the server refuses to start
   DEMO_ROLE_CODES=support:…,supervisor:…,admin:…
   AI_ENABLED=true, AI_API_URL=, AI_MODEL=, AI_API_KEY=   # its own key
   MEMORY_ENABLED=true
   POLICY_VERSION=, POLICY_URL=, BOOTSTRAP_MAX_USER_ID=
   ```

4. Start it like a new install:

   ```sh
   docker compose up -d postgres redis s3 clamav memory-engine memory
   docker compose run --rm api node dist/cli.js storage-init
   docker compose run --rm api node dist/cli.js migrate
   docker compose run --rm api node dist/cli.js bootstrap
   docker compose up -d
   docker compose run --rm api node dist/cli.js subscribe
   ./memory-check.sh
   ```

5. Send the bot `/code <support code>` and a question, check that the ticket arrives, then give
   the organizers `https://demo.<DOMAIN>/` as the mini-app URL. After they bind it, open the app
   from the bot and try all three codes from one account.

## Releases

Build each image once on the host and roll it to both stacks:

```sh
cd /opt/max-support && git pull --ff-only
tag=$(git rev-parse --short HEAD)
docker build --build-arg APP_VERSION=$tag -t ghcr.io/<owner>/max-support-server:$tag .
./deploy/deploy-all.sh server $tag
```

`deploy-all.sh` deploys production, then pulls the demo checkout and deploys the same tag there
(skipped when `/opt/max-support-demo/deploy/.env` does not exist). The mini-app works the same
way with `mini-app` and its image.

AI rules (`agent-skills/`) ship inside the server image, so they reach both stacks with the
release. Templates, dictionaries, employees and organization settings live in each database:
change them in each app, or in `seed.ts` / a migration to reach both.

## Reset

Wipes judges' data and starts over:

```sh
cd /opt/max-support-demo/deploy
docker compose down -v
```

Then repeat step 4.

## Removal

1. On the host: `docker compose down -v` in `/opt/max-support-demo/deploy`, delete
   `/opt/max-support-demo`, remove `DEMO_DOMAIN` from the production `.env`.
2. In the repository: delete `src/modules/demo-access/`, `tests/demo-access.test.ts`,
   `deploy/compose.demo.yaml`, `deploy/sites/demo.caddy`, `deploy/deploy-all.sh` and this
   runbook; remove `DEMO_ROLE_CODES` from `src/shared/config.ts`, the hook block from
   `src/app/http/build-api.ts`, `demo-access` from `eslint.config.js` and `ARCHITECTURE.md`,
   and the `DEMO_DOMAIN` line from `deploy/compose.yaml`.
3. Deploy production, then `docker compose up -d caddy`.
