.PHONY: dev migrate migrate-lint gen lint test create deploy dashboards observability-bootstrap auth destroy

SERVICE := service
WITH_ENV := set -a; [ ! -f .env.local ] || . ./.env.local; set +a;
ATLAS ?= atlas

dev:
	@bun run ./scripts/dev.ts go run ./cmd/server --worker go run ./cmd/worker

migrate:
	@bun run ./scripts/ensure-local-db.ts
	@bun run ./scripts/wait-for-db.ts
	@$(WITH_ENV) $(ATLAS) migrate apply --env local

migrate-lint:
	@bun run ./scripts/ensure-local-db.ts
	@bun run ./scripts/wait-for-db.ts
	@$(WITH_ENV) $(ATLAS) migrate lint --env local --latest 1

gen:
	@echo "no generated code for go + chi"

lint:
	go vet ./...
	$(ATLAS) migrate validate --env local

test:
	bun test ./test

create:
	$(SERVICE) create

deploy:
	$(SERVICE) deploy $(ARGS)

dashboards:
	$(SERVICE) dashboards

observability-bootstrap:
	$(SERVICE) observability-bootstrap

auth:
	$(SERVICE) auth $(ARGS)

destroy:
	$(SERVICE) destroy $(ARGS)
