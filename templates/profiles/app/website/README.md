# {{SERVICE_NAME}} download website

This is the app profile download website. Its only job is app deep link bootstrap:

1. Try to open the installed mobile app.
2. Fall back to the iOS or Android store link when configured.
3. Show visible download links when the platform is unknown or a store URL is still missing.

It is not an admin console, account center, billing portal, or full web app.

## Configuration

Set these values after scaffold. Store URLs can stay empty until the apps are published.

```sh
NEXT_PUBLIC_APP_DEEP_LINK={{APP_DEEP_LINK}}
NEXT_PUBLIC_IOS_STORE_URL={{IOS_STORE_URL}}
NEXT_PUBLIC_ANDROID_STORE_URL={{ANDROID_STORE_URL}}
```

## Development

```sh
bun install
bun run dev
```

Run the website checks with:

```sh
bun test
bun run typecheck
```
