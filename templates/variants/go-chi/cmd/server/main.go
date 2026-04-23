package main

import (
	"context"
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
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	service := app.NewDNSService()
	if cfg.DatabaseURL != "" {
		if _, err := service.CreateRecord(context.Background(), app.CreateRecordInput{
			Type:    "TXT",
			Name:    "bootstrap",
			Content: "database-configured",
			TTL:     60,
			Proxied: false,
		}); err != nil {
			log.Fatal(err)
		}
	}

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
