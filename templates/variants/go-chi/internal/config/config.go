package config

import (
	"errors"
	"os"
	"strings"
)

type Config struct {
	Port              string
	DatabaseURL       string
	TemporalEnabled   bool
	TemporalAddress   string
	TemporalNamespace string
	TemporalTaskQueue string
	TemporalAPIKey    string
	AuthEnabled       bool
	AuthIssuer        string
	AuthAudience      string
	AuthJWKSURL       string
}

func Load() (Config, error) {
	cfg := Config{
		Port:              envOr("PORT", "8080"),
		DatabaseURL:       strings.TrimSpace(os.Getenv("DATABASE_URL")),
		TemporalEnabled:   envBool("TEMPORAL_ENABLED"),
		TemporalAddress:   envOr("TEMPORAL_ADDRESS", "localhost:7233"),
		TemporalNamespace: envOr("TEMPORAL_NAMESPACE", "default"),
		TemporalTaskQueue: envOr("TEMPORAL_TASK_QUEUE", "{{SERVICE_NAME}}"),
		TemporalAPIKey:    strings.TrimSpace(os.Getenv("TEMPORAL_API_KEY")),
		AuthEnabled:       envBool("AUTH_ENABLED"),
		AuthIssuer:        envOr("AUTH_ISSUER", "{{AUTH_ISSUER}}"),
		AuthAudience:      envOr("AUTH_AUDIENCE", "{{AUTH_AUDIENCE}}"),
		AuthJWKSURL:       envOr("AUTH_JWKS_URL", "{{AUTH_JWKS_URL}}"),
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is required")
	}
	return cfg, nil
}

func envBool(key string) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func envOr(key string, fallback string) string {
	value := os.Getenv(key)
	if value != "" {
		return value
	}
	return fallback
}
