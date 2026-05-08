# create-svc

`create-svc` is a local backend bootstrap CLI for generating Cloud Run API services with:

- a Bun-first backend path built around `hono` and ConnectRPC
- standalone package output that does not assume repo bootstrap
- compatibility with future monorepo use in layouts like `apps/<service>`
- a real `service.yaml` manifest
- shared Cloud Run bootstrap, deploy, and cleanup automation
- local Docker Compose Postgres for first-run development
- Neon-backed remote main, preview, and personal environments
- GCS-backed image attachments
- typed HTTP webhook ingress
- a production API origin at `https://api.<appname>.anmho.com`

Local provisioning intentionally prefers known-good CLIs, especially `gcloud`, over SDK-heavy orchestration for Google Cloud operations.

npm: <https://www.npmjs.com/package/create-svc>

## Usage

```bash
bun create svc my-service
```

or:

```bash
bunx create-svc my-service
```

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
bun link create-svc
create-svc my-service
```

During scaffold, the generator can discover:

- accessible GCP projects
- open billing accounts

Remote `bootstrap` and `deploy` use Neon credentials from `NEON_API_KEY`, or Vault via `VAULT_ADDR` plus `VAULT_TOKEN`, `VAULT_TOKEN_FILE`, or `~/.vault-token`.

Before running generated provisioning commands locally, authenticate `gcloud` on the machine:

```bash
gcloud auth login
```

## Generated Backend Package

First local run:

```bash
docker compose up -d
```

For Bun variants:

```bash
bun run migrate
bun run dev
bun run gen
bun run lint
bun run test
bun run bootstrap
bun run deploy
bun run cleanup
```

For Go variants:

```bash
make migrate
make dev
make gen
make lint
make test
make bootstrap
make deploy
make cleanup
```

The generated package is intended to be consumed by a Next.js web app or a mobile client over HTTPS. In v1, production is expected to live at `https://api.<appname>.anmho.com`, while preview and personal environments keep using deterministic Cloud Run URLs.

The current boilerplate domain is a simple chat backend with:

- Postgres-backed `users`, `conversations`, `conversation_participants`, and `messages`
- image attachment upload/finalize plumbing via GCS
- generic typed webhook ingestion on plain HTTP

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

The validation harness scaffolds generated apps into ignored `bin/generated/run-*` workspaces, runs the generated public commands, starts the local server, and smoke-tests health or typed ConnectRPC clients where applicable.

## npm Trusted Publishing

`create-svc` is set up for npm trusted publishing from GitHub Actions, so there is no long-lived npm publish token to store in Vault.

Repository workflow:
- [publish.yml](.github/workflows/publish.yml)
- Trigger: Git tags matching `v*`
- CI runtime: Bun for install/test/typecheck, npm for the final publish step

npm package setup still has to be configured once in the npm UI to trust this repository and workflow:

1. Open the `create-svc` package settings on npm.
2. Go to `Settings` -> `Trusted Publisher`.
3. Select `GitHub Actions`.
4. Enter:
   - Organization or user: `anmho`
   - Repository: `create-svc`
   - Workflow filename: `publish.yml`
5. Save the trusted publisher.

After that, publishing is:

```bash
git tag v0.1.10
git push origin v0.1.10
```

The GitHub Actions workflow will authenticate with npm via OIDC and run `npm publish` without an npm token.
