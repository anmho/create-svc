package app

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"cloud.google.com/go/storage"
	"github.com/jmoiron/sqlx"
)

type User struct {
	ID          string `json:"id" db:"id"`
	Username    string `json:"username" db:"username"`
	DisplayName string `json:"display_name,omitempty" db:"display_name"`
	CreatedAt   string `json:"created_at" db:"created_at"`
	UpdatedAt   string `json:"updated_at" db:"updated_at"`
}

type Conversation struct {
	ID              string `json:"id" db:"id"`
	Title           string `json:"title,omitempty" db:"title"`
	CreatedByUserID string `json:"created_by_user_id" db:"created_by_user_id"`
	Participants    []User `json:"participants"`
	CreatedAt       string `json:"created_at" db:"created_at"`
	UpdatedAt       string `json:"updated_at" db:"updated_at"`
}

type Message struct {
	ID             string `json:"id" db:"id"`
	ConversationID string `json:"conversation_id" db:"conversation_id"`
	UserID         string `json:"user_id" db:"user_id"`
	Body           string `json:"body" db:"body"`
	EditedAt       string `json:"edited_at,omitempty" db:"edited_at"`
	CreatedAt      string `json:"created_at" db:"created_at"`
	UpdatedAt      string `json:"updated_at" db:"updated_at"`
	Attachments    []MessageAttachment `json:"attachments"`
}

type MessageAttachment struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	ByteSize    int64  `json:"byte_size"`
	Status      string `json:"status"`
	PublicURL   string `json:"public_url"`
}

type Attachment struct {
	ID               string `json:"id" db:"id"`
	ConversationID   string `json:"conversation_id" db:"conversation_id"`
	MessageID        string `json:"message_id,omitempty" db:"message_id"`
	UploadedByUserID string `json:"uploaded_by_user_id" db:"uploaded_by_user_id"`
	StorageBucket    string `json:"storage_bucket" db:"storage_bucket"`
	StorageKey       string `json:"storage_key" db:"storage_key"`
	ContentType      string `json:"content_type" db:"content_type"`
	ByteSize         int64  `json:"byte_size" db:"byte_size"`
	Filename         string `json:"filename" db:"filename"`
	Status           string `json:"status" db:"status"`
	PublicURL        string `json:"public_url"`
	CreatedAt        string `json:"created_at" db:"created_at"`
	UpdatedAt        string `json:"updated_at" db:"updated_at"`
}

type UploadTarget struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

type CreateAttachmentUploadResult struct {
	Attachment Attachment   `json:"attachment"`
	Upload     UploadTarget `json:"upload"`
}

type WebhookEvent struct {
	ID              string `json:"id" db:"id"`
	Provider        string `json:"provider" db:"provider"`
	ExternalEventID string `json:"external_event_id" db:"external_event_id"`
	EventType       string `json:"event_type" db:"event_type"`
	SignatureValid  bool   `json:"signature_valid"`
	Status          string `json:"status" db:"status"`
	PayloadJSON     string `json:"payload_json" db:"payload_json"`
	ReceivedAt      string `json:"received_at" db:"received_at"`
	ProcessedAt     string `json:"processed_at,omitempty" db:"processed_at"`
}

type CreateUserInput struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

type CreateConversationInput struct {
	CreatedByUserID    string   `json:"created_by_user_id"`
	Title              string   `json:"title"`
	ParticipantUserIDs []string `json:"participant_user_ids"`
}

type UpdateConversationInput struct {
	Title string `json:"title"`
}

type CreateMessageInput struct {
	UserID string `json:"user_id"`
	Body   string `json:"body"`
}

type ListMessagesInput struct {
	Cursor string `json:"cursor"`
	Limit  int    `json:"limit"`
}

type ListMessagesResult struct {
	Messages   []Message `json:"messages"`
	NextCursor string    `json:"next_cursor,omitempty"`
}

type UpdateMessageInput struct {
	Body string `json:"body"`
}

type CreateAttachmentUploadInput struct {
	ConversationID   string `json:"conversation_id"`
	UploadedByUserID string `json:"user_id"`
	Filename         string `json:"filename"`
	ContentType      string `json:"content_type"`
	ByteSize         int64  `json:"byte_size"`
}

