# create-svc Master Plan

This document is the living master plan for `create-svc`. It tracks the product vision, locked decisions, current progress, and next work needed to turn the generator into the default foundation for standalone microservices.

## Vision

Create the perfect backend fundamentals so agents and humans can build microservice features quickly after infrastructure, runtime plumbing, and common integrations are already handled.

The product now has one generated target:

- `microservice`: a production-deployable API/service with a small waitlist/launch SaaS example and strict integration bootstrap.

Full app workspaces have moved out of `create-svc` into private GitHub Template repositories:

- `anmho/create-app-consumer`: consumer app template with per-user subscriptions/paygate.
- `anmho/create-app-saas`: multitenant SaaS template with org/workspace billing, roles, invites, and a generic workspace-checklist demo.

## Current Priority

Perfect the lightweight microservice bootstrap.

The generated microservice should be standalone by default: scaffold, bootstrap, and deploy production without Terraform PRs, control-plane registration, or platform-console setup. Terraform remains an optional way to precreate shared foundations.

## Locked Product Direction

- Only generated target: `microservice`.
- `--profile microservice` is retained as a compatibility no-op.
- `--profile app` fails with guidance to the private app template repositories.
- Non-interactive profile default: `microservice`.
- Local scaffold flow: local-first for runtime dependencies, with strict provider/bootstrap validation only when production bootstrap is requested.
- Local database: Docker Compose Postgres.
- Remote database: shared Neon instance with one database per generated app.
- Runtime modes: `local`, `preview`, and `prod`.
- Local mode reads `.env.local`, uses Docker Postgres, and uses local defaults.
- Secret Manager is the Cloud Run runtime delivery layer.
- Vault and environment variables are bootstrap input sources.
- Generated `DATABASE_URL` values are deploy outputs written directly to app-project Secret Manager.
- GitHub Actions deploys preview on all non-main branch pushes and prod on `main`.
- Generated microservice example target: waitlist/launch service.
- Webhook ingress: plain HTTP for all variants, with typed internal normalization and dispatch.
- Attachment storage: direct-to-GCS signed upload plus finalize.
- ConnectRPC: typed first-party app/service API where selected; webhooks remain HTTP.
- Temporal is out of scope for `create-svc`; it belongs in the app template repositories.

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
- Scaffold writes `.env.local` with local `DATABASE_URL`, `ATTACHMENT_BUCKET`, and `ATTACHMENT_PUBLIC_BASE_URL`.
- Generated docs and CLI outro show the real local flow: `docker compose up -d`, migrate, then dev.
- Go `make dev` and `make migrate` load `.env.local`.
- Generated migration commands wait briefly for Postgres to accept connections.
- Repo validation includes `bun run validate:generated` for Docker-backed generated-app matrix checks.

### Core Plumbing Domain

- Postgres-backed `users`.
- Postgres-backed `conversations`.
- Postgres-backed `conversation_participants`.
- Postgres-backed `messages`.
- Postgres-backed `attachments`.
- Postgres-backed `webhook_events`.
- Soft delete for conversations, messages, and attachments.
- Image-only attachment validation in v1.
- Generic webhook ingestion with idempotency.
- Cursor-paginated transcript reads, newest-first.
- Message reads include lightweight attachment metadata.

### Runtime and Deployment

- Bun variants use Drizzle with Bun SQL.
- Go variants use `sqlx`.
- Generated apps include migration assets.
- Local runtime fails clearly when required runtime config is missing.
- Generated Cloud Run scripts provision remote resources and deployment config.
- Generated remote scripts resolve Neon defaults during `bootstrap` and `deploy`, not during scaffold.

## Lightweight Integration Model

The strict production bootstrap path requires the core integration stack by default:

- Clerk for auth and identity.
- Stripe as the web billing/payment rail.
- RevenueCat as the entitlement source of truth.
- Resend as the default transactional email provider.
- PostHog for product analytics.
- Neon for remote Postgres provisioning.

Users can configure Vault paths once with a future command:

```bash
create-svc config vault
```

The command stores user-level config at:

```bash
~/.config/create-svc/config.json
```

The config uses a named secret map. Generated secret names map to Vault `{ path, field }` entries so generated apps stay deterministic while users can choose their own Vault layout.

The app template repositories validate required Vault paths and fields before provider mutation. Missing values fail with a concrete checklist of secret names, paths, and fields to add.

`create-svc` reads Vault when available and falls back to environment variables for standalone users. Generated runtime values are mirrored into app-project Secret Manager for Cloud Run. Terraform is optional and never required for a generated app's happy path.

## Required Bootstrap Inputs

Minimum strict-bootstrap input set:

- `NEON_API_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_WEBHOOK_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `REVENUECAT_API_KEY`
- `REVENUECAT_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `POSTHOG_API_KEY`
- `DATABASE_URL` is generated during deploy and written directly to app-project Secret Manager.

