# create-svc Master Plan

This document is the living master plan for `create-svc`. It tracks the product vision, locked decisions, current progress, and next work needed to turn the generator into the default foundation for serious app backends.

## Vision

Create the perfect backend fundamentals so agents and humans can build product features quickly after infrastructure, styling conventions, runtime plumbing, and common integrations are already handled.

The primary product is an app backend boilerplate. A stripped-down service profile comes later by removing app-specific capabilities from the app backend baseline.

## Current Priority

Perfect the app backend baseline first.

The generated app should include core backend plumbing and the common product integration stack by default: database, secrets, migrations, uploads, webhooks, auth, payments, entitlements, email, analytics, and operations.

## Locked Product Direction

- Primary generated target: app backend.
- Later generated target: service, derived from the app backend by stripping app-specific pieces.
- Profile selection: prompt for `app backend` vs `service`, defaulting to `app backend`.
- Non-interactive profile default: app backend unless a future `--profile service` flag is provided.
- Local scaffold flow: local-first for runtime dependencies, with app-profile secret validation when integration requirements are enabled.
- Local database: Docker Compose Postgres.
- Remote database: shared Neon instance with one database per generated app.
- Runtime modes: `local`, `preview`, and `prod`.
- Local mode reads `.env.local`, uses Docker Postgres, and uses local defaults.
- Preview and prod read sensitive runtime values from Vault, including `DATABASE_URL`.
- Cloud Run runtime Vault auth uses Vault GCP auth with the Cloud Run runtime service account.
- GitHub Actions deploys preview on all non-main branch pushes and prod on `main`.
- Generated backend domain today: chat, attachments, and webhooks as durable plumbing examples.
- Webhook ingress: plain HTTP for all variants, with typed internal normalization and dispatch.
- Attachment storage: direct-to-GCS signed upload plus finalize.
- ConnectRPC: typed first-party app/service API where selected; webhooks remain HTTP.
- Temporal is explicitly deferred until the app backend has enough async flows to justify it.

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

## Vault-Centered Integration Model

The app backend profile requires the core integration stack by default:

- Clerk for auth and identity.
- Stripe as the web billing/payment rail.
- RevenueCat as the entitlement source of truth.
- Resend as the default transactional email provider.
- PostHog for product analytics.
- Neon for remote Postgres provisioning.

Users configure Vault paths once with a future command:

```bash
create-svc config vault
```

The command stores user-level config at:

```bash
~/.config/create-svc/config.json
```

The config uses a named secret map. Generated secret names map to Vault `{ path, field }` entries so generated apps stay deterministic while users can choose their own Vault layout.

The app-profile scaffold validates required Vault paths and fields before generation. Missing values fail with a concrete checklist of secret names, paths, and fields to add.

`create-svc` is read-only for Vault. If provisioning creates a new secret value, such as a production `DATABASE_URL`, the tool prints the exact operator Vault write step and validates after the operator stores it.

## Required App-Profile Secrets

Minimum app-profile Vault validation set:

- `NEON_API_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_WEBHOOK_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `REVENUECAT_API_KEY`
- `REVENUECAT_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `POSTHOG_API_KEY`
- `DATABASE_URL` for preview/prod after operator Vault write

## Identity, Auth, and RBAC

Clerk user ID is the canonical user identifier across:

- Postgres `users.id`
- RevenueCat App User ID
- PostHog `distinct_id`
- Stripe customer/subscription mappings
- Resend workflows

The app backend should include local users plus organizations from the start. RBAC should build on that user/organization model rather than retrofitting tenancy later.

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

These items finish the current baseline before integration expansion:

- Keep the repo-owned generated-app validation harness green across all four variants.
- Prove remote `bootstrap` and deploy path end to end for all four variants.
- Prove remote Neon database creation in the shared Neon instance.
- Rework remote runtime secrets so preview/prod read from Vault instead of relying on Secret Manager as the runtime source.
- Prove GCS attachment upload and finalize against real cloud storage.
- Add local fake or emulator-backed attachment tests where practical.
- Add webhook idempotency acceptance tests across all variants.
- Remove remaining sample-domain or DNS artifacts if any remain.
- Clean generated template noise such as checked-in dependency folders if present.

## Build Order

1. Finish current validation harness and remote deploy proof.
2. Add `create-svc config vault` and app-profile Vault validation.
3. Add Clerk auth/RBAC with users plus organizations.
4. Add `dev:login`, `dev:prod`, and local-only `dev:no-auth`.
5. Add RevenueCat/Stripe entitlement and webhook plumbing.
6. Add Resend email plumbing.
7. Add PostHog domain event adapter.
8. Add GitHub Actions preview/prod deployment.
9. Extract stripped-down service profile.
10. Defer Temporal until the app backend has enough async flows to justify it.

## Future Template System

The long-term template system should become more general than a single backend package.

Target direction:

- Nx repo as the full application workspace.
- Multi-language support.
- Backend service packages.
- Web app packages.
- Mobile app packages.
- Shared contracts and generated clients.
- App backend profile as the default product backend.
- Service profile as a smaller backend for general APIs and internal services.

Open design point:

- Whether `create-svc` remains the backend generator and a future generator owns the Nx workspace, or whether `create-svc` evolves into the top-level app workspace generator.

## Current Non-Goals

- AI runtime integration.
- Realtime chat.
- SSE/WebSockets.
- Redis queueing.
- Provider-specific business logic beyond core integration plumbing.
- Mobile or web app generation in the current backend-focused phase.
- Temporal in the first app-backend integration pass.

## Future Test Coverage

Future implementation tests should cover:

- Vault config file loading and missing-config checklist.
- App-profile scaffold blocking on missing required Vault fields.
- Local mode still running from Docker/env defaults.
- `dev:login` creating or reusing a Clerk user, syncing local `users`, and printing a token.
- `dev:no-auth` refusing outside `APP_ENV=local`.
- Preview/prod resolving runtime secrets from Vault.
- GitHub Actions branch policy for preview and prod.
- RevenueCat entitlement checks using Clerk user IDs.
- Stripe and RevenueCat webhook idempotency.
- Resend email adapter smoke path.
- PostHog domain event adapter behavior.
