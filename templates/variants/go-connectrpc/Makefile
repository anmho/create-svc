.PHONY: dev dev-down migrate gen lint test bootstrap deploy cleanup

CLOUDRUN := npx --no-install svc-cloudrun
WITH_ENV := set -a; [ ! -f .env.local ] || . ./.env.local; set +a;

dev:
	@$(WITH_ENV) go run ./cmd/server

dev-down:
	bun run ./scripts/service.ts dev down

migrate:
	@$(WITH_ENV) go run ./cmd/migrate

gen:
	buf generate

lint:
	go vet ./...
	buf lint

test:
	bun test ./test

bootstrap:
	$(CLOUDRUN) bootstrap

deploy:
	$(CLOUDRUN) deploy $(ARGS)

cleanup:
	$(CLOUDRUN) cleanup $(ARGS)