type FinalizeAttachmentInput struct {
	MessageID string `json:"message_id"`
}

type AppError struct {
	Status int
	Code   string
	Err    error
}

func (e *AppError) Error() string { return e.Err.Error() }

type Storage interface {
	CreateSignedUpload(ctx context.Context, attachmentID string, conversationID string, filename string, contentType string) (bucket string, key string, upload UploadTarget, publicURL string, err error)
	GetObjectMetadata(ctx context.Context, bucket string, key string) (contentType string, byteSize int64, publicURL string, err error)
}

type WebhookAdapter interface {
	Normalize(provider string, headers http.Header, rawBody []byte) (NormalizedWebhookEvent, error)
}

type NormalizedWebhookEvent struct {
	Provider        string
	ExternalEventID string
	EventType       string
	SignatureValid  bool
	PayloadJSON     string
}

type GenericWebhookAdapter struct{}

func (GenericWebhookAdapter) Normalize(provider string, headers http.Header, rawBody []byte) (NormalizedWebhookEvent, error) {
	var payload map[string]any
	_ = json.Unmarshal(rawBody, &payload)
	secret := strings.TrimSpace(os.Getenv("WEBHOOK_" + strings.ToUpper(provider) + "_SECRET"))
	incomingSecret := strings.TrimSpace(headers.Get("X-Webhook-Secret"))
	externalEventID, _ := payload["id"].(string)
	if externalEventID == "" {
		externalEventID = strings.TrimSpace(headers.Get("X-Event-Id"))
	}
	if externalEventID == "" {
		externalEventID = fmt.Sprintf("evt-%d", time.Now().UnixNano())
	}
	eventType, _ := payload["type"].(string)
	if eventType == "" {
		eventType = strings.TrimSpace(headers.Get("X-Event-Type"))
	}
	if eventType == "" {
		eventType = "generic.event"
	}

	return NormalizedWebhookEvent{
		Provider:        provider,
		ExternalEventID: externalEventID,
		EventType:       eventType,
		SignatureValid:  secret == "" || incomingSecret == secret,
		PayloadJSON:     string(rawBody),
	}, nil
}

type GCSStorage struct {
	bucketName    string
	publicBaseURL string
	client        *storage.Client
}

func NewGCSStorage(bucketName string, publicBaseURL string, client *storage.Client) *GCSStorage {
	if publicBaseURL == "" {
		publicBaseURL = "https://storage.googleapis.com/" + bucketName
	}
	return &GCSStorage{bucketName: bucketName, publicBaseURL: strings.TrimRight(publicBaseURL, "/"), client: client}
}

func (s *GCSStorage) CreateSignedUpload(_ context.Context, attachmentID string, conversationID string, filename string, contentType string) (string, string, UploadTarget, string, error) {
	key := fmt.Sprintf("attachments/%s/%s/%s", conversationID, attachmentID, sanitizeFilename(filename))
	url, err := s.client.Bucket(s.bucketName).SignedURL(key, &storage.SignedURLOptions{
		Method:      http.MethodPut,
		Expires:     time.Now().Add(15 * time.Minute),
		ContentType: contentType,
		Scheme:      storage.SigningSchemeV4,
	})
	if err != nil {
		return "", "", UploadTarget{}, "", err
	}
	return s.bucketName, key, UploadTarget{
		Method: http.MethodPut,
		URL:    url,
		Headers: map[string]string{
			"Content-Type": contentType,
		},
	}, s.publicBaseURL + "/" + key, nil
}

func (s *GCSStorage) GetObjectMetadata(ctx context.Context, bucket string, key string) (string, int64, string, error) {
	attrs, err := s.client.Bucket(bucket).Object(key).Attrs(ctx)
	if err != nil {
		return "", 0, "", err
	}
	return attrs.ContentType, attrs.Size, s.publicBaseURL + "/" + key, nil
}

type ChatService struct {
	db             *sqlx.DB
	storage        Storage
	webhookAdapter WebhookAdapter
}

