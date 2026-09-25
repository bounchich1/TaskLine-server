# MAX support server

Fastify API, MAX bot, PostgreSQL domain, background workers, AI gateway and agentmemory adapter.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the code layout and its rules.

## Local development

```sh
npm install
npm run env:init          # writes .env with generated local secrets
docker compose up -d postgres redis
npm run db:migrate
npm run dev:all           # api + worker + gateway in one process (mock MAX and AI)
```

Process roles: `npm run dev` (api), `npm run worker`, `npm run gateway`.

## Checks

```sh
npm run check             # format, lint, typecheck, knip, tests, build
RUN_POSTGRES_TESTS=1 npm run test:integration   # needs the compose PostgreSQL
```

## Schema changes

Add `migrations/NNN_name.sql` with the next number; `npm run db:migrate` applies every pending
file in order. Never edit a migration that has been released.

## Deployment

`Dockerfile` builds one image for the `api`, `worker` and `gateway` roles; `deploy/` holds the
production compose file, Caddy config and scripts. Pushing a `v*` tag builds and publishes the
image and, when configured, deploys it. See [runbooks/deploy.md](runbooks/deploy.md) and
[runbooks/release-gates.md](runbooks/release-gates.md).
