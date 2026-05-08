package config

import (
	"errors"
	"os"
	"strings"
)

type Config struct {
	Port                    string
	DatabaseURL             string
	AttachmentBucket        string
	AttachmentPublicBaseURL string
}

func Load() (Config, error) {
	cfg := Config{
		Port:                    envOr("PORT", "8080"),
		DatabaseURL:             strings.TrimSpace(os.Getenv("DATABASE_URL")),
		AttachmentBucket:        strings.TrimSpace(os.Getenv("ATTACHMENT_BUCKET")),
		AttachmentPublicBaseURL: strings.TrimSpace(os.Getenv("ATTACHMENT_PUBLIC_BASE_URL")),
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is required")
	}
	if cfg.AttachmentBucket == "" {
		return Config{}, errors.New("ATTACHMENT_BUCKET is required")
	}
	return cfg, nil
}

func envOr(key string, fallback string) string {
	value := os.Getenv(key)
	if value != "" {
		return value
	}
	return fallback
}
