# Server architecture

A modular monolith: one codebase, three process roles (`api`, `worker`, `gateway`), and
feature modules with explicit, lint-enforced dependencies.

## Layout

```
src/
  main.ts, cli.ts     Entry points only: pick a process role / an operator command.
  app/                Composition roots. Wire modules together; no business rules.
    http/             buildApi: plugins, strict JSON parser, error handler, hooks, route plugins
    workers/          job runner, failure policy, scheduler, poll loop, maintenance
    gateway/          the AI gateway process (the only holder of the provider key)
    cli/              one file per operator command
    bootstrap/        seed data
  modules/<name>/     Feature slices. Public API = index.ts, nothing else.
  integrations/max/   MAX Bot API client, keyboards, webhook normalization.
  shared/             Infrastructure used everywhere: config, db, crypto, json, events,
                      http request helpers, entity types. No feature logic.
```

## Module dependencies

Every edge points down a layer, so the graph has no cycles. The table is enforced by
`eslint-plugin-boundaries` (`MODULE_DEPENDENCIES` in `eslint.config.js`); adding an edge is an
architectural decision and happens there.

| Module        | May import (besides `shared` and `integrations`)  |
| ------------- | ------------------------------------------------- |
| templates     | –                                                 |
| learning      | –                                                 |
| dictionaries  | –                                                 |
| staff         | –                                                 |
| files         | –                                                 |
| messages      | learning                                          |
| outbox        | templates, messages                               |
| ratings       | outbox                                            |
| consent       | outbox, learning                                  |
| tickets       | messages, outbox, ratings, learning, dictionaries |
| inbox         | consent, tickets, messages, outbox                |
| delivery      | files                                             |
| notifications | staff                                             |
| admin         | templates, dictionaries                           |
| ai            | dictionaries                                      |

`app/` may import any module (through its `index.ts`). `shared/` imports only `shared/`.

Raw SQL still crosses table ownership in a few places (consent withdrawal closes tickets,
ratings update tickets, maintenance touches jobs and permits). That is deliberate: those
writes happen in the same transaction as the change that causes them.

## What goes where

- **A new endpoint**: a route in the owning module's `*.routes.ts` plugin, registered in
  `app/http/build-api.ts`. Route handlers only read the request (`shared/http/request.ts`)
  and call the module; SQL stays in the module.
- **A new background job kind**: a case in `app/workers/job-runner.ts` that calls a module,
  a queue in `app/workers/queues.ts` if it needs its own concurrency, and its failure codes in
  `job-failure.ts` if they are not ordinary retries.
- **A write that must commit with a domain change** (audit entry, UI event, job): call
  `audit` / `emit` / `enqueue` from `shared/events.ts` with the caller's transaction.
- **Code another module needs**: export it from the owning module's `index.ts`. If that
  creates a new edge, add it to `MODULE_DEPENDENCIES` (and this table) first.
- **A schema change**: a new `migrations/NNN_name.sql` with the next number. `migrate` applies
  every pending file in order inside one transaction; a released migration is never edited.
  Keep changes additive so the previous image still runs against the new schema (rollback).
- **Production topology**: `Dockerfile` builds one image for all three roles; `deploy/` holds
  the compose file, Caddy config and scripts; `runbooks/` says how to use them.

## Conventions

- Services are classes constructed with `(db, config)`. Transaction-scoped helpers are
  functions `fn(tx, ctx, args)`, where `ctx = { org, config }` (`shared/context.ts`).
- More than four parameters: pass an object.
- Files are kebab-case; route plugins are `<name>.routes.ts`; no default exports.
- Inside a module, import siblings directly; from outside, only `index.ts`.
- `db.tx` retries serialization failures, so no network calls inside a transaction. Lock
  order is client → ticket → closure everywhere.
- `requireOne` for rows that must exist (returned by an earlier step or by `RETURNING`);
  `one` when absence is a normal outcome.

## Guardrails

`npm run check` runs Prettier, ESLint, `tsc`, knip, the tests and the build; CI runs the same,
plus the PostgreSQL integration tests. ESLint enforces the readability budget (file ≤ 250
lines, function ≤ 60 lines, complexity ≤ 12, nesting ≤ 3, ≤ 4 parameters, line ≤ 120), import
hygiene, and the module boundaries above: a file outside the layout, a deep import into
another module, or an edge not in the table fails the lint.
