# {{SERVICE_NAME}}

We want the functionality of a proto-first, versioned, generated-SDK API stack, but Expo and React Native are not the right place to bet on richer RPC transports at the public client edge. This app keeps protobuf as the contract source of truth, uses Protobuf-ES generated models in web and mobile, exposes boring HTTP JSON to app clients, and leaves Connect available inside the API for server-to-server use.

## Go button

```bash
bun run go
```

The go-button installs workspace dependencies, starts local Postgres, generates shared protobuf TypeScript, runs API migrations, starts the Bun ConnectRPC API on `8080`, starts Next.js on `3000`, boots an iOS Simulator, and opens Expo Go on `8081`.

## Layout

- `apps/api` - Bun API for the chat domain with HTTP JSON app routes and ConnectRPC internals.
- `apps/web` - Next.js App Router web app using Tailwind and shadcn/ui over HTTP JSON.
- `apps/mobile` - Expo app using native React Native primitives, `StyleSheet`, and plain HTTP JSON.
- `packages/api-client` - shared Protobuf-ES descriptors and HTTP JSON client helpers.
- `packages/tokens` - shared color, spacing, and radius tokens.
- `protos` - workspace-level protobuf source of truth.

## Mobile API URL

iOS Simulator shares the host network, so the generated mobile app defaults to:

```bash
EXPO_PUBLIC_API_URL=http://localhost:8080
```

Android Emulator should use:

```bash
EXPO_PUBLIC_API_URL=http://10.0.2.2:8080
```

Expo Go is the default path. Development builds are still compatible if the app later adds native modules that Expo Go does not include.
