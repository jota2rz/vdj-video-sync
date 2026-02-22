package db

import (
	"database/sql"
	"log/slog"

	_ "modernc.org/sqlite"
)

// Open initialises the SQLite database and ensures the schema exists.
func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}

	// SQLite pragmas for performance
	pragmas := []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA busy_timeout=5000",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			slog.Warn("pragma failed", "pragma", p, "error", err)
		}
	}

	if err := ensureSchema(db); err != nil {
		db.Close()
		return nil, err
	}

	return db, nil
}
