package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type Client struct {
	baseURL string
	token   string
	client  *http.Client
}

type Record struct {
	ID      string
	Type    string
	Name    string
	Content string
	TTL     int
	Proxied bool
}

type RecordInput struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	TTL     int    `json:"ttl"`
	Proxied bool   `json:"proxied"`
}

func NewClient(baseURL string, token string, client *http.Client) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   strings.TrimSpace(token),
		client:  client,
	}
}

func (c *Client) ListRecords(ctx context.Context, zoneID string) ([]Record, error) {
	endpoint := fmt.Sprintf("%s/zones/%s/dns_records?per_page=200", c.baseURL, url.PathEscape(zoneID))
	var payload response[[]record]
	if err := c.doJSON(ctx, http.MethodGet, endpoint, nil, &payload); err != nil {
		return nil, err
	}

	out := make([]Record, 0, len(payload.Result))
	for _, record := range payload.Result {
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

func (c *Client) CreateRecord(ctx context.Context, zoneID string, input RecordInput) (Record, error) {
	endpoint := fmt.Sprintf("%s/zones/%s/dns_records", c.baseURL, url.PathEscape(zoneID))
	var payload response[record]
	if err := c.doJSON(ctx, http.MethodPost, endpoint, input, &payload); err != nil {
		return Record{}, err
	}
	return Record{
		ID:      payload.Result.ID,
		Type:    payload.Result.Type,
		Name:    payload.Result.Name,
		Content: payload.Result.Content,
		TTL:     payload.Result.TTL,
		Proxied: payload.Result.Proxied,
	}, nil
}

func (c *Client) UpdateRecord(ctx context.Context, zoneID string, recordID string, input RecordInput) (Record, error) {
	endpoint := fmt.Sprintf("%s/zones/%s/dns_records/%s", c.baseURL, url.PathEscape(zoneID), url.PathEscape(recordID))
	var payload response[record]
	if err := c.doJSON(ctx, http.MethodPut, endpoint, input, &payload); err != nil {
		return Record{}, err
	}
	return Record{
		ID:      payload.Result.ID,
		Type:    payload.Result.Type,
		Name:    payload.Result.Name,
		Content: payload.Result.Content,
		TTL:     payload.Result.TTL,
		Proxied: payload.Result.Proxied,
	}, nil
}

func (c *Client) DeleteRecord(ctx context.Context, zoneID string, recordID string) error {
	endpoint := fmt.Sprintf("%s/zones/%s/dns_records/%s", c.baseURL, url.PathEscape(zoneID), url.PathEscape(recordID))
	return c.doJSON(ctx, http.MethodDelete, endpoint, nil, nil)
}

func (c *Client) doJSON(ctx context.Context, method string, endpoint string, body any, out any) error {
	if c.token == "" {
		return fmt.Errorf("cloudflare token is empty")
	}

	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("cloudflare %s %s failed: status=%d body=%s", method, endpoint, resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return err
	}
	return nil
}

type response[T any] struct {
	Success bool `json:"success"`
	Result  T    `json:"result"`
}

type record struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	TTL     int    `json:"ttl"`
	Proxied bool   `json:"proxied"`
}
