# create-service Master Plan

This document is the living master plan for `create-service`. It tracks the product vision, locked decisions, current progress, and next work needed to turn the generator into the default foundation for standalone microservices.

## Vision

Create the backend fundamentals so agents and humans can build microservice features quickly after infrastructure, runtime plumbing, and the minimal production lifecycle are already handled.

The product now has one generated profile with explicit deployment targets:

- `microservice`: a production-deployable API/service with a small waitlist/launch SaaS example.
- `--target cloudrun`: Cloud Run service with GCP, Neon, DNS, Grafana, and future Temporal worker support.
- `--target workers`: Cloudflare Workers service with Wrangler, custom domain, Cron Trigger, and future Hyperdrive/Neon provisioning.

Full app workspaces have moved out of `create-service` into private GitHub Template repositories:

- `anmho/create-app-consumer`: consumer app template with per-user subscriptions/paygate.
- `anmho/create-app-saas`: multitenant SaaS template with org/workspace billing, roles, invites, and a generic workspace-checklist demo.

## Current Priority

Perfect the lightweight microservice create flow.

The generated microservice should be standalone by default: scaffold, create, and deploy production without Terraform PRs, control-plane registration, or platform-console setup. Terraform remains an optional way to precreate shared foundations.

## Locked Product Direction

- Only generated target: `microservice`.
- `--profile microservice` is retained as a compatibility no-op.
- `--profile app` fails with guidance to the private app template repositories.
- Non-interactive profile default: `microservice`.
- Local scaffold flow: local-first for runtime dependencies, with provider validation only when the generated service uses that provider.
- Local database: Docker Compose Postgres.
- Remote database: shared Neon instance with one database per generated app.
- Runtime modes: `local`, `preview`, and `prod`.
- Local mode reads `.env.local`, uses Docker Postgres, and uses local defaults.
- Secret Manager is the Cloud Run runtime delivery layer.
- Vault and environment variables are create/deploy input sources.
- Generated `DATABASE_URL` values are deploy outputs written directly to app-project Secret Manager.
- GitHub Actions deploys preview on all non-main branch pushes and prod on `main`.
- Generated microservice example target: waitlist/launch service.
- Webhook ingress: plain HTTP for all variants, with typed internal normalization and dispatch.
- ConnectRPC: typed first-party app/service API where selected; webhooks remain HTTP.
- Temporal is in scope for Cloud Run services; the HTTP service should also host the worker process when selected.

## Current Generated Matrix

- `bun + hono`
- `bun + connectrpc`
- `go + chi`
- `go + connectrpc`

All four variants are still first-class while the baseline is being hardened.

## Implemented Baseline

### Scaffold and Local Dev

- Scaffold no longer requires Neon or Vault credentials for the current service-like local baseline.
- CLI shows visible GCP discovery while preloading provider defaults.
- Generated apps include `docker-compose.yml` for local Postgres.
- Scaffold writes `.env.local` with local `DATABASE_URL`.
- Generated docs and CLI outro show the real local flow: migrate, then dev; generated commands start Docker Compose Postgres as needed.
- Go `make dev` and `make migrate` load `.env.local`.
- Generated migration and dev commands open Docker Desktop when needed, start Docker Compose Postgres, and wait for Postgres to accept connections.
- Repo validation includes `bun run validate:generated` for Docker-backed generated-app matrix checks.

### Core Plumbing Domain

- Postgres-backed `users`.
- Postgres-backed `waitlist_entries`.
- Postgres-backed `waitlist_triggers`.
- Idempotent public waitlist joins.
- Trigger ingestion for scheduled, webhook, and manual follow-up work.
- Hono, Chi, and ConnectRPC variants have been migrated to the waitlist/trigger domain.

### Runtime and Deployment

