package connectapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"connectrpc.com/connect"
	_ "github.com/jackc/pgx/v5/stdlib"

	waitlistv1 "{{MODULE_PATH}}/gen/waitlist/v1"
	waitlistv1connect "{{MODULE_PATH}}/gen/waitlist/v1/waitlistv1connect"
	"{{MODULE_PATH}}/internal/app"
)

func TestWaitlistRPCJoinIsIdempotentAndRecordsTriggers(t *testing.T) {
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
	path, handler := NewHandler(service)
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	client := waitlistv1connect.NewWaitlistServiceClient(http.DefaultClient, server.URL)

	first, err := client.JoinWaitlist(context.Background(), connect.NewRequest(&waitlistv1.JoinWaitlistRequest{
		Email:   "Founder@Example.com",
		Name:    "Founder",
		Company: "Example Co",
		Source:  "homepage",
	}))
	if err != nil {
		t.Fatalf("join waitlist: %v", err)
	}
	if !first.Msg.GetCreated() {
		t.Fatal("expected first join to create entry")
	}
	if first.Msg.GetEntry().GetEmail() != "founder@example.com" {
		t.Fatalf("expected normalized email, got %s", first.Msg.GetEntry().GetEmail())
	}

	second, err := client.JoinWaitlist(context.Background(), connect.NewRequest(&waitlistv1.JoinWaitlistRequest{
		Email: "founder@example.com",
	}))
	if err != nil {
		t.Fatalf("join waitlist again: %v", err)
	}
	if second.Msg.GetCreated() {
		t.Fatal("expected second join to be idempotent")
	}
	if second.Msg.GetEntry().GetId() != first.Msg.GetEntry().GetId() {
		t.Fatalf("expected same entry id, got %s and %s", first.Msg.GetEntry().GetId(), second.Msg.GetEntry().GetId())
	}

	trigger, err := client.RecordTrigger(context.Background(), connect.NewRequest(&waitlistv1.RecordTriggerRequest{
		Type:        "cron.digest",
		EntryId:     first.Msg.GetEntry().GetId(),
		PayloadJson: "{}",
	}))
	if err != nil {
		t.Fatalf("record trigger: %v", err)
	}
	if trigger.Msg.GetTrigger().GetType() != "cron.digest" {
		t.Fatalf("expected cron.digest trigger, got %s", trigger.Msg.GetTrigger().GetType())
	}
	if trigger.Msg.GetTrigger().GetEntryId() != first.Msg.GetEntry().GetId() {
		t.Fatalf("expected entry id %s, got %s", first.Msg.GetEntry().GetId(), trigger.Msg.GetTrigger().GetEntryId())
	}

	updated, err := client.UpdateWaitlistEntry(context.Background(), connect.NewRequest(&waitlistv1.UpdateWaitlistEntryRequest{
		EntryId: first.Msg.GetEntry().GetId(),
		Status:  "invited",
	}))
	if err != nil {
		t.Fatalf("update waitlist entry: %v", err)
	}
	if updated.Msg.GetEntry().GetStatus() != "invited" {
		t.Fatalf("expected invited status, got %s", updated.Msg.GetEntry().GetStatus())
	}

	list, err := client.ListWaitlistEntries(context.Background(), connect.NewRequest(&waitlistv1.ListWaitlistEntriesRequest{
		Status: "invited",
	}))
	if err != nil {
		t.Fatalf("list waitlist entries: %v", err)
	}
	if len(list.Msg.GetEntries()) != 1 || list.Msg.GetEntries()[0].GetId() != first.Msg.GetEntry().GetId() {
		t.Fatalf("expected one invited entry %s, got %+v", first.Msg.GetEntry().GetId(), list.Msg.GetEntries())
	}

	exported, err := client.ExportWaitlistEntries(context.Background(), connect.NewRequest(&waitlistv1.ExportWaitlistEntriesRequest{
		Status: "invited",
	}))
	if err != nil {
		t.Fatalf("export waitlist entries: %v", err)
	}
	if !strings.Contains(exported.Msg.GetCsv(), "founder@example.com") {
		t.Fatalf("expected exported csv to contain email, got %s", exported.Msg.GetCsv())
	}
}
