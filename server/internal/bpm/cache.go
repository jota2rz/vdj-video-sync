package bpm

import (
	"database/sql"
	"log/slog"
	"os"
)

// Cache stores and retrieves analysed BPM values from SQLite.
type Cache struct {
	db *sql.DB
}

// NewCache creates a BPM cache backed by the given database.
func NewCache(db *sql.DB) *Cache {
	return &Cache{db: db}
}

// Get retrieves a cached BPM for the given file path and modification time.
// Returns 0, false if not cached or if the file has been modified since.
func (c *Cache) Get(path string, modTime int64) (float64, bool) {
	var bpm float64
	err := c.db.QueryRow(
		`SELECT bpm FROM video_bpm WHERE path = ? AND mod_time = ?`,
		path, modTime,
	).Scan(&bpm)
	if err != nil {
		return 0, false
	}
	return bpm, true
}

// Set stores a BPM value for the given file path and modification time.
func (c *Cache) Set(path string, modTime int64, bpm float64) error {
	_, err := c.db.Exec(
		`INSERT INTO video_bpm (path, bpm, mod_time) VALUES (?, ?, ?)
		 ON CONFLICT(path) DO UPDATE SET bpm = excluded.bpm, mod_time = excluded.mod_time`,
		path, bpm, modTime,
	)
	return err
}

// Cleanup removes orphaned cache entries whose files no longer exist on disk.
func (c *Cache) Cleanup() {
	rows, err := c.db.Query(`SELECT path FROM video_bpm`)
	if err != nil {
		slog.Warn("bpm cache cleanup: query failed", "error", err)
		return
	}
	defer rows.Close()

	var toDelete []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			continue
		}
		if _, err := os.Stat(path); os.IsNotExist(err) {
			toDelete = append(toDelete, path)
		}
	}
	if err := rows.Err(); err != nil {
		slog.Warn("bpm cache cleanup: rows iteration error", "error", err)
	}

	for _, path := range toDelete {
		if _, err := c.db.Exec(`DELETE FROM video_bpm WHERE path = ?`, path); err != nil {
			slog.Warn("bpm cache cleanup: delete failed", "path", path, "error", err)
		}
	}

	if len(toDelete) > 0 {
		slog.Info("bpm cache cleanup", "removed", len(toDelete))
	}
}
