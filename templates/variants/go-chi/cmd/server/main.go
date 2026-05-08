package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"cloud.google.com/go/storage"
	"github.com/go-chi/chi/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"{{MODULE_PATH}}/internal/app"
	"{{MODULE_PATH}}/internal/config"
	"{{MODULE_PATH}}/internal/httpapi"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	db, err := app.OpenDatabase(context.Background(), cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}

	storageClient, err := storage.NewClient(context.Background())
	if err != nil {
		log.Fatal(err)
	}

	service := app.NewChatService(
		db,
		app.NewGCSStorage(cfg.AttachmentBucket, cfg.AttachmentPublicBaseURL, storageClient),
		app.GenericWebhookAdapter{},
	)

	router := chi.NewRouter()
	httpapi.RegisterRoutes(router, service)

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		ReadHeaderTimeout: 10 * time.Second,
		Handler:           h2c.NewHandler(router, &http2.Server{}),
	}

	log.Printf("listening on %s", server.Addr)
	log.Fatal(server.ListenAndServe())
}
