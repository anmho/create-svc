# create-svc

`create-svc` is a scaffold CLI for generating Cloud Run services with:

- `go + chi`
- `go + connectrpc`
- `bun + hono`
- `bun + connectrpc`
- a real `service.yaml` manifest
- shared Cloud Run bootstrap, deploy, and cleanup automation
- Neon-backed main, preview, and personal environments

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

The generator discovers:

- accessible GCP projects
- open billing accounts
- Neon defaults from `NEON_API_KEY`, or Vault via `VAULT_ADDR` plus `VAULT_TOKEN`, `VAULT_TOKEN_FILE`, or `~/.vault-token`

## Generated Repo

```bash
make dev
make gen
make lint
make test
make bootstrap
make deploy
make cleanup
```

## Development

```bash
bun install
bun test src
bun run index.ts my-service
```
