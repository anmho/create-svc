package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"cloud.google.com/go/storage"
	"connectrpc.com/grpcreflect"
	"github.com/go-chi/chi/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	chatv1connect "{{MODULE_PATH}}/gen/chat/v1/chatv1connect"
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
	connectPath, connectHandler := connectapi.NewHandler(service)
	router.Mount(connectPath, connectHandler)
	httpapi.RegisterRoutes(router, service)

	if localRPCIntrospectionEnabled() {
		reflector := grpcreflect.NewStaticReflector(chatv1connect.ChatServiceName)
		reflectionV1Path, reflectionV1Handler := grpcreflect.NewHandlerV1(reflector)
		reflectionV1AlphaPath, reflectionV1AlphaHandler := grpcreflect.NewHandlerV1Alpha(reflector)
		router.Mount(reflectionV1Path, reflectionV1Handler)
		router.Mount(reflectionV1AlphaPath, reflectionV1AlphaHandler)
	}

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		ReadHeaderTimeout: 10 * time.Second,
		Handler:           h2c.NewHandler(router, &http2.Server{}),
	}

	log.Printf("listening on %s", server.Addr)
	log.Fatal(server.ListenAndServe())
}

func localRPCIntrospectionEnabled() bool {
	override := strings.TrimSpace(strings.ToLower(os.Getenv("ENABLE_RPC_INTROSPECTION")))
	if override != "" {
		return override != "0" && override != "false" && override != "no" && override != "off"
	}
	return os.Getenv("K_SERVICE") == ""
}
