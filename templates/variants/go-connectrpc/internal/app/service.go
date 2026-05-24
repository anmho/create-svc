package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

type WaitlistEntry struct {
	ID        string `json:"id" db:"id"`
	Email     string `json:"email" db:"email"`
	Name      string `json:"name,omitempty" db:"name"`
	Company   string `json:"company,omitempty" db:"company"`
	Source    string `json:"source,omitempty" db:"source"`
	Status    string `json:"status" db:"status"`
	CreatedAt string `json:"created_at" db:"created_at"`
	UpdatedAt string `json:"updated_at" db:"updated_at"`
}

type WaitlistTrigger struct {
	ID          string `json:"id" db:"id"`
	Type        string `json:"type" db:"type"`
	EntryID     string `json:"entry_id,omitempty" db:"entry_id"`
	Status      string `json:"status" db:"status"`
	Payload     any    `json:"payload"`
	CreatedAt   string `json:"created_at" db:"created_at"`
	ProcessedAt string `json:"processed_at,omitempty" db:"processed_at"`
}

type WebhookEvent struct {
	ID              string         `json:"id" db:"id"`
	Provider        string         `json:"provider" db:"provider"`
	ExternalEventID string         `json:"external_event_id" db:"external_event_id"`
	Payload         map[string]any `json:"payload"`
	Headers         map[string]any `json:"headers"`
	ReceivedAt      string         `json:"received_at" db:"received_at"`
}

type JoinWaitlistInput struct {
	Email   string `json:"email"`
	Name    string `json:"name"`
	Company string `json:"company"`
	Source  string `json:"source"`
}

type JoinWaitlistResult struct {
	Entry   WaitlistEntry `json:"entry"`
	Created bool          `json:"created"`
}

type RecordTriggerInput struct {
	Type    string `json:"type"`
	EntryID string `json:"entry_id"`
	Payload any    `json:"payload"`
}

type RecordWebhookEventInput struct {
	Provider        string         `json:"provider"`
	ExternalEventID string         `json:"external_event_id"`
	Payload         map[string]any `json:"payload"`
	Headers         map[string]any `json:"headers"`
}

type RecordWebhookEventResult struct {
	Event     WebhookEvent `json:"event"`
	Duplicate bool         `json:"duplicate"`
}

type ListWaitlistEntriesInput struct {
	Status string `json:"status"`
	Limit  int    `json:"limit"`
}

type UpdateWaitlistEntryInput struct {
	EntryID string `json:"entry_id"`
	Status  string `json:"status"`
}

type AppError struct {
	Status int
	Code   string
	Err    error
}

func (e *AppError) Error() string { return e.Err.Error() }

type WaitlistService struct {
	db *sqlx.DB
}

func OpenDatabase(ctx context.Context, databaseURL string) (*sqlx.DB, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, errors.New("DATABASE_URL is required")
	}
	return sqlx.ConnectContext(ctx, "pgx", databaseURL)
}

func NewWaitlistService(db *sqlx.DB) *WaitlistService {
	return &WaitlistService{db: db}
}

func (s *WaitlistService) JoinWaitlist(ctx context.Context, input JoinWaitlistInput) (JoinWaitlistResult, error) {
	email, err := normalizeEmail(input.Email)
	if err != nil {
		return JoinWaitlistResult{}, err
	}

	existing, err := s.GetEntryByEmail(ctx, email)
	if err == nil {
		return JoinWaitlistResult{Entry: existing, Created: false}, nil
	}
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Code != "entry_not_found" {
		return JoinWaitlistResult{}, err
	}

	id := fmt.Sprintf("entry_%d", time.Now().UnixNano())
	var entry WaitlistEntry
	err = s.db.GetContext(ctx, &entry, `
insert into waitlist_entries (id, email, name, company, source, status)
values ($1, $2, nullif($3, ''), nullif($4, ''), nullif($5, ''), 'joined')
returning id, email, coalesce(name, '') as name, coalesce(company, '') as company, coalesce(source, '') as source, status, created_at::text, updated_at::text
`, id, email, strings.TrimSpace(input.Name), strings.TrimSpace(input.Company), strings.TrimSpace(input.Source))
	if err != nil {
		return JoinWaitlistResult{}, err
	}

	if _, err := s.RecordTrigger(ctx, RecordTriggerInput{
		Type:    "waitlist.joined",
		EntryID: entry.ID,
		Payload: map[string]any{"email": entry.Email, "source": entry.Source},
	}); err != nil {
		return JoinWaitlistResult{}, err
	}

	return JoinWaitlistResult{Entry: entry, Created: true}, nil
}

func (s *WaitlistService) GetEntry(ctx context.Context, entryID string) (WaitlistEntry, error) {
	var entry WaitlistEntry
	err := s.db.GetContext(ctx, &entry, `
select id, email, coalesce(name, '') as name, coalesce(company, '') as company, coalesce(source, '') as source, status, created_at::text, updated_at::text
from waitlist_entries
where id = $1`, strings.TrimSpace(entryID))
	if err != nil {
		return WaitlistEntry{}, notFoundIfNoRows(err, "entry_not_found", "waitlist entry not found")
	}
	return entry, nil
}

