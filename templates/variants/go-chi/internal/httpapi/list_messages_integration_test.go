package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/jmoiron/sqlx"

	"{{MODULE_PATH}}/internal/app"
)

func TestListMessagesPaginationIncludesAttachmentMetadata(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL is required for integration test")
	}

	t.Setenv("ATTACHMENT_PUBLIC_BASE_URL", "https://storage.test")

	db, err := app.OpenDatabase(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if _, err := db.ExecContext(context.Background(), `
truncate table
  webhook_events,
  attachments,
  messages,
  conversation_participants,
  conversations,
  users
restart identity cascade`); err != nil {
		t.Fatalf("truncate tables: %v", err)
	}

	storage := newFakeStorage()
	service := app.NewChatService(db, storage, app.GenericWebhookAdapter{})
	router := chi.NewRouter()
	RegisterRoutes(router, service)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	userID := createUser(t, server.URL)
	conversationID := createConversation(t, server.URL, userID)

	messageIDs := make([]string, 0, 55)
	for index := 1; index <= 55; index++ {
		messageIDs = append(messageIDs, createMessage(t, server.URL, conversationID, userID, fmt.Sprintf("message-%d", index)))
	}
	rewriteMessageTimestamps(t, db, messageIDs)

	upload := createAttachmentUpload(t, server.URL, conversationID, userID)
	storage.set(upload.Result.Attachment.PublicURL, "image/png", 1234)
	finalizeAttachment(t, server.URL, upload.Result.Attachment.ID, messageIDs[54])

	firstPage := listMessagesPage(t, server.URL, conversationID, "")
	if len(firstPage.Messages) != 50 {
		t.Fatalf("expected 50 messages, got %d", len(firstPage.Messages))
	}
	if firstPage.Messages[0].Body != "message-55" {
		t.Fatalf("expected newest message first, got %s", firstPage.Messages[0].Body)
	}
	if firstPage.Messages[49].Body != "message-6" {
		t.Fatalf("expected oldest message on first page to be message-6, got %s", firstPage.Messages[49].Body)
	}
	if firstPage.NextCursor == "" {
		t.Fatal("expected next_cursor on first page")
	}
	if len(firstPage.Messages[0].Attachments) != 1 {
		t.Fatalf("expected attachment metadata on newest message, got %#v", firstPage.Messages[0].Attachments)
	}
	if firstPage.Messages[0].Attachments[0].PublicURL != upload.Result.Attachment.PublicURL {
		t.Fatalf("expected public_url %s, got %s", upload.Result.Attachment.PublicURL, firstPage.Messages[0].Attachments[0].PublicURL)
	}

	secondPage := listMessagesPage(t, server.URL, conversationID, firstPage.NextCursor)
	expectedBodies := []string{"message-5", "message-4", "message-3", "message-2", "message-1"}
	if len(secondPage.Messages) != len(expectedBodies) {
		t.Fatalf("expected %d messages on second page, got %d", len(expectedBodies), len(secondPage.Messages))
	}
	for index, body := range expectedBodies {
		if secondPage.Messages[index].Body != body {
			t.Fatalf("expected %s at index %d, got %s", body, index, secondPage.Messages[index].Body)
		}
	}
	if secondPage.NextCursor != "" {
		t.Fatalf("expected no next cursor on final page, got %s", secondPage.NextCursor)
	}
}

type pageResponse struct {
	Messages []struct {
		ID          string `json:"id"`
		Body        string `json:"body"`
		Attachments []struct {
			ID          string `json:"id"`
			Filename    string `json:"filename"`
			ContentType string `json:"content_type"`
			ByteSize    int64  `json:"byte_size"`
			Status      string `json:"status"`
			PublicURL   string `json:"public_url"`
		} `json:"attachments"`
	} `json:"messages"`
	NextCursor string `json:"next_cursor"`
}

type attachmentUploadResponse struct {
	Result struct {
		Attachment struct {
			ID        string `json:"id"`
			PublicURL string `json:"public_url"`
		} `json:"attachment"`
	} `json:"result"`
}

type fakeStorage struct {
	metadata map[string]struct {
		contentType string
		byteSize    int64
		publicURL   string
	}
}

func newFakeStorage() *fakeStorage {
	return &fakeStorage{metadata: map[string]struct {
		contentType string
		byteSize    int64
		publicURL   string
	}{}}
}

