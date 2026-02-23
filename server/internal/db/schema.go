package db

import "database/sql"

// ensureSchema creates the initial database tables and seeds default config.
func ensureSchema(db *sql.DB) error {
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

	-- CSS transition effects for transition videos
	CREATE TABLE IF NOT EXISTS transition_effects (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT NOT NULL,                    -- e.g. "Fade In"
		direction  TEXT NOT NULL CHECK(direction IN ('in', 'out')), -- "in" or "out"
		css        TEXT NOT NULL,                    -- CSS keyframes / styles
		enabled    INTEGER NOT NULL DEFAULT 1,       -- 1 = enabled, 0 = disabled
		is_seed    INTEGER NOT NULL DEFAULT 0,       -- 1 = built-in (cannot be deleted)
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`

	_, err := db.Exec(schema)
	if err != nil {
		return err
	}

	// Migrate existing tables: add enabled and is_seed columns if missing.
	migrateColumns := []struct {
		name, ddl string
	}{
		{"enabled", "ALTER TABLE transition_effects ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1"},
		{"is_seed", "ALTER TABLE transition_effects ADD COLUMN is_seed INTEGER NOT NULL DEFAULT 0"},
	}
	for _, mc := range migrateColumns {
		// Check if column exists by querying pragma.
		var found bool
		rows, err := db.Query("PRAGMA table_info(transition_effects)")
		if err != nil {
			return err
		}
		for rows.Next() {
			var cid int
			var cname, ctype string
			var notnull, pk int
			var dflt sql.NullString
			if rows.Scan(&cid, &cname, &ctype, &notnull, &dflt, &pk) == nil && cname == mc.name {
				found = true
			}
		}
		rows.Close()
		if !found {
			if _, err := db.Exec(mc.ddl); err != nil {
				return err
			}
		}
	}

	// Seed built-in transition effects (idempotent — uses INSERT OR IGNORE
	// with a unique constraint on name+direction+is_seed to avoid duplicates).
	// We create a unique index if it does not exist.
	_, _ = db.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_seed_effects ON transition_effects (name, direction, is_seed) WHERE is_seed = 1")

	seeds := []struct {
		name, direction, css string
	}{
		{
			"Fade",
			"in",
			`@keyframes transition-fade-in {
  0%   { opacity: 0; }
  100% { opacity: 1; }
}
.transition-active {
  animation: transition-fade-in var(--transition-duration) ease-in forwards;
}`,
		},
		{
			"Dissolve",
			"in",
			`@keyframes transition-dissolve-in {
  0%   { opacity: 0; filter: blur(12px) brightness(1.3); }
  60%  { opacity: 0.8; filter: blur(4px) brightness(1.1); }
  100% { opacity: 1; filter: blur(0) brightness(1); }
}
.transition-active {
  animation: transition-dissolve-in var(--transition-duration) ease-in-out forwards;
}`,
		},
		{
			"Fade",
			"out",
			`@keyframes transition-fade-out {
  0%   { opacity: 1; }
  100% { opacity: 0; }
}
.transition-active {
  animation: transition-fade-out var(--transition-duration) ease-out forwards;
}`,
		},
		{
			"Dissolve",
			"out",
			`@keyframes transition-dissolve-out {
  0%   { opacity: 1; filter: blur(0) brightness(1); }
  40%  { opacity: 0.8; filter: blur(4px) brightness(1.1); }
  100% { opacity: 0; filter: blur(12px) brightness(1.3); }
}
.transition-active {
  animation: transition-dissolve-out var(--transition-duration) ease-in-out forwards;
}`,
		},
		// ── Flash ──
		{
			"Flash",
			"in",
			`@keyframes transition-flash-in {
  0%   { opacity: 0; filter: brightness(1); }
  40%  { opacity: 1; filter: brightness(3); }
  100% { opacity: 1; filter: brightness(1); }
}
.transition-active {
  animation: transition-flash-in var(--transition-duration) ease-out forwards;
}`,
		},
		{
			"Flash",
			"out",
			`@keyframes transition-flash-out {
  0%   { opacity: 1; filter: brightness(1); }
  60%  { opacity: 1; filter: brightness(3); }
  100% { opacity: 0; filter: brightness(1); }
}
.transition-active {
  animation: transition-flash-out var(--transition-duration) ease-in forwards;
}`,
		},
		// ── Zoom ──
		{
			"Zoom",
			"in",
			`@keyframes transition-zoom-in {
  0%   { opacity: 0; transform: scale(0.8); }
  100% { opacity: 1; transform: scale(1); }
}
.transition-active {
  animation: transition-zoom-in var(--transition-duration) ease-out forwards;
}`,
		},
		{
			"Zoom",
			"out",
			`@keyframes transition-zoom-out {
  0%   { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.3); }
}
.transition-active {
  animation: transition-zoom-out var(--transition-duration) ease-in forwards;
}`,
		},
		// ── Iris ──
		{
			"Iris",
			"in",
			`@keyframes transition-iris-in {
  0%   { clip-path: circle(0% at 50% 50%); }
  100% { clip-path: circle(72% at 50% 50%); }
}
.transition-active {
  animation: transition-iris-in var(--transition-duration) ease-in-out forwards;
}`,
		},
		{
			"Iris",
			"out",
			`@keyframes transition-iris-out {
  0%   { clip-path: circle(72% at 50% 50%); }
  100% { clip-path: circle(0% at 50% 50%); }
}
.transition-active {
  animation: transition-iris-out var(--transition-duration) ease-in-out forwards;
}`,
		},
		// ── Glitch ──
		{
			"Glitch",
			"in",
			`@keyframes transition-glitch-in {
  0%   { opacity: 0; clip-path: inset(40% 0 40% 0); filter: hue-rotate(0deg) saturate(1); }
  10%  { opacity: 1; clip-path: inset(10% 0 80% 0); filter: hue-rotate(90deg) saturate(3); transform: translate(-3px, 2px); }
  20%  { clip-path: inset(60% 0 5% 0); filter: hue-rotate(180deg) saturate(2); transform: translate(3px, -1px); }
  30%  { clip-path: inset(20% 0 50% 0); filter: hue-rotate(270deg) saturate(4); transform: translate(-2px, 1px); }
  50%  { clip-path: inset(5% 0 30% 0); filter: hue-rotate(45deg) saturate(2); transform: translate(1px, -2px); }
  70%  { clip-path: inset(0 0 10% 0); filter: hue-rotate(0deg) saturate(1.5); transform: translate(-1px, 0); }
  100% { opacity: 1; clip-path: inset(0 0 0 0); filter: hue-rotate(0deg) saturate(1); transform: translate(0, 0); }
}
.transition-active {
  animation: transition-glitch-in var(--transition-duration) steps(1, end) forwards;
}`,
		},
		{
			"Glitch",
			"out",
			`@keyframes transition-glitch-out {
  0%   { opacity: 1; clip-path: inset(0 0 0 0); filter: hue-rotate(0deg) saturate(1); transform: translate(0, 0); }
  30%  { clip-path: inset(0 0 10% 0); filter: hue-rotate(0deg) saturate(1.5); transform: translate(1px, 0); }
  50%  { clip-path: inset(5% 0 30% 0); filter: hue-rotate(45deg) saturate(2); transform: translate(-1px, 2px); }
  70%  { clip-path: inset(20% 0 50% 0); filter: hue-rotate(270deg) saturate(4); transform: translate(2px, -1px); }
  80%  { clip-path: inset(60% 0 5% 0); filter: hue-rotate(180deg) saturate(2); transform: translate(-3px, 1px); }
  90%  { clip-path: inset(10% 0 80% 0); filter: hue-rotate(90deg) saturate(3); transform: translate(3px, -2px); }
  100% { opacity: 0; clip-path: inset(40% 0 40% 0); filter: hue-rotate(0deg) saturate(1); transform: translate(0, 0); }
}
.transition-active {
  animation: transition-glitch-out var(--transition-duration) steps(1, end) forwards;
}`,
		},
	}
	for _, s := range seeds {
		_, _ = db.Exec(
			"INSERT OR IGNORE INTO transition_effects (name, direction, css, enabled, is_seed) VALUES (?, ?, ?, 1, 1)",
			s.name, s.direction, s.css,
		)
	}

	return nil
}
