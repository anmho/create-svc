.PHONY: dev gen lint test bootstrap deploy cleanup

CLOUDRUN := npx --no-install svc-cloudrun

dev:
	bun run ./src/index.ts

gen:
	bun run ./scripts/codegen.ts

lint:
	bunx tsc --noEmit

test:
	bun test

bootstrap:
	$(CLOUDRUN) bootstrap

deploy:
	$(CLOUDRUN) deploy $(ARGS)

cleanup:
	$(CLOUDRUN) cleanup $(ARGS)