func (f *fakeStorage) CreateSignedUpload(_ context.Context, attachmentID string, conversationID string, filename string, contentType string) (string, string, app.UploadTarget, string, error) {
	key := fmt.Sprintf("attachments/%s/%s/%s", conversationID, attachmentID, filename)
	return "test-bucket", key, app.UploadTarget{
		Method: http.MethodPut,
		URL:    "https://uploads.test/" + key,
		Headers: map[string]string{
			"Content-Type": contentType,
		},
	}, "https://storage.test/" + key, nil
}

func (f *fakeStorage) GetObjectMetadata(_ context.Context, bucket string, key string) (string, int64, string, error) {
	entry, ok := f.metadata[bucket+"/"+key]
	if !ok {
		return "", 0, "", fmt.Errorf("missing metadata for %s/%s", bucket, key)
	}
	return entry.contentType, entry.byteSize, entry.publicURL, nil
}

func (f *fakeStorage) set(publicURL string, contentType string, byteSize int64) {
	key := strings.TrimPrefix(publicURL, "https://storage.test/")
	f.metadata["test-bucket/"+key] = struct {
		contentType string
		byteSize    int64
		publicURL   string
	}{
		contentType: contentType,
		byteSize:    byteSize,
		publicURL:   publicURL,
	}
}

func createUser(t *testing.T, baseURL string) string {
	var response struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	requestJSON(t, http.MethodPost, baseURL+"/v1/users", map[string]any{
		"username":     "alice",
		"display_name": "Alice",
	}, &response)
	return response.User.ID
}

func createConversation(t *testing.T, baseURL string, userID string) string {
	var response struct {
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
	}
	requestJSON(t, http.MethodPost, baseURL+"/v1/conversations", map[string]any{
		"created_by_user_id":  userID,
		"title":               "General",
		"participant_user_ids": []string{userID},
	}, &response)
	return response.Conversation.ID
}

func createMessage(t *testing.T, baseURL string, conversationID string, userID string, body string) string {
	var response struct {
		Message struct {
			ID string `json:"id"`
		} `json:"message"`
	}
	requestJSON(t, http.MethodPost, baseURL+"/v1/conversations/"+conversationID+"/messages", map[string]any{
		"user_id": userID,
		"body":    body,
	}, &response)
	return response.Message.ID
}

func createAttachmentUpload(t *testing.T, baseURL string, conversationID string, userID string) attachmentUploadResponse {
	var response attachmentUploadResponse
	requestJSON(t, http.MethodPost, baseURL+"/v1/attachments/uploads", map[string]any{
		"conversation_id": conversationID,
		"user_id":         userID,
		"filename":        "photo.png",
		"content_type":    "image/png",
		"byte_size":       1234,
	}, &response)
	return response
}

func finalizeAttachment(t *testing.T, baseURL string, attachmentID string, messageID string) {
	requestJSON(t, http.MethodPost, baseURL+"/v1/attachments/"+attachmentID+"/finalize", map[string]any{
		"message_id": messageID,
	}, &struct{}{})
}

func listMessagesPage(t *testing.T, baseURL string, conversationID string, cursor string) pageResponse {
	requestURL := baseURL + "/v1/conversations/" + conversationID + "/messages"
	if cursor != "" {
		requestURL += "?cursor=" + url.QueryEscape(cursor)
	}
	var response pageResponse
	requestJSON(t, http.MethodGet, requestURL, nil, &response)
	return response
}

func requestJSON(t *testing.T, method string, url string, payload any, out any) {
	t.Helper()

	var bodyReader *bytes.Reader
	if payload == nil {
		bodyReader = bytes.NewReader(nil)
	} else {
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		bodyReader = bytes.NewReader(body)
	}

	request, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var problem map[string]any
		_ = json.NewDecoder(response.Body).Decode(&problem)
		t.Fatalf("unexpected status %d: %#v", response.StatusCode, problem)
	}

	if out != nil {
		if err := json.NewDecoder(response.Body).Decode(out); err != nil {
			t.Fatalf("decode response: %v", err)
		}
	}
}

func rewriteMessageTimestamps(t *testing.T, db *sqlx.DB, messageIDs []string) {
	t.Helper()
	baseTime := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	for index, messageID := range messageIDs {
		createdAt := baseTime.Add(time.Duration(index+1) * time.Second)
		if _, err := db.ExecContext(context.Background(), `
update messages
set created_at = $2, updated_at = $2
where id = $1`, messageID, createdAt); err != nil {
			t.Fatalf("rewrite message timestamp: %v", err)
		}
	}
}
