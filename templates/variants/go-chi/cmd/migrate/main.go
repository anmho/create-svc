package main

import (
	"context"
	"log"
	"os"
	"sort"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/jmoiron/sqlx"

	"{{MODULE_PATH}}/internal/app"
	"{{MODULE_PATH}}/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	db, err := app.OpenDatabase(context.Background(), cfg.DatabaseURL)
	if err != nil {
		db, err = waitForDatabase(cfg.DatabaseURL, 30*time.Second)
		if err != nil {
			log.Fatal(err)
		}
	}

	if _, err := db.ExecContext(context.Background(), `
create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
)`); err != nil {
		log.Fatal(err)
	}

	entries, err := os.ReadDir("migrations")
	if err != nil {
		log.Fatal(err)
	}

	versions := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		versions = append(versions, entry.Name())
	}
	sort.Strings(versions)

	for _, version := range versions {
		var count int
		if err := db.GetContext(context.Background(), &count, `select count(*) from schema_migrations where version = $1`, version); err != nil {
			log.Fatal(err)
		}
		if count > 0 {
			continue
		}

		sqlBytes, err := os.ReadFile("migrations/" + version)
		if err != nil {
			log.Fatal(err)
		}

		tx, err := db.BeginTxx(context.Background(), nil)
		if err != nil {
			log.Fatal(err)
		}
		if _, err := tx.ExecContext(context.Background(), string(sqlBytes)); err != nil {
			_ = tx.Rollback()
			log.Fatal(err)
		}
		if _, err := tx.ExecContext(context.Background(), `insert into schema_migrations (version) values ($1)`, version); err != nil {
			_ = tx.Rollback()
			log.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			log.Fatal(err)
		}
		log.Printf("applied migration %s", version)
	}
}

func waitForDatabase(databaseURL string, timeout time.Duration) (*sqlx.DB, error) {
	deadline := time.Now().Add(timeout)
	var lastErr error

	for time.Now().Before(deadline) {
		db, err := app.OpenDatabase(context.Background(), databaseURL)
		if err == nil {
			return db, nil
		}
		lastErr = err
		time.Sleep(time.Second)
	}

	return nil, lastErr
}
