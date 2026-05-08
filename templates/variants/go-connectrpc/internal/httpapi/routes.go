package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"{{MODULE_PATH}}/internal/app"
)

func RegisterRoutes(router chi.Router, service *app.ChatService) {
	router.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	router.Get("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	router.Get("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"service":   "{{SERVICE_NAME}}",
			"domain":    "chat",
			"apiOrigin": "https://api.{{SERVICE_NAME}}.anmho.com",
		})
	})

	router.Post("/webhooks/{provider}", func(w http.ResponseWriter, request *http.Request) {
		rawBody, err := io.ReadAll(request.Body)
		if err != nil {
			writeError(w, err)
			return
		}
		event, duplicate, err := service.ProcessWebhook(request.Context(), chi.URLParam(request, "provider"), request.Header, rawBody)
		if err != nil {
			writeError(w, err)
			return
		}
		status := http.StatusAccepted
		if duplicate {
			status = http.StatusOK
		}
		writeJSON(w, status, map[string]any{"event": event, "duplicate": duplicate})
	})

	router.Get("/webhooks/{provider}/health", func(w http.ResponseWriter, request *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"status":   "ok",
			"provider": chi.URLParam(request, "provider"),
		})
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, err error) {
	var appErr *app.AppError
	if errors.As(err, &appErr) {
		writeJSON(w, appErr.Status, map[string]string{
			"error": appErr.Error(),
			"code":  appErr.Code,
		})
		return
	}

	status := http.StatusInternalServerError
	if errors.Is(err, strconv.ErrSyntax) || strings.Contains(strings.ToLower(err.Error()), "json") {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
