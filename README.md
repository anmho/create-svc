# create-svc

`create-svc` is a Bun-authored scaffold CLI for generating a Go Cloud Run service with:

- Chi HTTP routes
- ConnectRPC handlers
- a real Cloud Run service manifest
- Bun-based deployment helpers
- Vault-backed Cloudflare DNS CRUD as the default example

## Usage

```bash
bun install
bun run index.ts my-service
```

The generated service supports:

```bash
bun dev
bun gen
bun lint
bun test
bun deploy
```

## Development

```bash
bun test src
```