- Bun variants use Drizzle with Bun SQL.
- Go variants use `sqlx`.
- Generated apps include migration assets.
- Local runtime fails clearly when required runtime config is missing.
- Generated Cloud Run scripts provision remote resources and deployment config.
- Generated remote scripts resolve Neon defaults during `service create` and `service deploy`, not during scaffold.

## Lightweight Integration Model

The production create path keeps integrations minimal by default. Neon is the
only required remote provider for the base waitlist service. Provider-specific
credentials are opt-in and should be read from environment or Vault only after a
generated service adds a provider adapter that actually uses them.

`create-service` reads Neon credentials from Vault when available and falls back
to environment variables for standalone users. Generated runtime database values
are mirrored into app-project Secret Manager for Cloud Run. Terraform is
optional and never required for a generated service's happy path.

## Required Bootstrap Inputs

Minimum strict create input set:

- `NEON_API_KEY`
- `DATABASE_URL` is generated during create/deploy and written directly to app-project Secret Manager.

Provider credentials are optional for the base waitlist service and should only
be required by generated adapters that actually use that provider.

## Provider Adapter Direction

Auth, billing, email, analytics, and entitlement providers are not part of the
base generated service. When a service needs one, add it as a provider adapter
inside that generated repository, with its own secrets, tests, and lifecycle
checks. Consumer and SaaS app tenancy belong in the private app template
repositories.

## Near-Term Hardening

These items finish the current baseline before deeper integration expansion:

- Keep the repo-owned generated-app validation harness green across all four variants.
- Prove remote `service create` and deploy path end to end for all four variants.
- Republish or update `@anmho/authctl` so generated projects install a package
  that exposes `resource-servers upsert`. The current smoke generated a service
  and separately installed `@anmho/authctl@latest`; both resolve to package
  version `0.1.0`. That package proves `service auth doctor` reaches authctl,
  and it exposes `clients`, `doctor`, `version`, and `update`, but
  `authctl resource-servers upsert --json` exits with `unknown command
  'resource-servers'`. Until a newer package includes `resource-servers`,
  `service create` correctly stops before auth resource-server registration.
- Prove remote Neon database creation in the shared Neon instance.
- Keep Secret Manager as the Cloud Run runtime source and improve Vault/env create input handling.
- Add webhook idempotency acceptance tests across all variants.
- Remove remaining sample-domain or DNS artifacts if any remain.
- Clean generated template noise such as checked-in dependency folders if present.

## Build Order

1. Finish current validation harness and remote deploy proof.
2. Harden first-time `service create` across all variants.
3. Harden Workers create/destroy around Cloudflare custom domains, Hyperdrive, and Neon.
4. Harden `service destroy` ownership checks across Cloud Run, Workers, Neon, Temporal, Grafana, and DNS resources.
5. Add resumable hard-failure instructions for provider gaps.
6. Add generated GitHub Actions preview/prod deployment.
7. Keep app workspace generation out of `create-service`; evolve it in `anmho/create-app-consumer` and `anmho/create-app-saas`.

## App Template Repositories

App workspace generation is handled by private GitHub Template repositories, not by this CLI.

Both app templates use Nx + Bun + Next.js + Expo + an embedded API + Temporal worker. They keep their own lifecycle scripts inside the cloned workspace, with provider credentials read from Vault paths defined by the app-platform Terraform provider schema.

`create-service` does not clone, call, or provision those repositories. It only documents their existence and rejects the removed `app` profile with a clear pointer.

## Current Non-Goals

- AI runtime integration.
- Realtime chat.
- SSE/WebSockets.
- Redis queueing.
- Provider-specific business logic or runtime secrets in the base scaffold.
- Mobile or web app generation in the current backend-focused phase.
- Nx workspace generation.

## Future Test Coverage

Future implementation tests should cover:

- Local mode still running from Docker/env defaults.
- Preview/prod resolving runtime database secrets from Vault/env inputs.
- GitHub Actions branch policy for preview and prod.
- Provider adapter smoke tests only after a generated service adds that adapter.