func OpenDatabase(ctx context.Context, databaseURL string) (*sqlx.DB, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, errors.New("DATABASE_URL is required")
	}
	return sqlx.ConnectContext(ctx, "pgx", databaseURL)
}

func NewChatService(db *sqlx.DB, storage Storage, webhookAdapter WebhookAdapter) *ChatService {
	return &ChatService{db: db, storage: storage, webhookAdapter: webhookAdapter}
}

func (s *ChatService) CreateUser(ctx context.Context, input CreateUserInput) (User, error) {
	username := strings.ToLower(strings.TrimSpace(input.Username))
	if username == "" {
		return User{}, &AppError{Status: 400, Code: "invalid_username", Err: errors.New("username is required")}
	}
	var count int
	if err := s.db.GetContext(ctx, &count, `select count(*) from users where username = $1`, username); err != nil {
		return User{}, err
	}
	if count > 0 {
		return User{}, &AppError{Status: 409, Code: "username_taken", Err: fmt.Errorf("username %s already exists", username)}
	}
	id := fmt.Sprintf("usr_%d", time.Now().UnixNano())
	var user User
	err := s.db.GetContext(ctx, &user, `
insert into users (id, username, display_name)
values ($1, $2, nullif($3, ''))
returning id, username, coalesce(display_name, '') as display_name, created_at::text, updated_at::text
`, id, username, strings.TrimSpace(input.DisplayName))
	return user, err
}

func (s *ChatService) GetUser(ctx context.Context, userID string) (User, error) {
	var user User
	err := s.db.GetContext(ctx, &user, `
select id, username, coalesce(display_name, '') as display_name, created_at::text, updated_at::text
from users where id = $1`, userID)
	if err != nil {
		return User{}, notFoundIfNoRows(err, "user_not_found", "user not found")
	}
	return user, nil
}

func (s *ChatService) GetUserByUsername(ctx context.Context, username string) (User, error) {
	var user User
	err := s.db.GetContext(ctx, &user, `
select id, username, coalesce(display_name, '') as display_name, created_at::text, updated_at::text
from users where username = $1`, strings.ToLower(strings.TrimSpace(username)))
	if err != nil {
		return User{}, notFoundIfNoRows(err, "user_not_found", "user not found")
	}
	return user, nil
}

func (s *ChatService) CreateConversation(ctx context.Context, input CreateConversationInput) (Conversation, error) {
	if _, err := s.GetUser(ctx, input.CreatedByUserID); err != nil {
		return Conversation{}, err
	}
	conversationID := fmt.Sprintf("con_%d", time.Now().UnixNano())
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return Conversation{}, err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
insert into conversations (id, title, created_by_user_id)
values ($1, nullif($2, ''), $3)`, conversationID, strings.TrimSpace(input.Title), input.CreatedByUserID); err != nil {
		return Conversation{}, err
	}

	participantIDs := uniqueStrings(append([]string{input.CreatedByUserID}, input.ParticipantUserIDs...))
	for _, userID := range participantIDs {
		if _, err := s.GetUser(ctx, userID); err != nil {
			return Conversation{}, err
		}
		if _, err := tx.ExecContext(ctx, `
insert into conversation_participants (conversation_id, user_id)
values ($1, $2) on conflict do nothing`, conversationID, userID); err != nil {
			return Conversation{}, err
		}
	}

	if err := tx.Commit(); err != nil {
		return Conversation{}, err
	}
	return s.GetConversation(ctx, conversationID)
}

func (s *ChatService) GetConversation(ctx context.Context, conversationID string) (Conversation, error) {
	var conversation Conversation
	err := s.db.GetContext(ctx, &conversation, `
select id, coalesce(title, '') as title, created_by_user_id, created_at::text, updated_at::text
from conversations
where id = $1 and deleted_at is null`, conversationID)
	if err != nil {
		return Conversation{}, notFoundIfNoRows(err, "conversation_not_found", "conversation not found")
	}
	var participants []User
	if err := s.db.SelectContext(ctx, &participants, `
select u.id, u.username, coalesce(u.display_name, '') as display_name, u.created_at::text, u.updated_at::text
from conversation_participants cp
join users u on u.id = cp.user_id
where cp.conversation_id = $1
order by u.username asc`, conversationID); err != nil {
		return Conversation{}, err
	}
	conversation.Participants = participants
	return conversation, nil
}

func (s *ChatService) UpdateConversation(ctx context.Context, conversationID string, input UpdateConversationInput) (Conversation, error) {
	if _, err := s.GetConversation(ctx, conversationID); err != nil {
		return Conversation{}, err
	}
	if _, err := s.db.ExecContext(ctx, `
update conversations set title = nullif($2, ''), updated_at = now() where id = $1`, conversationID, strings.TrimSpace(input.Title)); err != nil {
		return Conversation{}, err
	}
	return s.GetConversation(ctx, conversationID)
}

func (s *ChatService) DeleteConversation(ctx context.Context, conversationID string) error {
	if _, err := s.GetConversation(ctx, conversationID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
update conversations set deleted_at = now(), updated_at = now() where id = $1`, conversationID)
	return err
}