func (s *WaitlistService) GetEntryByEmail(ctx context.Context, rawEmail string) (WaitlistEntry, error) {
	email, err := normalizeEmail(rawEmail)
	if err != nil {
		return WaitlistEntry{}, err
	}
	var entry WaitlistEntry
	err = s.db.GetContext(ctx, &entry, `
select id, email, coalesce(name, '') as name, coalesce(company, '') as company, coalesce(source, '') as source, status, created_at::text, updated_at::text
from waitlist_entries
where email = $1`, email)
	if err != nil {
		return WaitlistEntry{}, notFoundIfNoRows(err, "entry_not_found", "waitlist entry not found")
	}
	return entry, nil
}

func (s *WaitlistService) ListEntries(ctx context.Context, input ListWaitlistEntriesInput) ([]WaitlistEntry, error) {
	limit := clampLimit(input.Limit)
	status := strings.TrimSpace(input.Status)
	var entries []WaitlistEntry
	var err error
	if status != "" {
		status, err = normalizeStatus(status)
		if err != nil {
			return nil, err
		}
		err = s.db.SelectContext(ctx, &entries, `
select id, email, coalesce(name, '') as name, coalesce(company, '') as company, coalesce(source, '') as source, status, created_at::text, updated_at::text
from waitlist_entries
where status = $1
order by created_at desc
limit $2`, status, limit)
	} else {
		err = s.db.SelectContext(ctx, &entries, `
select id, email, coalesce(name, '') as name, coalesce(company, '') as company, coalesce(source, '') as source, status, created_at::text, updated_at::text
from waitlist_entries
order by created_at desc
limit $1`, limit)
	}
	if err != nil {
		return nil, err
	}
	return entries, nil
}

func (s *WaitlistService) UpdateEntry(ctx context.Context, input UpdateWaitlistEntryInput) (WaitlistEntry, error) {
	entryID := strings.TrimSpace(input.EntryID)
	if entryID == "" {
		return WaitlistEntry{}, &AppError{Status: 400, Code: "invalid_entry_id", Err: errors.New("entry id is required")}
	}
	status, err := normalizeStatus(input.Status)
	if err != nil {
		return WaitlistEntry{}, err
	}
	var entry WaitlistEntry
	err = s.db.GetContext(ctx, &entry, `
update waitlist_entries
set status = $2, updated_at = now()
where id = $1
returning id, email, coalesce(name, '') as name, coalesce(company, '') as company, coalesce(source, '') as source, status, created_at::text, updated_at::text
`, entryID, status)
	if err != nil {
		return WaitlistEntry{}, notFoundIfNoRows(err, "entry_not_found", "waitlist entry not found")
	}
	return entry, nil
}

func (s *WaitlistService) ExportEntries(ctx context.Context, input ListWaitlistEntriesInput) (string, error) {
	entries, err := s.ListEntries(ctx, input)
	if err != nil {
		return "", err
	}
	var buffer bytes.Buffer
	writer := csv.NewWriter(&buffer)
	_ = writer.Write([]string{"id", "email", "name", "company", "source", "status", "created_at", "updated_at"})
	for _, entry := range entries {
		_ = writer.Write([]string{entry.ID, entry.Email, entry.Name, entry.Company, entry.Source, entry.Status, entry.CreatedAt, entry.UpdatedAt})
	}
	writer.Flush()
	return buffer.String(), writer.Error()
}

func (s *WaitlistService) RecordTrigger(ctx context.Context, input RecordTriggerInput) (WaitlistTrigger, error) {
	triggerType := strings.TrimSpace(input.Type)
	if triggerType == "" {
		return WaitlistTrigger{}, &AppError{Status: 400, Code: "invalid_trigger_type", Err: errors.New("trigger type is required")}
	}

	entryID := strings.TrimSpace(input.EntryID)
	if entryID != "" {
		if _, err := s.GetEntry(ctx, entryID); err != nil {
			return WaitlistTrigger{}, err
		}
	}

	payloadBytes, err := json.Marshal(input.Payload)
	if err != nil {
		return WaitlistTrigger{}, err
	}
	if string(payloadBytes) == "null" {
		payloadBytes = []byte("{}")
	}

	id := fmt.Sprintf("trg_%d", time.Now().UnixNano())
	var row waitlistTriggerRow
	err = s.db.GetContext(ctx, &row, `
insert into waitlist_triggers (id, type, entry_id, status, payload_json)
values ($1, $2, nullif($3, ''), 'queued', $4)
returning id, type, coalesce(entry_id, '') as entry_id, status, payload_json, created_at::text, coalesce(processed_at::text, '') as processed_at
`, id, triggerType, entryID, string(payloadBytes))
	if err != nil {
		return WaitlistTrigger{}, err
	}
	return row.toTrigger()
}

