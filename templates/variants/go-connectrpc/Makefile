.PHONY: dev dev-down migrate migrate-lint gen lint test test-e2e test-e2e-local test-e2e-prod create deploy protect-main dashboards observability-bootstrap auth destroy

SERVICE := service
WITH_ENV := set -a; [ ! -f .env.local ] || . ./.env.local; set +a;
ATLAS ?= atlas

dev:
	@bun run ./scripts/dev.ts go run ./cmd/server --worker go run ./cmd/worker

dev-down:
	$(SERVICE) dev down

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
	$(ATLAS) migrate validate --env local

test:
	bun test ./test

test-e2e:
	bun run ./scripts/e2e.ts $(ARGS)

test-e2e-local:
	bun run ./scripts/e2e.ts --local $(ARGS)

test-e2e-prod:
	bun run ./scripts/e2e.ts --prod $(ARGS)

create:
	$(SERVICE) create

deploy:
	$(SERVICE) deploy $(ARGS)

protect-main:
	$(SERVICE) protect-main $(ARGS)

dashboards:
	$(SERVICE) dashboards

observability-bootstrap:
	$(SERVICE) observability-bootstrap

auth:
	$(SERVICE) auth $(ARGS)

destroy:
	$(SERVICE) destroy $(ARGS)
