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

	router.Post("/v1/users", func(w http.ResponseWriter, request *http.Request) {
		var input app.CreateUserInput
		if err := decodeJSON(request, &input); err != nil {
			writeError(w, err)
			return
		}
		user, err := service.CreateUser(request.Context(), input)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"user": user})
	})

	router.Get("/v1/users/{userID}", func(w http.ResponseWriter, request *http.Request) {
		user, err := service.GetUser(request.Context(), chi.URLParam(request, "userID"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"user": user})
	})

	router.Get("/v1/users", func(w http.ResponseWriter, request *http.Request) {
		user, err := service.GetUserByUsername(request.Context(), request.URL.Query().Get("username"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"user": user})
	})

	router.Post("/v1/conversations", func(w http.ResponseWriter, request *http.Request) {
		var input app.CreateConversationInput
		if err := decodeJSON(request, &input); err != nil {
			writeError(w, err)
			return
		}
		conversation, err := service.CreateConversation(request.Context(), input)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"conversation": conversation})
	})

	router.Get("/v1/conversations/{conversationID}", func(w http.ResponseWriter, request *http.Request) {
		conversation, err := service.GetConversation(request.Context(), chi.URLParam(request, "conversationID"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"conversation": conversation})
	})

	router.Patch("/v1/conversations/{conversationID}", func(w http.ResponseWriter, request *http.Request) {
		var input app.UpdateConversationInput
		if err := decodeJSON(request, &input); err != nil {
			writeError(w, err)
			return
		}
		conversation, err := service.UpdateConversation(request.Context(), chi.URLParam(request, "conversationID"), input)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"conversation": conversation})
	})

	router.Delete("/v1/conversations/{conversationID}", func(w http.ResponseWriter, request *http.Request) {
		if err := service.DeleteConversation(request.Context(), chi.URLParam(request, "conversationID")); err != nil {
			writeError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	router.Post("/v1/conversations/{conversationID}/participants", func(w http.ResponseWriter, request *http.Request) {
		var input struct {
			UserID string `json:"user_id"`
		}
		if err := decodeJSON(request, &input); err != nil {
			writeError(w, err)
			return
		}
		conversation, err := service.AddParticipant(request.Context(), chi.URLParam(request, "conversationID"), input.UserID)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"conversation": conversation})
	})

	router.Delete("/v1/conversations/{conversationID}/participants/{userID}", func(w http.ResponseWriter, request *http.Request) {
		if err := service.RemoveParticipant(request.Context(), chi.URLParam(request, "conversationID"), chi.URLParam(request, "userID")); err != nil {
			writeError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	router.Get("/v1/conversations/{conversationID}/messages", func(w http.ResponseWriter, request *http.Request) {
		limit := 0
		if rawLimit := strings.TrimSpace(request.URL.Query().Get("limit")); rawLimit != "" {
			parsedLimit, err := strconv.Atoi(rawLimit)
			if err != nil {
				writeError(w, &app.AppError{Status: http.StatusBadRequest, Code: "invalid_limit", Err: errors.New("limit must be a positive integer")})
				return
			}
			limit = parsedLimit
		}
		result, err := service.ListMessages(request.Context(), chi.URLParam(request, "conversationID"), app.ListMessagesInput{
			Cursor: strings.TrimSpace(request.URL.Query().Get("cursor")),
			Limit:  limit,
		})
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})

	router.Post("/v1/conversations/{conversationID}/messages", func(w http.ResponseWriter, request *http.Request) {
		var input app.CreateMessageInput
		if err := decodeJSON(request, &input); err != nil {
			writeError(w, err)
			return
		}
		message, err := service.CreateMessage(request.Context(), chi.URLParam(request, "conversationID"), input)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"message": message})
	})

	router.Patch("/v1/conversations/{conversationID}/messages/{messageID}", func(w http.ResponseWriter, request *http.Request) {
		var input app.UpdateMessageInput
		if err := decodeJSON(request, &input); err != nil {
			writeError(w, err)
			return
		}
		message, err := service.UpdateMessage(request.Context(), chi.URLParam(request, "conversationID"), chi.URLParam(request, "messageID"), input)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"message": message})
	})

	router.Delete("/v1/conversations/{conversationID}/messages/{messageID}", func(w http.ResponseWriter, request *http.Request) {
		if err := service.DeleteMessage(request.Context(), chi.URLParam(request, "conversationID"), chi.URLParam(request, "messageID")); err != nil {
			writeError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	router.Post("/v1/attachments/uploads", func(w http.ResponseWriter, request *http.Request) {
		var input app.CreateAttachmentUploadInput
		if err := decodeJSON(request, &input); err != nil {
			writeError(w, err)
			return
		}
		result, err := service.CreateAttachmentUpload(request.Context(), input)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"result": result})
	})

	router.Post("/v1/attachments/{attachmentID}/finalize", func(w http.ResponseWriter, request *http.Request) {
		var input app.FinalizeAttachmentInput
		if err := decodeOptionalJSON(request, &input); err != nil {
			writeError(w, err)
			return
		}
		attachment, err := service.FinalizeAttachment(request.Context(), chi.URLParam(request, "attachmentID"), input)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"attachment": attachment})
	})

	router.Get("/v1/attachments/{attachmentID}", func(w http.ResponseWriter, request *http.Request) {
		attachment, err := service.GetAttachment(request.Context(), chi.URLParam(request, "attachmentID"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"attachment": attachment})
	})

	router.Delete("/v1/attachments/{attachmentID}", func(w http.ResponseWriter, request *http.Request) {
		if err := service.DeleteAttachment(request.Context(), chi.URLParam(request, "attachmentID")); err != nil {
			writeError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
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
	if errors.Is(err, strconv.ErrSyntax) || strings.Contains(strings.ToLower(err.Error()), "json") {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