func (s *ChatService) AddParticipant(ctx context.Context, conversationID string, userID string) (Conversation, error) {
	if _, err := s.GetConversation(ctx, conversationID); err != nil {
		return Conversation{}, err
	}
	if _, err := s.GetUser(ctx, userID); err != nil {
		return Conversation{}, err
	}
	if _, err := s.db.ExecContext(ctx, `
insert into conversation_participants (conversation_id, user_id)
values ($1, $2) on conflict do nothing`, conversationID, userID); err != nil {
		return Conversation{}, err
	}
	return s.GetConversation(ctx, conversationID)
}

func (s *ChatService) RemoveParticipant(ctx context.Context, conversationID string, userID string) error {
	_, err := s.db.ExecContext(ctx, `
delete from conversation_participants where conversation_id = $1 and user_id = $2`, conversationID, userID)
	return err
}

func (s *ChatService) ListMessages(ctx context.Context, conversationID string, input ListMessagesInput) (ListMessagesResult, error) {
	if _, err := s.GetConversation(ctx, conversationID); err != nil {
		return ListMessagesResult{}, err
	}
	limit, err := normalizeMessagePageSize(input.Limit)
	if err != nil {
		return ListMessagesResult{}, err
	}
	cursor, err := parseMessageCursor(input.Cursor)
	if err != nil {
		return ListMessagesResult{}, err
	}

	query := `
select id, conversation_id, user_id, body, coalesce(edited_at::text, '') as edited_at, created_at::text, updated_at::text
from messages
where conversation_id = $1 and deleted_at is null`
	args := []any{conversationID}
	if cursor != nil {
		query += `
  and (
    created_at < $2
    or (created_at = $2 and id < $3)
  )`
		args = append(args, cursor.CreatedAt, cursor.ID)
	}
	query += fmt.Sprintf(`
order by created_at desc, id desc
limit %d`, limit+1)

	var items []Message
	if err := s.db.SelectContext(ctx, &items, query, args...); err != nil {
		return ListMessagesResult{}, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	if err := s.attachMessageAttachments(ctx, items); err != nil {
		return ListMessagesResult{}, err
	}

	result := ListMessagesResult{Messages: items}
	if hasMore && len(items) > 0 {
		result.NextCursor = encodeMessageCursor(items[len(items)-1])
	}
	return result, nil
}

func (s *ChatService) CreateMessage(ctx context.Context, conversationID string, input CreateMessageInput) (Message, error) {
	conversation, err := s.GetConversation(ctx, conversationID)
	if err != nil {
		return Message{}, err
	}
	if !hasParticipant(conversation.Participants, input.UserID) {
		return Message{}, &AppError{Status: 409, Code: "not_a_participant", Err: errors.New("user is not a participant")}
	}
	body := strings.TrimSpace(input.Body)
	if body == "" {
		return Message{}, &AppError{Status: 400, Code: "invalid_body", Err: errors.New("message body is required")}
	}
	id := fmt.Sprintf("msg_%d", time.Now().UnixNano())
	var message Message
	err = s.db.GetContext(ctx, &message, `
insert into messages (id, conversation_id, user_id, body)
values ($1, $2, $3, $4)
returning id, conversation_id, user_id, body, coalesce(edited_at::text, '') as edited_at, created_at::text, updated_at::text
`, id, conversationID, input.UserID, body)
	return message, err
}

func (s *ChatService) UpdateMessage(ctx context.Context, conversationID string, messageID string, input UpdateMessageInput) (Message, error) {
	if _, err := s.GetConversation(ctx, conversationID); err != nil {
		return Message{}, err
	}
	body := strings.TrimSpace(input.Body)
	if body == "" {
		return Message{}, &AppError{Status: 400, Code: "invalid_body", Err: errors.New("message body is required")}
	}
	var message Message
	err := s.db.GetContext(ctx, &message, `
update messages
set body = $3, edited_at = now(), updated_at = now()
where id = $1 and conversation_id = $2 and deleted_at is null
returning id, conversation_id, user_id, body, coalesce(edited_at::text, '') as edited_at, created_at::text, updated_at::text
`, messageID, conversationID, body)
	if err != nil {
		return Message{}, notFoundIfNoRows(err, "message_not_found", "message not found")
	}
	return message, nil
}

func (s *ChatService) DeleteMessage(ctx context.Context, conversationID string, messageID string) error {
	_, err := s.db.ExecContext(ctx, `
update messages set deleted_at = now(), updated_at = now() where id = $1 and conversation_id = $2`, messageID, conversationID)
	return err
}

func (s *ChatService) CreateAttachmentUpload(ctx context.Context, input CreateAttachmentUploadInput) (CreateAttachmentUploadResult, error) {
	if _, err := s.GetConversation(ctx, input.ConversationID); err != nil {
		return CreateAttachmentUploadResult{}, err
	}
	if _, err := s.GetUser(ctx, input.UploadedByUserID); err != nil {
		return CreateAttachmentUploadResult{}, err
	}
	if !strings.HasPrefix(input.ContentType, "image/") {
		return CreateAttachmentUploadResult{}, &AppError{Status: 400, Code: "invalid_content_type", Err: errors.New("only image uploads are supported")}
	}
	id := fmt.Sprintf("att_%d", time.Now().UnixNano())
	bucket, key, upload, publicURL, err := s.storage.CreateSignedUpload(ctx, id, input.ConversationID, input.Filename, input.ContentType)
	if err != nil {
		return CreateAttachmentUploadResult{}, err
	}
	var attachment Attachment
	err = s.db.GetContext(ctx, &attachment, `
insert into attachments (id, conversation_id, uploaded_by_user_id, storage_bucket, storage_key, content_type, byte_size, filename, status)
values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
returning id, conversation_id, coalesce(message_id, '') as message_id, uploaded_by_user_id, storage_bucket, storage_key, content_type, byte_size, filename, status, created_at::text, updated_at::text
`, id, input.ConversationID, input.UploadedByUserID, bucket, key, input.ContentType, input.ByteSize, input.Filename)
	if err != nil {
		return CreateAttachmentUploadResult{}, err
	}
	attachment.PublicURL = publicURL
	return CreateAttachmentUploadResult{Attachment: attachment, Upload: upload}, nil
}

func (s *ChatService) GetAttachment(ctx context.Context, attachmentID string) (Attachment, error) {
	var attachment Attachment
	err := s.db.GetContext(ctx, &attachment, `
select id, conversation_id, coalesce(message_id, '') as message_id, uploaded_by_user_id, storage_bucket, storage_key, content_type, byte_size, filename, status, created_at::text, updated_at::text
from attachments where id = $1 and deleted_at is null`, attachmentID)
	if err != nil {
		return Attachment{}, notFoundIfNoRows(err, "attachment_not_found", "attachment not found")
	}
	_, _, publicURL, metaErr := s.storage.GetObjectMetadata(ctx, attachment.StorageBucket, attachment.StorageKey)
	if metaErr == nil {
		attachment.PublicURL = publicURL
	}
	return attachment, nil
}

func (s *ChatService) FinalizeAttachment(ctx context.Context, attachmentID string, input FinalizeAttachmentInput) (Attachment, error) {
	attachment, err := s.GetAttachment(ctx, attachmentID)
	if err != nil {
		return Attachment{}, err
	}
	if input.MessageID != "" {
		var exists int
		if err := s.db.GetContext(ctx, &exists, `select count(*) from messages where id = $1 and conversation_id = $2 and deleted_at is null`, input.MessageID, attachment.ConversationID); err != nil {
			return Attachment{}, err
		}
		if exists == 0 {
			return Attachment{}, &AppError{Status: 404, Code: "message_not_found", Err: errors.New("message not found")}
		}
	}
	contentType, byteSize, publicURL, err := s.storage.GetObjectMetadata(ctx, attachment.StorageBucket, attachment.StorageKey)
	if err != nil {
		return Attachment{}, err
	}
	if contentType != attachment.ContentType || byteSize != attachment.ByteSize {
		return Attachment{}, &AppError{Status: 409, Code: "attachment_mismatch", Err: errors.New("uploaded object metadata does not match pending attachment")}
	}
	var updated Attachment
	err = s.db.GetContext(ctx, &updated, `
update attachments
set message_id = nullif($2, ''), status = 'ready', updated_at = now()
where id = $1
returning id, conversation_id, coalesce(message_id, '') as message_id, uploaded_by_user_id, storage_bucket, storage_key, content_type, byte_size, filename, status, created_at::text, updated_at::text
`, attachmentID, input.MessageID)
	if err != nil {
		return Attachment{}, err
	}
	updated.PublicURL = publicURL
	return updated, nil
}

func (s *ChatService) DeleteAttachment(ctx context.Context, attachmentID string) error {
	_, err := s.db.ExecContext(ctx, `
update attachments set deleted_at = now(), status = 'deleted', updated_at = now() where id = $1`, attachmentID)
	return err
}

func (s *ChatService) ProcessWebhook(ctx context.Context, provider string, headers http.Header, rawBody []byte) (WebhookEvent, bool, error) {
	event, err := s.webhookAdapter.Normalize(provider, headers, rawBody)
	if err != nil {
		return WebhookEvent{}, false, err
	}
	var existing WebhookEvent
	err = s.db.GetContext(ctx, &existing, `
select id, provider, external_event_id, event_type, signature_valid = 'true' as signature_valid, status, payload_json, received_at::text, coalesce(processed_at::text, '') as processed_at
from webhook_events where provider = $1 and external_event_id = $2`, event.Provider, event.ExternalEventID)
	if err == nil {
		return existing, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return WebhookEvent{}, false, err
	}
	status := "processed"
	if !event.SignatureValid {
		status = "failed"
	}
	id := fmt.Sprintf("wh_%d", time.Now().UnixNano())
	var created WebhookEvent
	err = s.db.GetContext(ctx, &created, `
insert into webhook_events (id, provider, external_event_id, event_type, signature_valid, status, payload_json, processed_at)
values ($1, $2, $3, $4, $5, $6, $7, now())
returning id, provider, external_event_id, event_type, signature_valid = 'true' as signature_valid, status, payload_json, received_at::text, coalesce(processed_at::text, '') as processed_at
`, id, event.Provider, event.ExternalEventID, event.EventType, boolString(event.SignatureValid), status, event.PayloadJSON)
	return created, false, err
}

func (s *ChatService) attachMessageAttachments(ctx context.Context, messages []Message) error {
	if len(messages) == 0 {
		return nil
	}

	messageIDs := make([]string, 0, len(messages))
	messageIndex := make(map[string]*Message, len(messages))
	for index := range messages {
		messageIDs = append(messageIDs, messages[index].ID)
		messageIndex[messages[index].ID] = &messages[index]
	}

	query, args, err := sqlx.In(`
select id, message_id, filename, content_type, byte_size, status, storage_bucket, storage_key
from attachments
where message_id in (?) and status = 'ready' and deleted_at is null
order by created_at asc, id asc`, messageIDs)
	if err != nil {
		return err
	}
	query = s.db.Rebind(query)

	var rows []struct {
		ID            string `db:"id"`
		MessageID     string `db:"message_id"`
		Filename      string `db:"filename"`
		ContentType   string `db:"content_type"`
		ByteSize      int64  `db:"byte_size"`
		Status        string `db:"status"`
		StorageBucket string `db:"storage_bucket"`
		StorageKey    string `db:"storage_key"`
	}
	if err := s.db.SelectContext(ctx, &rows, query, args...); err != nil {
		return err
	}

	for _, row := range rows {
		message := messageIndex[row.MessageID]
		if message == nil {
			continue
		}
		message.Attachments = append(message.Attachments, MessageAttachment{
			ID:          row.ID,
			Filename:    row.Filename,
			ContentType: row.ContentType,
			ByteSize:    row.ByteSize,
			Status:      row.Status,
			PublicURL:   buildAttachmentPublicURL(row.StorageBucket, row.StorageKey),
		})
	}

	return nil
}

const defaultMessagePageSize = 50
const maxMessagePageSize = 100

func normalizeMessagePageSize(limit int) (int, error) {
	if limit == 0 {
		return defaultMessagePageSize, nil
	}
	if limit < 0 {
		return 0, &AppError{Status: 400, Code: "invalid_limit", Err: errors.New("limit must be a positive integer")}
	}
	if limit > maxMessagePageSize {
		return 0, &AppError{Status: 400, Code: "invalid_limit", Err: fmt.Errorf("limit must be at most %d", maxMessagePageSize)}
	}
	return limit, nil
}

type messageCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        string    `json:"id"`
}

