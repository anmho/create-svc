package app

import (
	"context"
	"net/http"
	"time"

	"{{MODULE_PATH}}/internal/cloudflare"
)

type Record struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	TTL     int    `json:"ttl"`
	Proxied bool   `json:"proxied"`
}

type CreateRecordInput struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	TTL     int    `json:"ttl"`
	Proxied bool   `json:"proxied"`
}

type UpdateRecordInput struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	TTL     int    `json:"ttl"`
	Proxied bool   `json:"proxied"`
}

type TokenSource interface {
	Token(context.Context) (string, error)
}

type DNSService struct {
	zoneID      string
	apiBaseURL  string
	tokenSource TokenSource
	httpClient  *http.Client
}

func NewDNSService(zoneID string, apiBaseURL string, tokenSource TokenSource) *DNSService {
	return &DNSService{
		zoneID:      zoneID,
		apiBaseURL:  apiBaseURL,
		tokenSource: tokenSource,
		httpClient: &http.Client{
			Timeout: 20 * time.Second,
		},
	}
}

func (s *DNSService) ListRecords(ctx context.Context) ([]Record, error) {
	client, err := s.cloudflareClient(ctx)
	if err != nil {
		return nil, err
	}

	records, err := client.ListRecords(ctx, s.zoneID)
	if err != nil {
		return nil, err
	}

	out := make([]Record, 0, len(records))
	for _, record := range records {
		out = append(out, Record{
			ID:      record.ID,
			Type:    record.Type,
			Name:    record.Name,
			Content: record.Content,
			TTL:     record.TTL,
			Proxied: record.Proxied,
		})
	}
	return out, nil
}

func (s *DNSService) CreateRecord(ctx context.Context, input CreateRecordInput) (Record, error) {
	client, err := s.cloudflareClient(ctx)
	if err != nil {
		return Record{}, err
	}

	record, err := client.CreateRecord(ctx, s.zoneID, cloudflare.RecordInput{
		Type:    input.Type,
		Name:    input.Name,
		Content: input.Content,
		TTL:     input.TTL,
		Proxied: input.Proxied,
	})
	if err != nil {
		return Record{}, err
	}

	return Record{
		ID:      record.ID,
		Type:    record.Type,
		Name:    record.Name,
		Content: record.Content,
		TTL:     record.TTL,
		Proxied: record.Proxied,
	}, nil
}

func (s *DNSService) UpdateRecord(ctx context.Context, id string, input UpdateRecordInput) (Record, error) {
	client, err := s.cloudflareClient(ctx)
	if err != nil {
		return Record{}, err
	}

	record, err := client.UpdateRecord(ctx, s.zoneID, id, cloudflare.RecordInput{
		Type:    input.Type,
		Name:    input.Name,
		Content: input.Content,
		TTL:     input.TTL,
		Proxied: input.Proxied,
	})
	if err != nil {
		return Record{}, err
	}

	return Record{
		ID:      record.ID,
		Type:    record.Type,
		Name:    record.Name,
		Content: record.Content,
		TTL:     record.TTL,
		Proxied: record.Proxied,
	}, nil
}

func (s *DNSService) DeleteRecord(ctx context.Context, id string) error {
	client, err := s.cloudflareClient(ctx)
	if err != nil {
		return err
	}
	return client.DeleteRecord(ctx, s.zoneID, id)
}

func (s *DNSService) cloudflareClient(ctx context.Context) (*cloudflare.Client, error) {
	token, err := s.tokenSource.Token(ctx)
	if err != nil {
		return nil, err
	}

	return cloudflare.NewClient(s.apiBaseURL, token, s.httpClient), nil
}