## Identity, Auth, and RBAC

Clerk user ID is the canonical user identifier across:

- Postgres `users.id`
- RevenueCat App User ID
- PostHog `distinct_id`
- Stripe customer/subscription mappings
- Resend workflows

The microservice profile uses mixed auth: public submit and provider webhook endpoints, plus Clerk-protected admin APIs. Consumer and SaaS app tenancy belong in the private app template repositories.

Generated apps should include project-owned Clerk helper scripts. These helpers use the Clerk Backend API or SDK; they do not rely on a Clerk CLI login command.

Generated auth commands:

- Bun: `bun run dev`, `bun run dev:prod`, `bun run dev:no-auth`, `bun run dev:login -- <email>`
- Go: `make dev`, `make dev-prod`, `make dev-no-auth`, `make dev-login USER=<email>`

Auth command behavior:

- `dev` runs locally with Clerk verification enabled once auth is implemented.
- `dev:prod` runs the server locally against production dependencies by reading Vault.
- `dev:no-auth` is a local-only escape hatch and must refuse to run unless `APP_ENV=local`.
- `dev:login` accepts an email address, finds or creates the Clerk dev user, creates or reuses a Clerk session, mints a Clerk-default session token, upserts local Postgres `users.id = clerk_user_id`, and prints only the bearer token to stdout.

The `dev:login` helper is a Bun/TypeScript script for every generated variant, including Go variants. Generated Go apps already include Bun/package tooling for Cloud Run scripts, so this keeps developer tooling consistent.

## Payments, Entitlements, Email, and Analytics

RevenueCat is the source of truth for entitlements. Stripe handles web billing and payment rails, and Stripe events should feed RevenueCat and local webhook audit state as needed.

The generated backend should persist provider webhook events locally for idempotency and debugging, but product authorization should use the RevenueCat-normalized entitlement view rather than raw Stripe state.

Resend is the default email provider. SendGrid can be added later as an adapter if needed.

PostHog events should flow through a typed domain event layer. Domain services emit typed events, and a PostHog adapter records them when configured, keeping analytics concerns out of transport handlers.

## Near-Term Hardening

These items finish the current baseline before deeper integration expansion:

- Keep the repo-owned generated-app validation harness green across all four variants.
- Prove remote `bootstrap` and deploy path end to end for all four variants.
- Prove remote Neon database creation in the shared Neon instance.
- Keep Secret Manager as the Cloud Run runtime source and improve Vault/env bootstrap input handling.
- Prove GCS attachment upload and finalize against real cloud storage.
- Add local fake or emulator-backed attachment tests where practical.
- Add webhook idempotency acceptance tests across all variants.
- Remove remaining sample-domain or DNS artifacts if any remain.
- Clean generated template noise such as checked-in dependency folders if present.

## Build Order

1. Finish current validation harness and remote deploy proof.
2. Harden strict microservice bootstrap across all four variants.
3. Replace the remaining chat-shaped sample with the waitlist/launch service model.
4. Add provider resource automation for Clerk, Stripe, RevenueCat, Resend, and PostHog where APIs support it.
5. Add resumable hard-failure instructions for provider gaps.
6. Add auth boundaries, entitlement checks, email adapter, analytics adapter, and webhook idempotency tests.
7. Add generated GitHub Actions preview/prod deployment.
8. Keep app workspace generation out of `create-svc`; evolve it in `anmho/create-app-consumer` and `anmho/create-app-saas`.

## App Template Repositories

App workspace generation is handled by private GitHub Template repositories, not by this CLI.

Both app templates use Nx + Bun + Next.js + Expo + an embedded API + Temporal worker. They keep `bun run bootstrap`, `bun run provision`, and `bun run dev` inside the cloned workspace, with provider credentials read from Vault paths defined by the app-platform Terraform provider schema.

`create-svc` does not clone, call, or provision those repositories. It only documents their existence and rejects the removed `app` profile with a clear pointer.

## Current Non-Goals

- AI runtime integration.
- Realtime chat.
- SSE/WebSockets.
- Redis queueing.
- Provider-specific business logic beyond core integration plumbing.
- Mobile or web app generation in the current backend-focused phase.
- Temporal.
- Nx workspace generation.

## Future Test Coverage

Future implementation tests should cover:

- Vault config file loading and missing-config checklist.
- App-template provision dry-run blocking on missing required Vault fields.
- Local mode still running from Docker/env defaults.
- `dev:login` creating or reusing a Clerk user, syncing local `users`, and printing a token.
- `dev:no-auth` refusing outside `APP_ENV=local`.
- Preview/prod resolving runtime secrets from Vault.
- GitHub Actions branch policy for preview and prod.
- RevenueCat entitlement checks using Clerk user IDs.
- Stripe and RevenueCat webhook idempotency.
- Resend email adapter smoke path.
- PostHog domain event adapter behavior.
