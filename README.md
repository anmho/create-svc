# create-svc

`create-svc` is a Bun-authored scaffold CLI for generating Cloud Run services with:

- `go + chi`
- `go + connectrpc`
- `bun + hono`
- `bun + connectrpc`
- a real `service.yaml` manifest
- shared Cloud Run bootstrap, deploy, and cleanup automation
- Neon-backed main, preview, and personal environments

## Usage

```bash
bun install
bun run index.ts my-service
```

The generator discovers:

- accessible GCP projects
- open billing accounts
- Neon defaults from `NEON_API_KEY`, or Vault via `VAULT_ADDR` plus `VAULT_TOKEN`, `VAULT_TOKEN_FILE`, or `~/.vault-token`

Generated repos are `Makefile`-first. The shared Cloud Run control plane is exposed as a local CLI bin and invoked by `make`.

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
bun test src
```
