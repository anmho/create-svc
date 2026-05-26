.PHONY: dev migrate gen lint test test-e2e test-e2e-local test-e2e-prod create deploy protect-main dashboards observability-bootstrap auth destroy

SERVICE := service

dev:
	bun run dev

migrate:
	bun run ./scripts/migrate.ts

gen:
	bun run ./scripts/codegen.ts

lint:
	bun run lint

test:
	bun test

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
