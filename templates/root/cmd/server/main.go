package main

import (
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"{{MODULE_PATH}}/internal/app"
	"{{MODULE_PATH}}/internal/config"
	"{{MODULE_PATH}}/internal/connectapi"
	"{{MODULE_PATH}}/internal/httpapi"
	"{{MODULE_PATH}}/internal/vault"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	httpClient := &http.Client{Timeout: 15 * time.Second}
	vaultClient := vault.NewAppRoleClient(cfg.VaultAddr, cfg.VaultRoleIDFile, cfg.VaultSecretIDFile, httpClient)
	tokenSource := app.NewCloudflareTokenSource(vaultClient, cfg.VaultSecretPath, cfg.VaultSecretKey)
	service := app.NewDNSService(cfg.CloudflareZoneID, cfg.CloudflareAPIBaseURL, tokenSource)

	router := chi.NewRouter()
	httpapi.RegisterRoutes(router, service)

	connectPath, connectHandler := connectapi.NewHandler(service)
	router.Mount(connectPath, connectHandler)

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		ReadHeaderTimeout: 10 * time.Second,
		Handler:           h2c.NewHandler(router, &http2.Server{}),
	}

	log.Printf("listening on %s", server.Addr)
	log.Fatal(server.ListenAndServe())
}
