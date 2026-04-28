# create-svc

`create-svc` is a local backend bootstrap CLI for generating Cloud Run API services with:

- a Bun-first backend path built around `hono` and Connect-style RPC endpoints
- standalone package output that does not assume repo bootstrap
- compatibility with future monorepo use in layouts like `apps/<service>`
- a real `service.yaml` manifest
- shared Cloud Run bootstrap, deploy, and cleanup automation
- Neon-backed main, preview, and personal environments
- a production API origin at `https://api.<appname>.anmho.com`

Local provisioning intentionally prefers known-good CLIs, especially `gcloud`, over SDK-heavy orchestration for Google Cloud operations.

npm: <https://www.npmjs.com/package/create-svc>

## Planned Platform Observability

The v1 Google observability design is captured in [docs/observability-google-v1.md](docs/observability-google-v1.md). It locks the runtime contract, generated CLI/config surface, Grafana-on-Cloud-Run architecture, and phased rollout without changing executable behavior yet.

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

The generator discovers:

- accessible GCP projects
- open billing accounts
- Neon defaults from `NEON_API_KEY`, or Vault via `VAULT_ADDR` plus `VAULT_TOKEN`, `VAULT_TOKEN_FILE`, or `~/.vault-token`

Before running generated provisioning commands locally, authenticate `gcloud` on the machine:

```bash
gcloud auth login
```

## Generated Backend Package

```bash
make dev
make gen
make lint
make test
make bootstrap
make deploy
make cleanup
```

The generated package is intended to be consumed by a Next.js web app or a mobile client over HTTPS. In v1, production is expected to live at `https://api.<appname>.anmho.com`, while preview and personal environments keep using deterministic Cloud Run URLs.

## Development

```bash
bun install
bun test src
bun run index.ts my-service
```

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
