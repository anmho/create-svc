.PHONY: dev migrate gen lint test create deploy dashboards auth destroy

SERVICE := npx --no-install service

dev:
	bun run dev

migrate:
	bun run ./scripts/migrate.ts

gen:
	bun run ./scripts/codegen.ts

lint:
	bunx tsc --noEmit

test:
	bun test

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
