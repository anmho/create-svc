package connectapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/jmoiron/sqlx"

	chatv1 "{{MODULE_PATH}}/gen/chat/v1"
	chatv1connect "{{MODULE_PATH}}/gen/chat/v1/chatv1connect"
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
	path, handler := NewHandler(service)
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	client := chatv1connect.NewChatServiceClient(http.DefaultClient, server.URL)

	createUserResponse, err := client.CreateUser(context.Background(), connect.NewRequest(&chatv1.CreateUserRequest{
		Username:    "alice",
		DisplayName: "Alice",
	}))
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	userID := createUserResponse.Msg.GetUser().GetId()

	createConversationResponse, err := client.CreateConversation(context.Background(), connect.NewRequest(&chatv1.CreateConversationRequest{
		CreatedByUserId:    userID,
		Title:              "General",
		ParticipantUserIds: []string{userID},
	}))
	if err != nil {
		t.Fatalf("create conversation: %v", err)
	}
	conversationID := createConversationResponse.Msg.GetConversation().GetId()

	messageIDs := make([]string, 0, 55)
	for index := 1; index <= 55; index++ {
		response, err := client.CreateMessage(context.Background(), connect.NewRequest(&chatv1.CreateMessageRequest{
			ConversationId: conversationID,
			UserId:         userID,
			Body:           fmt.Sprintf("message-%d", index),
		}))
		if err != nil {
			t.Fatalf("create message %d: %v", index, err)
		}
		messageIDs = append(messageIDs, response.Msg.GetMessage().GetId())
	}
	rewriteMessageTimestamps(t, db, messageIDs)

	uploadResponse, err := client.CreateAttachmentUpload(context.Background(), connect.NewRequest(&chatv1.CreateAttachmentUploadRequest{
		ConversationId: conversationID,
		UserId:         userID,
		Filename:       "photo.png",
		ContentType:    "image/png",
		ByteSize:       1234,
	}))
	if err != nil {
		t.Fatalf("create attachment upload: %v", err)
	}
	storage.set(uploadResponse.Msg.GetAttachment().GetPublicUrl(), "image/png", 1234)
	if _, err := client.FinalizeAttachment(context.Background(), connect.NewRequest(&chatv1.FinalizeAttachmentRequest{
		AttachmentId: uploadResponse.Msg.GetAttachment().GetId(),
		MessageId:    messageIDs[54],
	})); err != nil {
		t.Fatalf("finalize attachment: %v", err)
	}

	firstPage, err := client.ListMessages(context.Background(), connect.NewRequest(&chatv1.ListMessagesRequest{
		ConversationId: conversationID,
	}))
	if err != nil {
		t.Fatalf("list messages first page: %v", err)
	}
	if len(firstPage.Msg.GetMessages()) != 50 {
		t.Fatalf("expected 50 messages, got %d", len(firstPage.Msg.GetMessages()))
	}
	if firstPage.Msg.GetMessages()[0].GetBody() != "message-55" {
		t.Fatalf("expected newest message first, got %s", firstPage.Msg.GetMessages()[0].GetBody())
	}
	if firstPage.Msg.GetMessages()[49].GetBody() != "message-6" {
		t.Fatalf("expected oldest message on first page to be message-6, got %s", firstPage.Msg.GetMessages()[49].GetBody())
	}
	if firstPage.Msg.GetNextCursor() == "" {
		t.Fatal("expected next cursor on first page")
	}
	attachments := firstPage.Msg.GetMessages()[0].GetAttachments()
	if len(attachments) != 1 {
		t.Fatalf("expected attachment metadata on newest message, got %#v", attachments)
	}
	if attachments[0].GetPublicUrl() != uploadResponse.Msg.GetAttachment().GetPublicUrl() {
		t.Fatalf("expected public_url %s, got %s", uploadResponse.Msg.GetAttachment().GetPublicUrl(), attachments[0].GetPublicUrl())
	}

	secondPage, err := client.ListMessages(context.Background(), connect.NewRequest(&chatv1.ListMessagesRequest{
		ConversationId: conversationID,
		Cursor:         firstPage.Msg.GetNextCursor(),
	}))
	if err != nil {
		t.Fatalf("list messages second page: %v", err)
	}
	expectedBodies := []string{"message-5", "message-4", "message-3", "message-2", "message-1"}
	if len(secondPage.Msg.GetMessages()) != len(expectedBodies) {
		t.Fatalf("expected %d messages on second page, got %d", len(expectedBodies), len(secondPage.Msg.GetMessages()))
	}
	for index, body := range expectedBodies {
		if secondPage.Msg.GetMessages()[index].GetBody() != body {
			t.Fatalf("expected %s at index %d, got %s", body, index, secondPage.Msg.GetMessages()[index].GetBody())
		}
	}
	if secondPage.Msg.GetNextCursor() != "" {
		t.Fatalf("expected no next cursor on final page, got %s", secondPage.Msg.GetNextCursor())
	}
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
