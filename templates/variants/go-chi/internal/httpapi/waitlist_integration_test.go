package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	_ "github.com/jackc/pgx/v5/stdlib"

	"{{MODULE_PATH}}/internal/app"
)

func TestWaitlistJoinIsIdempotentAndRecordsTriggers(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL is required for integration test")
	}

	db, err := app.OpenDatabase(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if _, err := db.ExecContext(context.Background(), `
truncate table
  waitlist_triggers,
  waitlist_entries
restart identity cascade`); err != nil {
		t.Fatalf("truncate tables: %v", err)
	}

	service := app.NewWaitlistService(db)
	router := chi.NewRouter()
	RegisterRoutes(router, service)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	first := joinWaitlist(t, server.URL, "Founder@Example.com")
	if first.Created != true {
		t.Fatal("expected first join to create entry")
	}
	if first.Entry.Email != "founder@example.com" {
		t.Fatalf("expected normalized email, got %s", first.Entry.Email)
	}

	second := joinWaitlist(t, server.URL, "founder@example.com")
	if second.Created {
		t.Fatal("expected second join to be idempotent")
	}
	if second.Entry.ID != first.Entry.ID {
		t.Fatalf("expected same entry id, got %s and %s", first.Entry.ID, second.Entry.ID)
	}

	trigger := recordTrigger(t, server.URL, first.Entry.ID)
	if trigger.Trigger.Type != "cron.digest" {
		t.Fatalf("expected cron.digest trigger, got %s", trigger.Trigger.Type)
	}
	if trigger.Trigger.EntryID != first.Entry.ID {
		t.Fatalf("expected trigger entry id %s, got %s", first.Entry.ID, trigger.Trigger.EntryID)
	}

	updated := updateEntry(t, server.URL, first.Entry.ID, "invited")
	if updated.Entry.Status != "invited" {
		t.Fatalf("expected invited status, got %s", updated.Entry.Status)
	}

	list := listEntries(t, server.URL, "invited")
	if len(list.Entries) != 1 || list.Entries[0].ID != first.Entry.ID {
		t.Fatalf("expected one invited entry %s, got %+v", first.Entry.ID, list.Entries)
	}

	exported := exportEntries(t, server.URL, "invited")
	if !strings.Contains(exported, "founder@example.com") {
		t.Fatalf("expected exported csv to contain email, got %s", exported)
	}
}

type joinResponse struct {
	Entry   app.WaitlistEntry `json:"entry"`
	Created bool              `json:"created"`
}

type triggerResponse struct {
	Trigger app.WaitlistTrigger `json:"trigger"`
}

type entryResponse struct {
	Entry app.WaitlistEntry `json:"entry"`
}

type listResponse struct {
	Entries []app.WaitlistEntry `json:"entries"`
}

func joinWaitlist(t *testing.T, baseURL string, email string) joinResponse {
	t.Helper()
	body := bytes.NewBufferString(`{"email":` + quoteJSON(email) + `,"name":"Founder","company":"Example Co","source":"homepage"}`)
	response, err := http.Post(baseURL+"/v1/waitlist", "application/json", body)
	if err != nil {
		t.Fatalf("join waitlist: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusOK {
		t.Fatalf("expected success, got %d", response.StatusCode)
	}
	var payload joinResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode join response: %v", err)
	}
	return payload
}

func recordTrigger(t *testing.T, baseURL string, entryID string) triggerResponse {
	t.Helper()
	body := bytes.NewBufferString(`{"type":"cron.digest","entry_id":` + quoteJSON(entryID) + `}`)
	response, err := http.Post(baseURL+"/v1/triggers/waitlist", "application/json", body)
	if err != nil {
		t.Fatalf("record trigger: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", response.StatusCode)
	}
	var payload triggerResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode trigger response: %v", err)
	}
	return payload
}

func updateEntry(t *testing.T, baseURL string, entryID string, status string) entryResponse {
	t.Helper()
	body := bytes.NewBufferString(`{"status":` + quoteJSON(status) + `}`)
	request, err := http.NewRequest(http.MethodPatch, baseURL+"/v1/admin/waitlist/"+entryID, body)
	if err != nil {
		t.Fatalf("build update entry request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("update entry: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.StatusCode)
	}
	var payload entryResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode update response: %v", err)
	}
	return payload
}

func listEntries(t *testing.T, baseURL string, status string) listResponse {
	t.Helper()
	response, err := http.Get(baseURL + "/v1/admin/waitlist?status=" + status)
	if err != nil {
		t.Fatalf("list entries: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.StatusCode)
	}
	var payload listResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	return payload
}

func exportEntries(t *testing.T, baseURL string, status string) string {
	t.Helper()
	response, err := http.Get(baseURL + "/v1/admin/waitlist/export?status=" + status)
	if err != nil {
		t.Fatalf("export entries: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.StatusCode)
	}
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read export response: %v", err)
	}
	return string(raw)
}

func quoteJSON(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
