package config

import "os"

type Config struct {
	Port        string
	DatabaseURL string
}

func Load() (Config, error) {
	return Config{
		Port:        envOr("PORT", "8080"),
		DatabaseURL: envOr("DATABASE_URL", ""),
	}, nil
}

func envOr(key string, fallback string) string {
	value := os.Getenv(key)
	if value != "" {
		return value
	}
	return fallback
}