func parseMessageCursor(raw string) (*messageCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, &AppError{Status: 400, Code: "invalid_cursor", Err: errors.New("cursor is invalid")}
	}

	var cursor struct {
		CreatedAt string `json:"createdAt"`
		ID        string `json:"id"`
	}
	if err := json.Unmarshal(decoded, &cursor); err != nil {
		return nil, &AppError{Status: 400, Code: "invalid_cursor", Err: errors.New("cursor is invalid")}
	}
	if strings.TrimSpace(cursor.CreatedAt) == "" || strings.TrimSpace(cursor.ID) == "" {
		return nil, &AppError{Status: 400, Code: "invalid_cursor", Err: errors.New("cursor is invalid")}
	}
	createdAt, err := parseCursorTime(cursor.CreatedAt)
	if err != nil {
		return nil, &AppError{Status: 400, Code: "invalid_cursor", Err: errors.New("cursor is invalid")}
	}
	return &messageCursor{CreatedAt: createdAt, ID: cursor.ID}, nil
}

func encodeMessageCursor(message Message) string {
	payload, _ := json.Marshal(map[string]string{
		"createdAt": message.CreatedAt,
		"id":        message.ID,
	})
	return base64.RawURLEncoding.EncodeToString(payload)
}

func buildAttachmentPublicURL(bucket string, key string) string {
	base := strings.TrimSpace(os.Getenv("ATTACHMENT_PUBLIC_BASE_URL"))
	if base == "" {
		base = "https://storage.googleapis.com/" + bucket
	}
	return strings.TrimRight(base, "/") + "/" + key
}

func parseCursorTime(value string) (time.Time, error) {
	layouts := []string{
		time.RFC3339Nano,
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05.999999999Z07",
		"2006-01-02 15:04:05Z07:00",
		"2006-01-02 15:04:05Z07",
	}
	for _, layout := range layouts {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid cursor time: %s", value)
}

func boolString(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func notFoundIfNoRows(err error, code string, message string) error {
	if errors.Is(err, sql.ErrNoRows) {
		return &AppError{Status: 404, Code: code, Err: errors.New(message)}
	}
	return err
}

func hasParticipant(participants []User, userID string) bool {
	for _, participant := range participants {
		if participant.ID == userID {
			return true
		}
	}
	return false
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func sanitizeFilename(filename string) string {
	filename = strings.TrimSpace(filename)
	if filename == "" {
		return "upload.bin"
	}
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= 'A' && r <= 'Z':
			return r
		case r >= '0' && r <= '9':
			return r
		case r == '.', r == '-', r == '_':
			return r
		default:
			return '-'
		}
	}, filename)
}
