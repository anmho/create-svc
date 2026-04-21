package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	Port                string
	VaultAddr           string
	VaultRoleIDFile     string
	VaultSecretIDFile   string
	VaultSecretPath     string
	VaultSecretKey      string
	CloudflareZoneID    string
	CloudflareAPIBaseURL string
}

func Load() (Config, error) {
	cfg := Config{
		Port:                 envOr("PORT", "8080"),
		VaultAddr:            strings.TrimSpace(os.Getenv("VAULT_ADDR")),
		VaultRoleIDFile:      envOr("VAULT_ROLE_ID_FILE", "/var/run/secrets/vault-role-id/value"),
		VaultSecretIDFile:    envOr("VAULT_SECRET_ID_FILE", "/var/run/secrets/vault-secret-id/value"),
		VaultSecretPath:      strings.TrimSpace(os.Getenv("VAULT_SECRET_PATH")),
		VaultSecretKey:       strings.TrimSpace(os.Getenv("VAULT_SECRET_KEY")),
		CloudflareZoneID:     strings.TrimSpace(os.Getenv("CLOUDFLARE_ZONE_ID")),
		CloudflareAPIBaseURL: envOr("CLOUDFLARE_API_BASE_URL", "https://api.cloudflare.com/client/v4"),
	}

	if cfg.CloudflareZoneID == "" {
		return Config{}, fmt.Errorf("CLOUDFLARE_ZONE_ID is required")
	}
	if strings.TrimSpace(os.Getenv("CLOUDFLARE_API_TOKEN")) == "" {
		if cfg.VaultAddr == "" {
			return Config{}, fmt.Errorf("VAULT_ADDR is required when CLOUDFLARE_API_TOKEN is not set")
		}
		if cfg.VaultSecretPath == "" {
			return Config{}, fmt.Errorf("VAULT_SECRET_PATH is required when CLOUDFLARE_API_TOKEN is not set")
		}
		if cfg.VaultSecretKey == "" {
			return Config{}, fmt.Errorf("VAULT_SECRET_KEY is required when CLOUDFLARE_API_TOKEN is not set")
		}
	}

	return cfg, nil
}

func envOr(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
