package db

import "database/sql"

// migrate applies the database schema.
func migrate(db *sql.DB) error {
	const schema = `
	CREATE TABLE IF NOT EXISTS config (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	-- Default config values (inserted only if not present)
	INSERT OR IGNORE INTO config (key, value) VALUES ('videos_dir', './videos');
	INSERT OR IGNORE INTO config (key, value) VALUES ('transition_videos_dir', './transition-videos');
	INSERT OR IGNORE INTO config (key, value) VALUES ('transition_duration', '3');
	INSERT OR IGNORE INTO config (key, value) VALUES ('transition_enabled', '1');

	-- Cached BPM values for video files (avoids re-analysis)
	CREATE TABLE IF NOT EXISTS video_bpm (
		path       TEXT PRIMARY KEY,   -- absolute file path
		bpm        REAL NOT NULL,      -- detected BPM
		mod_time   INTEGER NOT NULL,   -- file modification time (Unix seconds)
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`

	_, err := db.Exec(schema)
	return err
}
