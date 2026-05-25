package main

import (
	"log"
	"net/http"
	"time"

	"{{MODULE_PATH}}/internal/config"
	temporalapp "{{MODULE_PATH}}/internal/temporal"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	if !cfg.TemporalEnabled {
		log.Fatal("Temporal worker is disabled. Set TEMPORAL_ENABLED=true or do not run the worker process.")
	}

	stopTemporal, err := temporalapp.StartWorker(temporalapp.WorkerConfig{
		Address:   cfg.TemporalAddress,
		Namespace: cfg.TemporalNamespace,
		TaskQueue: cfg.TemporalTaskQueue,
		APIKey:    cfg.TemporalAPIKey,
	})
	if err != nil {
		log.Fatal(err)
	}
	defer stopTemporal()
	log.Printf("Temporal worker polling %s", cfg.TemporalTaskQueue)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		writeWorkerHealth(w)
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, request *http.Request) {
		writeWorkerHealth(w)
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, request *http.Request) {
		writeWorkerHealth(w)
	})

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		ReadHeaderTimeout: 10 * time.Second,
		Handler:           mux,
	}
	log.Printf("worker health listening on %s", server.Addr)
	log.Fatal(server.ListenAndServe())
}

func writeWorkerHealth(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok","worker":"temporal"}`))
}