func (s *WaitlistService) RecordWebhookEvent(ctx context.Context, input RecordWebhookEventInput) (RecordWebhookEventResult, error) {
	provider := strings.TrimSpace(input.Provider)
	if provider == "" {
		return RecordWebhookEventResult{}, &AppError{Status: 400, Code: "invalid_webhook_provider", Err: errors.New("webhook provider is required")}
	}
	externalEventID := strings.TrimSpace(input.ExternalEventID)
	if externalEventID == "" {
		return RecordWebhookEventResult{}, &AppError{Status: 400, Code: "invalid_webhook_event_id", Err: errors.New("webhook event id is required")}
	}

	payloadBytes, err := json.Marshal(input.Payload)
	if err != nil {
		return RecordWebhookEventResult{}, err
	}
	headersBytes, err := json.Marshal(input.Headers)
	if err != nil {
		return RecordWebhookEventResult{}, err
	}

	id := fmt.Sprintf("wh_%d", time.Now().UnixNano())
	var row webhookEventRow
	err = s.db.GetContext(ctx, &row, `
insert into webhook_events (id, provider, external_event_id, payload_json, headers_json)
values ($1, $2, $3, $4, $5)
on conflict (provider, external_event_id) do nothing
returning id, provider, external_event_id, payload_json, headers_json, received_at::text
`, id, provider, externalEventID, string(payloadBytes), string(headersBytes))
	if err == nil {
		event, err := row.toWebhookEvent()
		return RecordWebhookEventResult{Event: event, Duplicate: false}, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return RecordWebhookEventResult{}, err
	}

	err = s.db.GetContext(ctx, &row, `
select id, provider, external_event_id, payload_json, headers_json, received_at::text
from webhook_events
where provider = $1 and external_event_id = $2
`, provider, externalEventID)
	if err != nil {
		return RecordWebhookEventResult{}, err
	}
	event, err := row.toWebhookEvent()
	return RecordWebhookEventResult{Event: event, Duplicate: true}, err
}

type waitlistTriggerRow struct {
	ID          string `db:"id"`
	Type        string `db:"type"`
	EntryID     string `db:"entry_id"`
	Status      string `db:"status"`
	PayloadJSON string `db:"payload_json"`
	CreatedAt   string `db:"created_at"`
	ProcessedAt string `db:"processed_at"`
}

type webhookEventRow struct {
	ID              string `db:"id"`
	Provider        string `db:"provider"`
	ExternalEventID string `db:"external_event_id"`
	PayloadJSON     string `db:"payload_json"`
	HeadersJSON     string `db:"headers_json"`
	ReceivedAt      string `db:"received_at"`
}

func (r webhookEventRow) toWebhookEvent() (WebhookEvent, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(r.PayloadJSON), &payload); err != nil {
		return WebhookEvent{}, err
	}
	var headers map[string]any
	if err := json.Unmarshal([]byte(r.HeadersJSON), &headers); err != nil {
		return WebhookEvent{}, err
	}
	return WebhookEvent{
		ID:              r.ID,
		Provider:        r.Provider,
		ExternalEventID: r.ExternalEventID,
		Payload:         payload,
		Headers:         headers,
		ReceivedAt:      r.ReceivedAt,
	}, nil
}

func (r waitlistTriggerRow) toTrigger() (WaitlistTrigger, error) {
	var payload any
	if err := json.Unmarshal([]byte(r.PayloadJSON), &payload); err != nil {
		return WaitlistTrigger{}, err
	}
	return WaitlistTrigger{
		ID:          r.ID,
		Type:        r.Type,
		EntryID:     r.EntryID,
		Status:      r.Status,
		Payload:     payload,
		CreatedAt:   r.CreatedAt,
		ProcessedAt: r.ProcessedAt,
	}, nil
}

func normalizeEmail(value string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(value))
	if email == "" {
		return "", &AppError{Status: 400, Code: "invalid_email", Err: errors.New("valid email is required")}
	}
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email {
		return "", &AppError{Status: 400, Code: "invalid_email", Err: errors.New("valid email is required")}
	}
	return email, nil
}

func normalizeStatus(value string) (string, error) {
	status := strings.ToLower(strings.TrimSpace(value))
	switch status {
	case "joined", "invited", "converted", "archived":
		return status, nil
	default:
		return "", &AppError{Status: 400, Code: "invalid_status", Err: errors.New("status must be one of joined, invited, converted, archived")}
	}
}

func clampLimit(value int) int {
	if value <= 0 {
		return 100
	}
	if value > 500 {
		return 500
	}
	return value
}

func notFoundIfNoRows(err error, code string, message string) error {
	if errors.Is(err, sql.ErrNoRows) {
		return &AppError{Status: 404, Code: code, Err: errors.New(message)}
	}
	return err
}
