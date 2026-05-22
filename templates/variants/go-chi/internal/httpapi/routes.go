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

func RegisterRoutes(router chi.Router, service *app.WaitlistService) {
	router.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	router.Get("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	router.Get("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"service":   "{{SERVICE_NAME}}",
			"domain":    "waitlist",
			"apiOrigin": "https://api.{{SERVICE_NAME}}.anmho.com",
		})
	})

	router.Post("/v1/waitlist", func(w http.ResponseWriter, request *http.Request) {
		var input app.JoinWaitlistInput
		if err := decodeJSON(request, &input); err != nil {
			writeError(w, err)
			return
		}
		result, err := service.JoinWaitlist(request.Context(), input)
		if err != nil {
			writeError(w, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		writeJSON(w, status, result)
	})

	router.Get("/v1/waitlist", func(w http.ResponseWriter, request *http.Request) {
		entry, err := service.GetEntryByEmail(request.Context(), request.URL.Query().Get("email"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"entry": entry})
	})

	router.Get("/v1/waitlist/{entryID}", func(w http.ResponseWriter, request *http.Request) {
		entry, err := service.GetEntry(request.Context(), chi.URLParam(request, "entryID"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"entry": entry})
	})

	router.Get("/v1/admin/waitlist", func(w http.ResponseWriter, request *http.Request) {
		entries, err := service.ListEntries(request.Context(), app.ListWaitlistEntriesInput{
			Status: request.URL.Query().Get("status"),
			Limit:  optionalInt(request.URL.Query().Get("limit")),
		})
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
	})

	router.Get("/v1/admin/waitlist/export", func(w http.ResponseWriter, request *http.Request) {
		csv, err := service.ExportEntries(request.Context(), app.ListWaitlistEntriesInput{
			Status: request.URL.Query().Get("status"),
			Limit:  optionalInt(request.URL.Query().Get("limit")),
		})
		if err != nil {
			writeError(w, err)
			return
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="waitlist.csv"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(csv))
	})

	router.Patch("/v1/admin/waitlist/{entryID}", func(w http.ResponseWriter, request *http.Request) {
		var input app.UpdateWaitlistEntryInput
		if err := decodeJSON(request, &input); err != nil {
			writeError(w, err)
			return
		}
		input.EntryID = chi.URLParam(request, "entryID")
		entry, err := service.UpdateEntry(request.Context(), input)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"entry": entry})
	})

	router.Post("/v1/triggers/waitlist", func(w http.ResponseWriter, request *http.Request) {
		var payload map[string]any
		if err := decodeOptionalJSON(request, &payload); err != nil {
			writeError(w, err)
			return
		}
		trigger, err := service.RecordTrigger(request.Context(), app.RecordTriggerInput{
			Type:    stringValue(payload, "type", "manual"),
			EntryID: stringValue(payload, "entry_id", ""),
			Payload: payload,
		})
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"trigger": trigger})
	})

	router.Post("/webhooks/{provider}", func(w http.ResponseWriter, request *http.Request) {
		rawBody, err := io.ReadAll(request.Body)
		if err != nil {
			writeError(w, err)
			return
		}
		trigger, err := service.RecordTrigger(request.Context(), app.RecordTriggerInput{
			Type: "webhook." + chi.URLParam(request, "provider"),
			Payload: map[string]any{
				"headers": request.Header,
				"rawBody": string(rawBody),
			},
		})
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"trigger": trigger})
	})

	router.Get("/webhooks/{provider}/health", func(w http.ResponseWriter, request *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"status":   "ok",
			"provider": chi.URLParam(request, "provider"),
		})
	})
}

func decodeJSON(request *http.Request, out any) error {
	defer request.Body.Close()
	return json.NewDecoder(request.Body).Decode(out)
}

func decodeOptionalJSON(request *http.Request, out any) error {
	defer request.Body.Close()
	decoder := json.NewDecoder(request.Body)
	if err := decoder.Decode(out); err != nil && !errors.Is(err, io.EOF) {
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
	var appErr *app.AppError
	if errors.As(err, &appErr) {
		writeJSON(w, appErr.Status, map[string]string{
			"error": appErr.Error(),
			"code":  appErr.Code,
		})
		return
	}

	status := http.StatusInternalServerError
	if strings.Contains(strings.ToLower(err.Error()), "json") {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func stringValue(values map[string]any, key string, fallback string) string {
	if values == nil {
		return fallback
	}
	value, ok := values[key]
	if !ok && key == "entry_id" {
		value, ok = values["entryId"]
	}
	if !ok {
		return fallback
	}
	text, ok := value.(string)
	if !ok {
		return fallback
	}
	return strings.TrimSpace(text)
}

func optionalInt(value string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return 0
	}
	return parsed
}
