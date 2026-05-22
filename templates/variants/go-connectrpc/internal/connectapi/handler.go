package connectapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"connectrpc.com/connect"

	waitlistv1 "{{MODULE_PATH}}/gen/waitlist/v1"
	waitlistv1connect "{{MODULE_PATH}}/gen/waitlist/v1/waitlistv1connect"
	"{{MODULE_PATH}}/internal/app"
)

type Handler struct {
	service *app.WaitlistService
}

func NewHandler(service *app.WaitlistService) (string, http.Handler) {
	return waitlistv1connect.NewWaitlistServiceHandler(&Handler{service: service})
}

func (h *Handler) JoinWaitlist(ctx context.Context, request *connect.Request[waitlistv1.JoinWaitlistRequest]) (*connect.Response[waitlistv1.JoinWaitlistResponse], error) {
	result, err := h.service.JoinWaitlist(ctx, app.JoinWaitlistInput{
		Email:   request.Msg.GetEmail(),
		Name:    request.Msg.GetName(),
		Company: request.Msg.GetCompany(),
		Source:  request.Msg.GetSource(),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&waitlistv1.JoinWaitlistResponse{
		Entry:   toProtoEntry(result.Entry),
		Created: result.Created,
	}), nil
}

func (h *Handler) GetWaitlistEntry(ctx context.Context, request *connect.Request[waitlistv1.GetWaitlistEntryRequest]) (*connect.Response[waitlistv1.GetWaitlistEntryResponse], error) {
	entry, err := h.service.GetEntry(ctx, request.Msg.GetEntryId())
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&waitlistv1.GetWaitlistEntryResponse{Entry: toProtoEntry(entry)}), nil
}

func (h *Handler) GetWaitlistEntryByEmail(ctx context.Context, request *connect.Request[waitlistv1.GetWaitlistEntryByEmailRequest]) (*connect.Response[waitlistv1.GetWaitlistEntryResponse], error) {
	entry, err := h.service.GetEntryByEmail(ctx, request.Msg.GetEmail())
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&waitlistv1.GetWaitlistEntryResponse{Entry: toProtoEntry(entry)}), nil
}

func (h *Handler) ListWaitlistEntries(ctx context.Context, request *connect.Request[waitlistv1.ListWaitlistEntriesRequest]) (*connect.Response[waitlistv1.ListWaitlistEntriesResponse], error) {
	entries, err := h.service.ListEntries(ctx, app.ListWaitlistEntriesInput{
		Status: request.Msg.GetStatus(),
		Limit:  int(request.Msg.GetLimit()),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	response := &waitlistv1.ListWaitlistEntriesResponse{Entries: make([]*waitlistv1.WaitlistEntry, 0, len(entries))}
	for _, entry := range entries {
		response.Entries = append(response.Entries, toProtoEntry(entry))
	}
	return connect.NewResponse(response), nil
}

func (h *Handler) UpdateWaitlistEntry(ctx context.Context, request *connect.Request[waitlistv1.UpdateWaitlistEntryRequest]) (*connect.Response[waitlistv1.GetWaitlistEntryResponse], error) {
	entry, err := h.service.UpdateEntry(ctx, app.UpdateWaitlistEntryInput{
		EntryID: request.Msg.GetEntryId(),
		Status:  request.Msg.GetStatus(),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&waitlistv1.GetWaitlistEntryResponse{Entry: toProtoEntry(entry)}), nil
}

func (h *Handler) ExportWaitlistEntries(ctx context.Context, request *connect.Request[waitlistv1.ExportWaitlistEntriesRequest]) (*connect.Response[waitlistv1.ExportWaitlistEntriesResponse], error) {
	csv, err := h.service.ExportEntries(ctx, app.ListWaitlistEntriesInput{
		Status: request.Msg.GetStatus(),
		Limit:  int(request.Msg.GetLimit()),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&waitlistv1.ExportWaitlistEntriesResponse{Csv: csv}), nil
}

func (h *Handler) RecordTrigger(ctx context.Context, request *connect.Request[waitlistv1.RecordTriggerRequest]) (*connect.Response[waitlistv1.RecordTriggerResponse], error) {
	trigger, err := h.service.RecordTrigger(ctx, app.RecordTriggerInput{
		Type:    request.Msg.GetType(),
		EntryID: request.Msg.GetEntryId(),
		Payload: jsonPayload(request.Msg.GetPayloadJson()),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&waitlistv1.RecordTriggerResponse{Trigger: toProtoTrigger(trigger)}), nil
}

func toConnectError(err error) error {
	var appErr *app.AppError
	if errors.As(err, &appErr) {
		return connect.NewError(statusCodeToConnectCode(appErr.Status), err)
	}
	return connect.NewError(connect.CodeInternal, err)
}

func statusCodeToConnectCode(status int) connect.Code {
	switch status {
	case 400:
		return connect.CodeInvalidArgument
	case 404:
		return connect.CodeNotFound
	case 409:
		return connect.CodeAlreadyExists
	default:
		return connect.CodeInternal
	}
}

func toProtoEntry(entry app.WaitlistEntry) *waitlistv1.WaitlistEntry {
	return &waitlistv1.WaitlistEntry{
		Id:        entry.ID,
		Email:     entry.Email,
		Name:      entry.Name,
		Company:   entry.Company,
		Source:    entry.Source,
		Status:    entry.Status,
		CreatedAt: entry.CreatedAt,
		UpdatedAt: entry.UpdatedAt,
	}
}

func toProtoTrigger(trigger app.WaitlistTrigger) *waitlistv1.WaitlistTrigger {
	return &waitlistv1.WaitlistTrigger{
		Id:          trigger.ID,
		Type:        trigger.Type,
		EntryId:     trigger.EntryID,
		Status:      trigger.Status,
		PayloadJson: payloadToJSON(trigger.Payload),
		CreatedAt:   trigger.CreatedAt,
		ProcessedAt: trigger.ProcessedAt,
	}
}

func jsonPayload(value string) any {
	if value == "" {
		return map[string]any{}
	}
	var payload any
	if err := json.Unmarshal([]byte(value), &payload); err != nil {
		return map[string]any{}
	}
	return payload
}

func payloadToJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}
