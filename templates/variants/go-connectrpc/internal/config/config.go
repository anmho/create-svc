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
	TemporalTLSCACert string
	TemporalTLSCert   string
	TemporalTLSKey    string
	AuthEnabled       bool
	AuthIssuer        string
	AuthAudience      string
	AuthJWKSURL       string
}

func Load() (Config, error) {
	cfg := Config{
		Port:              envOr("PORT", "8080"),
		DatabaseURL:       strings.TrimSpace(os.Getenv("DATABASE_URL")),
		TemporalEnabled:   envBoolDefault("TEMPORAL_ENABLED", true),
		TemporalAddress:   envOrRuntime("TEMPORAL_ADDRESS", "localhost:7233"),
		TemporalNamespace: envOrRuntime("TEMPORAL_NAMESPACE", "default"),
		TemporalTaskQueue: envOr("TEMPORAL_TASK_QUEUE", "{{SERVICE_NAME}}"),
		TemporalAPIKey:    strings.TrimSpace(os.Getenv("TEMPORAL_API_KEY")),
		TemporalTLSCACert: strings.TrimSpace(os.Getenv("TEMPORAL_TLS_CA_CERT")),
		TemporalTLSCert:   strings.TrimSpace(os.Getenv("TEMPORAL_TLS_CERT")),
		TemporalTLSKey:    strings.TrimSpace(os.Getenv("TEMPORAL_TLS_KEY")),
		AuthEnabled:       envBool("AUTH_ENABLED"),
		AuthIssuer:        envOr("AUTH_ISSUER", "{{AUTH_ISSUER}}"),
		AuthAudience:      envOr("AUTH_AUDIENCE", "{{AUTH_AUDIENCE}}"),
		AuthJWKSURL:       envOr("AUTH_JWKS_URL", "{{AUTH_JWKS_URL}}"),
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is required")
	}
	if cfg.TemporalEnabled {
		missing := make([]string, 0, 2)
		if cfg.TemporalAddress == "" {
			missing = append(missing, "TEMPORAL_ADDRESS")
		}
		if cfg.TemporalNamespace == "" {
			missing = append(missing, "TEMPORAL_NAMESPACE")
		}
		if len(missing) > 0 {
			return Config{}, errors.New(strings.Join(missing, " and ") + " required when Temporal is enabled")
		}
	}
	return cfg, nil
}

func envBool(key string) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func envBoolDefault(key string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func envOr(key string, fallback string) string {
	value := os.Getenv(key)
	if value != "" {
		return value
	}
	return fallback
}

func envOrRuntime(key string, localFallback string) string {
	value := os.Getenv(key)
	if value != "" {
		return value
	}
	if strings.TrimSpace(os.Getenv("K_SERVICE")) != "" {
		return ""
	}
	return localFallback
}
