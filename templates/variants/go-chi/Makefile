.PHONY: dev gen lint test bootstrap deploy cleanup

CLOUDRUN := npx --no-install svc-cloudrun

dev:
	go run ./cmd/server

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
