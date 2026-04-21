package connectapi

import (
	"context"
	"net/http"

	"connectrpc.com/connect"

	dnsv1 "{{MODULE_PATH}}/gen/dns/v1"
	dnsv1connect "{{MODULE_PATH}}/gen/dns/v1/dnsv1connect"
	"{{MODULE_PATH}}/internal/app"
)

type Handler struct {
	service *app.DNSService
}

func NewHandler(service *app.DNSService) (string, http.Handler) {
	return dnsv1connect.NewDNSServiceHandler(&Handler{service: service})
}

func (h *Handler) ListRecords(ctx context.Context, _ *connect.Request[dnsv1.ListRecordsRequest]) (*connect.Response[dnsv1.ListRecordsResponse], error) {
	records, err := h.service.ListRecords(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	response := &dnsv1.ListRecordsResponse{Records: make([]*dnsv1.Record, 0, len(records))}
	for _, record := range records {
		response.Records = append(response.Records, toProtoRecord(record))
	}
	return connect.NewResponse(response), nil
}

func (h *Handler) CreateRecord(ctx context.Context, request *connect.Request[dnsv1.CreateRecordRequest]) (*connect.Response[dnsv1.CreateRecordResponse], error) {
	record, err := h.service.CreateRecord(ctx, app.CreateRecordInput{
		Type:    request.Msg.GetType(),
		Name:    request.Msg.GetName(),
		Content: request.Msg.GetContent(),
		TTL:     int(request.Msg.GetTtl()),
		Proxied: request.Msg.GetProxied(),
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&dnsv1.CreateRecordResponse{Record: toProtoRecord(record)}), nil
}

func (h *Handler) UpdateRecord(ctx context.Context, request *connect.Request[dnsv1.UpdateRecordRequest]) (*connect.Response[dnsv1.UpdateRecordResponse], error) {
	record, err := h.service.UpdateRecord(ctx, request.Msg.GetId(), app.UpdateRecordInput{
		Type:    request.Msg.GetType(),
		Name:    request.Msg.GetName(),
		Content: request.Msg.GetContent(),
		TTL:     int(request.Msg.GetTtl()),
		Proxied: request.Msg.GetProxied(),
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&dnsv1.UpdateRecordResponse{Record: toProtoRecord(record)}), nil
}

func (h *Handler) DeleteRecord(ctx context.Context, request *connect.Request[dnsv1.DeleteRecordRequest]) (*connect.Response[dnsv1.DeleteRecordResponse], error) {
	if err := h.service.DeleteRecord(ctx, request.Msg.GetId()); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&dnsv1.DeleteRecordResponse{}), nil
}

func toProtoRecord(record app.Record) *dnsv1.Record {
	return &dnsv1.Record{
		Id:      record.ID,
		Type:    record.Type,
		Name:    record.Name,
		Content: record.Content,
		Ttl:     int32(record.TTL),
		Proxied: record.Proxied,
	}
}
