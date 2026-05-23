# create-service

`create-service` is a local microservice bootstrap CLI for generating standalone API services with:

- a single `microservice` generation path
- explicit deploy target selection: Cloud Run or Cloudflare Workers
- Go or Bun runtime choices where the target supports them
- HTTP frameworks (`chi` or `hono`) and ConnectRPC variants
- standalone package output that does not assume repo bootstrap
- a generated `service.config.ts` manifest
- a generated `service` lifecycle CLI for create, deploy, migrate, seed, dashboards, doctor, and destroy
- local Docker Compose Postgres for first-run development
- Neon-backed remote environments
- a production API origin at `https://api.<service_id>.anmho.com`

Local provisioning intentionally prefers known-good CLIs over SDK-heavy orchestration where that keeps the generated service easier to inspect and repair.

npm: <https://www.npmjs.com/package/create-svc>

## Usage

```bash
bun create svc my-service
```

Compatibility alias:

```bash
bun create svc my-service
```

or:

```bash
bunx create-svc my-service
```

For the strict one-command production path:

```bash
bun create svc my-service --yes
```

`--profile microservice` is accepted as a compatibility no-op. App workspaces live outside this package in private app template repositories.

By default, a standalone generated service is initialized as a git repository,
committed with `Initial commit`, created as a private GitHub repository at
`anmho/<service-name>`, and pushed to `origin/main`. If the target directory is
inside an existing git worktree, create-service skips git and GitHub setup so the
parent repository remains in control. Pass `--no-git` to skip all git and GitHub
side effects.

## Local Testing

Without publishing to npm:

```bash
bun install
npm pack
bunx ./create-svc-*.tgz my-service
```

For faster iteration against your working tree:

```bash
bun link
bun link create-service
create-service my-service
```

During scaffold, the generator can discover:

- accessible GCP projects
- open billing accounts

Generated provisioning commands use Neon credentials from `NEON_API_KEY`, or Vault via `VAULT_ADDR` plus `VAULT_TOKEN`, `VAULT_TOKEN_FILE`, or `~/.vault-token`.
The base waitlist service keeps provider integrations out of the runtime by default; add provider-specific secrets only when the generated service actually uses that provider.

Before running generated provisioning commands locally, authenticate `gcloud` on the machine:

```bash
gcloud auth login
```

## Generated Service Package

First local run:

`bun run migrate`, `make migrate`, `bun run dev`, and `make dev` open Docker Desktop when needed, wait for Docker readiness, and start Docker Compose Postgres before touching the local database.

For Bun variants:

```bash
bun run migrate
bun run dev
bun run gen
bun run lint
bun run test
bun run create
bun run deploy
bun run destroy
```

For Go variants:

```bash
make migrate
make dev
make gen
make lint
make test
make create
make deploy
make destroy
```

Language-specific tasks such as local running, linting, formatting, testing, and building stay in package scripts or Make targets. Service lifecycle operations are exposed through the generated `service` CLI.

The generated service is intended to be consumed by a web app, mobile client, or another service over HTTPS. In v1, production is expected to live at `https://api.<service_id>.anmho.com`, while preview and personal environments keep using deterministic platform URLs where appropriate.

The generated microservice domain is a small waitlist/launch service example with public submit/status APIs and target-specific scheduled work.

## Development

```bash
bun install
bun test src scripts
bun run index.ts my-service
```

Validate the generated app matrix against local Docker Compose Postgres:

```bash
bun run validate:generated
bun run validate:generated -- --variant bun-hono
bun run validate:generated -- --variant go-connectrpc --keep
```

The validation harness scaffolds generated services into ignored `bin/generated/run-*` workspaces, runs the generated public commands, starts the local server, and smoke-tests health or typed ConnectRPC clients where applicable.

## npm Trusted Publishing

`create-service` is set up for npm trusted publishing from GitHub Actions, so there is no long-lived npm publish token to store in Vault.

Repository workflow:

- [publish.yml](.github/workflows/publish.yml)
- Trigger: pushes to `main`, Git tags matching `v*`, or manual `workflow_dispatch`
- CI runtime: Bun for install/test/typecheck, npm for the final publish step

npm package setup still has to be configured once in the npm UI to trust this repository and workflow:

1. Open the `create-service` package settings on npm.
2. Go to `Settings` -> `Trusted Publisher`.
3. Select `GitHub Actions`.
4. Enter:
   - Organization or user: `anmho`
   - Repository: `create-service`
   - Workflow filename: `publish.yml`
5. Save the trusted publisher.

After that, publishing can be triggered by pushing to `main`, creating a `v*` tag, or running the workflow manually.

The GitHub Actions workflow authenticates with npm via OIDC and runs `npm publish` without an npm token.
