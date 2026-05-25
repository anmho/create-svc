.PHONY: dev migrate gen lint test create deploy protect-main dashboards observability-bootstrap auth destroy

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
