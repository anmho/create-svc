.PHONY: dev migrate migrate-lint gen lint test create deploy dashboards auth destroy

SERVICE := service
WITH_ENV := set -a; [ ! -f .env.local ] || . ./.env.local; set +a;
ATLAS ?= atlas

dev:
	@bun run ./scripts/dev.ts go run ./cmd/server

migrate:
	@bun run ./scripts/ensure-local-db.ts
	@bun run ./scripts/wait-for-db.ts
	@$(WITH_ENV) $(ATLAS) migrate apply --env local

migrate-lint:
	@bun run ./scripts/ensure-local-db.ts
	@bun run ./scripts/wait-for-db.ts
	@$(WITH_ENV) $(ATLAS) migrate lint --env local --latest 1

gen:
	buf generate

lint:
	go vet ./...
	buf lint
	@bun run ./scripts/ensure-local-db.ts
	@bun run ./scripts/wait-for-db.ts
	@$(WITH_ENV) $(ATLAS) migrate lint --env local --latest 1

test:
	bun test ./test

create:
	$(SERVICE) create

deploy:
	$(SERVICE) deploy $(ARGS)

dashboards:
	$(SERVICE) dashboards

auth:
	$(SERVICE) auth $(ARGS)

destroy:
	$(SERVICE) destroy $(ARGS)
