package config

import (
	"database/sql"
	"log/slog"
	"sync"
)

// Config provides thread-safe access to key-value settings stored in SQLite.
type Config struct {
	db    *sql.DB
	cache map[string]string
	mu    sync.RWMutex
}

// New creates a Config backed by the given database.
func New(db *sql.DB) *Config {
	c := &Config{
		db:    db,
		cache: make(map[string]string),
	}
	c.loadAll()
	return c
}

// Get returns the value for the given key, or the fallback if not found.
func (c *Config) Get(key, fallback string) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if v, ok := c.cache[key]; ok {
		return v
	}
	return fallback
}

// Set persists a key-value pair to the database and updates the cache.
func (c *Config) Set(key, value string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	_, err := c.db.Exec(
		`INSERT INTO config (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	if err != nil {
		return err
	}
	c.cache[key] = value
	return nil
}

// All returns a copy of every config entry.
func (c *Config) All() map[string]string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[string]string, len(c.cache))
	for k, v := range c.cache {
		out[k] = v
	}
	return out
}

func (c *Config) loadAll() {
	rows, err := c.db.Query("SELECT key, value FROM config")
	if err != nil {
		slog.Error("failed to load config", "error", err)
		return
	}
	defer rows.Close()

	c.mu.Lock()
	defer c.mu.Unlock()
	for rows.Next() {
		var k, v string
		if rows.Scan(&k, &v) == nil {
			c.cache[k] = v
		}
	}
	if err := rows.Err(); err != nil {
		slog.Error("config rows iteration error", "error", err)
	}
}
