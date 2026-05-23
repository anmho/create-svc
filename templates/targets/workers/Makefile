.PHONY: dev migrate gen lint test create deploy dashboards auth destroy

SERVICE := service

dev:
	bun run dev

migrate:
	$(SERVICE) migrate

gen:
	@echo "no generated code for workers"

lint:
	bun run lint

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
