package app

import (
	"context"
	"fmt"
	"sync"
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

type DNSService struct {
	mu      sync.RWMutex
	nextID  int
	records map[string]Record
}

func NewDNSService() *DNSService {
	return &DNSService{
		nextID:  1,
		records: map[string]Record{},
	}
}

func (s *DNSService) ListRecords(ctx context.Context) ([]Record, error) {
	_ = ctx
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]Record, 0, len(s.records))
	for _, record := range s.records {
		out = append(out, record)
	}
	return out, nil
}

func (s *DNSService) CreateRecord(ctx context.Context, input CreateRecordInput) (Record, error) {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()

	record := Record{
		ID:      fmt.Sprintf("%d", s.nextID),
		Type:    input.Type,
		Name:    input.Name,
		Content: input.Content,
		TTL:     input.TTL,
		Proxied: input.Proxied,
	}

	s.nextID += 1
	s.records[record.ID] = record
	return record, nil
}

func (s *DNSService) UpdateRecord(ctx context.Context, id string, input UpdateRecordInput) (Record, error) {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()

	record, ok := s.records[id]
	if !ok {
		return Record{}, fmt.Errorf("record %s not found", id)
	}

	record.Type = input.Type
	record.Name = input.Name
	record.Content = input.Content
	record.TTL = input.TTL
	record.Proxied = input.Proxied
	s.records[id] = record

	return record, nil
}

func (s *DNSService) DeleteRecord(ctx context.Context, id string) error {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.records[id]; !ok {
		return fmt.Errorf("record %s not found", id)
	}

	delete(s.records, id)
	return nil
}
