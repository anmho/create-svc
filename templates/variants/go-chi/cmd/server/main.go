package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"{{MODULE_PATH}}/internal/app"
	"{{MODULE_PATH}}/internal/auth"
	"{{MODULE_PATH}}/internal/config"
	"{{MODULE_PATH}}/internal/httpapi"
	temporalapp "{{MODULE_PATH}}/internal/temporal"
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

	service := app.NewWaitlistService(db)
	if cfg.TemporalEnabled {
		temporalConfig := temporalapp.WorkerConfig{
			Address:   cfg.TemporalAddress,
			Namespace: cfg.TemporalNamespace,
			TaskQueue: cfg.TemporalTaskQueue,
			APIKey:    cfg.TemporalAPIKey,
			TLSCACert: cfg.TemporalTLSCACert,
			TLSCert:   cfg.TemporalTLSCert,
			TLSKey:    cfg.TemporalTLSKey,
		}
		dispatcher, err := temporalapp.NewTriggerDispatcher(temporalConfig)
		if err != nil {
			log.Fatal(err)
		}
		defer dispatcher.Close()
		service.SetTriggerDispatcher(dispatcher)
	}

	router := chi.NewRouter()
	router.Use(auth.Middleware(auth.Config{
		Enabled:  cfg.AuthEnabled,
		Issuer:   cfg.AuthIssuer,
		Audience: cfg.AuthAudience,
		JWKSURL:  cfg.AuthJWKSURL,
	}))
	httpapi.RegisterRoutes(router, service)

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		ReadHeaderTimeout: 10 * time.Second,
		Handler:           h2c.NewHandler(router, &http2.Server{}),
	}

	log.Printf("listening on %s", server.Addr)
	log.Fatal(server.ListenAndServe())
}
