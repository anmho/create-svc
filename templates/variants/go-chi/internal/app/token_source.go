package app

import (
	"context"
	"os"
	"strings"
	"sync"
)

type SecretResolver interface {
	Get(ctx context.Context, path string, key string) (string, error)
}

type CloudflareTokenSource struct {
	resolver SecretResolver
	secretPath string
	secretKey  string

	mu     sync.Mutex
	cached string
}

func NewCloudflareTokenSource(resolver SecretResolver, secretPath string, secretKey string) *CloudflareTokenSource {
	return &CloudflareTokenSource{
		resolver:   resolver,
		secretPath: secretPath,
		secretKey:  secretKey,
	}
}

func (s *CloudflareTokenSource) Token(ctx context.Context) (string, error) {
	if token := strings.TrimSpace(os.Getenv("CLOUDFLARE_API_TOKEN")); token != "" {
		return token, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.cached != "" {
		return s.cached, nil
	}

	token, err := s.resolver.Get(ctx, s.secretPath, s.secretKey)
	if err != nil {
		return "", err
	}

	s.cached = token
	return token, nil
}
