package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"{{MODULE_PATH}}/internal/app"
)

func RegisterRoutes(router chi.Router, service *app.DNSService) {
	router.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	router.Route("/v1/dns/records", func(r chi.Router) {
		r.Get("/", func(w http.ResponseWriter, request *http.Request) {
			records, err := service.ListRecords(request.Context())
			if err != nil {
				writeError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"records": records})
		})

		r.Post("/", func(w http.ResponseWriter, request *http.Request) {
			var input app.CreateRecordInput
			if err := decodeJSON(request, &input); err != nil {
				writeError(w, err)
				return
			}

			record, err := service.CreateRecord(request.Context(), input)
			if err != nil {
				writeError(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, map[string]any{"record": record})
		})

		r.Route("/{recordID}", func(r chi.Router) {
			r.Put("/", func(w http.ResponseWriter, request *http.Request) {
				var input app.UpdateRecordInput
				if err := decodeJSON(request, &input); err != nil {
					writeError(w, err)
					return
				}

				record, err := service.UpdateRecord(request.Context(), chi.URLParam(request, "recordID"), input)
				if err != nil {
					writeError(w, err)
					return
				}
				writeJSON(w, http.StatusOK, map[string]any{"record": record})
			})

			r.Delete("/", func(w http.ResponseWriter, request *http.Request) {
				if err := service.DeleteRecord(request.Context(), chi.URLParam(request, "recordID")); err != nil {
					writeError(w, err)
					return
				}
				w.WriteHeader(http.StatusNoContent)
			})
		})
	})
}

func decodeJSON(request *http.Request, out any) error {
	defer request.Body.Close()

	if err := json.NewDecoder(request.Body).Decode(out); err != nil {
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	if errors.Is(err, strconv.ErrSyntax) || strings.Contains(strings.ToLower(err.Error()), "json") {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
