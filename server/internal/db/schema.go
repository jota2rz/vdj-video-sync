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

	-- Overlay elements shown on top of the player video
	CREATE TABLE IF NOT EXISTS overlay_elements (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		key        TEXT NOT NULL UNIQUE,              -- unique identifier e.g. "progress", "bpm"
		name       TEXT NOT NULL,                     -- display name
		enabled    INTEGER NOT NULL DEFAULT 1,        -- 1 = visible, 0 = hidden
		css        TEXT NOT NULL DEFAULT '',           -- CSS styles
		html       TEXT NOT NULL DEFAULT '',           -- HTML template
		js         TEXT NOT NULL DEFAULT '',           -- JavaScript update logic
		is_seed    INTEGER NOT NULL DEFAULT 0,         -- 1 = built-in
		data_type  TEXT NOT NULL DEFAULT 'verb',       -- "verb" or "custom"
		verb       TEXT NOT NULL DEFAULT '',            -- VDJ verb
		config     TEXT NOT NULL DEFAULT '{}',          -- JSON config
		show_over_transition INTEGER NOT NULL DEFAULT 1, -- 1 = show above transition videos
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

	// Migrate overlay_elements: add show_over_transition column if missing.
	{
		var found bool
		rows, err := db.Query("PRAGMA table_info(overlay_elements)")
		if err != nil {
			return err
		}
		for rows.Next() {
			var cid int
			var cname, ctype string
			var notnull, pk int
			var dflt sql.NullString
			if rows.Scan(&cid, &cname, &ctype, &notnull, &dflt, &pk) == nil && cname == "show_over_transition" {
				found = true
			}
		}
		rows.Close()
		if !found {
			if _, err := db.Exec("ALTER TABLE overlay_elements ADD COLUMN show_over_transition INTEGER NOT NULL DEFAULT 1"); err != nil {
				return err
			}
			// Set song_name and artist to NOT show over transition by default
			db.Exec("UPDATE overlay_elements SET show_over_transition = 0 WHERE key IN ('song_name', 'artist')")
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

	// ── Overlay element seeds ───────────────────────────────
	overlaySeeds := []struct {
		key, name, css, html, js, dataType, verb, config string
		showOverTransition                               int
	}{
		{
			key:                "progress",
			name:               "Progress Bar",
			dataType:           "verb",
			verb:               "get_songlength",
			config:             "{}",
			showOverTransition: 0,
			css: `.overlay-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 8px;
  z-index: 100;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s ease;
}
.overlay-progress-track {
  position: absolute;
  inset: 0;
  background: rgba(255,255,255,0.15);
  backdrop-filter: blur(4px);
}
.overlay-progress-fill {
  width: 0;
  height: 100%;
  background: linear-gradient(90deg, #6366f1, #a855f7, #ec4899);
  box-shadow: 0 0 24px rgba(99,102,241,0.6), 0 0 8px rgba(168,85,247,0.4);
  transition: width 0.3s linear;
  border-radius: 0 4px 4px 0;
}`,
			html: `<div class="overlay-progress">
  <div class="overlay-progress-track"></div>
  <div class="overlay-progress-fill" data-overlay-fill></div>
</div>`,
			js: `(function(el, deck) {
  var container = el.querySelector('.overlay-progress');
  if (!container) return;
  if (!deck || !deck.totalTimeMs || deck.totalTimeMs <= 0) {
    container.style.opacity = '0';
    return;
  }
  var elapsed = (deck.elapsedMs || 0);
  var pct = Math.min(100, Math.max(0, (elapsed / deck.totalTimeMs) * 100));
  var fill = el.querySelector('[data-overlay-fill]');
  if (fill) fill.style.width = pct + '%';
  container.style.opacity = '1';
})`,
		},
		{
			key:                "bpm",
			name:               "BPM Display",
			dataType:           "verb",
			verb:               "get_bpm",
			config:             "{}",
			showOverTransition: 1,
			css: `.overlay-bpm {
  position: absolute;
  bottom: 40px;
  left: 40px;
  z-index: 100;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s ease;
}
.overlay-bpm-circle {
  width: 160px;
  height: 160px;
  border-radius: 50%;
  border: 4px solid rgba(99,102,241,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  background: rgba(0,0,0,0.5);
  backdrop-filter: blur(16px);
  animation: overlay-bpm-pulse var(--overlay-bpm-duration, 0.5s) ease-in-out infinite;
}
.overlay-bpm-value {
  font-size: 44px;
  font-weight: 700;
  color: #fff;
  line-height: 1;
  font-family: 'Segoe UI', system-ui, sans-serif;
  transition: opacity 0.05s ease;
}
.overlay-bpm-label {
  font-size: 18px;
  font-weight: 600;
  color: rgba(165,180,252,0.8);
  text-transform: uppercase;
  letter-spacing: 3px;
  margin-top: 4px;
}
@keyframes overlay-bpm-pulse {
  0%, 100% { transform: scale(1); border-color: rgba(99,102,241,0.6); box-shadow: 0 0 16px rgba(99,102,241,0.3); }
  50%      { transform: scale(1.08); border-color: rgba(168,85,247,0.9); box-shadow: 0 0 40px rgba(168,85,247,0.5); }
}`,
			html: `<div class="overlay-bpm">
  <div class="overlay-bpm-circle">
    <span class="overlay-bpm-value" data-overlay-bpm></span>
    <span class="overlay-bpm-label">BPM</span>
  </div>
</div>`,
			js: `(function(el, deck) {
  if (!deck) return;
  var bpmEl = el.querySelector('[data-overlay-bpm]');
  if (!bpmEl) return;
  var container = el.querySelector('.overlay-bpm');
  if (!container) return;
  if (!deck.bpm || deck.bpm <= 0) {
    container.style.opacity = '0';
    return;
  }
  var pitchRate = (deck.pitch || 100) / 100;
  var effectiveBPM = Math.round(deck.bpm * pitchRate);
  if (bpmEl.textContent !== '' + effectiveBPM) {
    bpmEl.textContent = effectiveBPM;
  }
  container.style.opacity = '1';
  var circle = el.querySelector('.overlay-bpm-circle');
  if (circle && deck.bpm > 0) {
    var interval = 60 / (deck.bpm * pitchRate);
    circle.style.setProperty('--overlay-bpm-duration', interval + 's');
  }
})`,
		},
		{
			key:                "song_name",
			name:               "Song Name",
			dataType:           "verb",
			verb:               "get_title",
			config:             "{}",
			showOverTransition: 0,
			css: `.overlay-song-name {
  position: absolute;
  bottom: 48px;
  right: 40px;
  z-index: 100;
  pointer-events: none;
  text-align: right;
  opacity: 0;
  transition: opacity 0.3s ease;
}
.overlay-song-name-text {
  font-size: 40px;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 4px 16px rgba(0,0,0,0.8), 0 0 40px rgba(99,102,241,0.3);
  font-family: 'Segoe UI', system-ui, sans-serif;
  animation: overlay-song-pulse var(--overlay-song-bpm-duration, 0.5s) ease-in-out infinite;
  max-width: 50vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: opacity 0.3s ease;
}
@keyframes overlay-song-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.7; }
}`,
			html: `<div class="overlay-song-name">
  <span class="overlay-song-name-text" data-overlay-song></span>
</div>`,
			js: `(function(el, deck) {
  if (!deck) return;
  var songEl = el.querySelector('[data-overlay-song]');
  if (!songEl) return;
  var container = el.querySelector('.overlay-song-name');
  if (!container) return;
  var newText = deck.title || '';
  if (!newText) {
    container.style.opacity = '0';
    return;
  }
  if (songEl.textContent !== newText) {
    songEl.textContent = newText;
  }
  container.style.opacity = '1';
  var pitchRate = (deck.pitch || 100) / 100;
  if (deck.bpm > 0) {
    var interval = 60 / (deck.bpm * pitchRate);
    el.querySelector('.overlay-song-name-text').style.setProperty('--overlay-song-bpm-duration', interval + 's');
  }
})`,
		},
		{
			key:                "artist",
			name:               "Artist Name",
			dataType:           "verb",
			verb:               "get_artist",
			config:             "{}",
			showOverTransition: 0,
			css: `.overlay-artist {
  position: absolute;
  bottom: 104px;
  right: 40px;
  z-index: 100;
  pointer-events: none;
  text-align: right;
  opacity: 0;
  transition: opacity 0.3s ease;
}
.overlay-artist-text {
  font-size: 28px;
  font-weight: 500;
  color: rgba(199,210,254,0.9);
  text-shadow: 0 4px 16px rgba(0,0,0,0.8);
  font-family: 'Segoe UI', system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 2px;
  max-width: 50vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: opacity 0.3s ease;
}`,
			html: `<div class="overlay-artist">
  <span class="overlay-artist-text" data-overlay-artist></span>
</div>`,
			js: `(function(el, deck) {
  if (!deck) return;
  var artistEl = el.querySelector('[data-overlay-artist]');
  if (!artistEl) return;
  var container = el.querySelector('.overlay-artist');
  if (!container) return;
  var newText = deck.artist || '';
  if (!newText) {
    container.style.opacity = '0';
    return;
  }
  if (artistEl.textContent !== newText) {
    artistEl.textContent = newText;
  }
  container.style.opacity = '1';
})`,
		},
		{
			key:                "custom_text",
			name:               "Custom Text",
			dataType:           "custom",
			verb:               "",
			config:             `{"text":"YOUR TEXT HERE"}`,
			showOverTransition: 1,
			css: `.overlay-custom-text {
  position: absolute;
  top: 40px;
  right: 40px;
  z-index: 100;
  pointer-events: none;
}
.overlay-custom-text-content {
  font-size: 36px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 4px 16px rgba(0,0,0,0.8), 0 0 32px rgba(236,72,153,0.3);
  font-family: 'Segoe UI', system-ui, sans-serif;
  padding: 16px 32px;
  background: rgba(0,0,0,0.4);
  backdrop-filter: blur(16px);
  border-radius: 16px;
  border: 2px solid rgba(255,255,255,0.1);
}`,
			html: `<div class="overlay-custom-text">
  <span class="overlay-custom-text-content" data-overlay-custom>YOUR TEXT HERE</span>
</div>`,
			js: `(function(el, deck, config) {
  var textEl = el.querySelector('[data-overlay-custom]');
  if (!textEl) return;
  textEl.textContent = (config && config.text) || '';
})`,
		},
		{
			key:                "custom_logo",
			name:               "Custom Logo",
			dataType:           "custom",
			verb:               "",
			config:             `{"logo_url":""}`,
			showOverTransition: 1,
			css: `.overlay-logo {
  position: absolute;
  top: 40px;
  left: 40px;
  z-index: 100;
  pointer-events: none;
}
.overlay-logo-wrap {
  position: relative;
  display: inline-block;
  -webkit-mask-size: contain;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
}
.overlay-logo-img {
  width: 200px;
  height: auto;
  display: block;
}
.overlay-logo-wrap::after {
  content: '';
  position: absolute;
  top: 0;
  left: -60%;
  width: 60%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent);
  animation: overlay-logo-sweep 4s ease-in-out infinite;
  pointer-events: none;
}
@keyframes overlay-logo-sweep {
  0%       { left: -60%; }
  50%      { left: 100%; }
  100%     { left: 100%; }
}`,
			html: `<div class="overlay-logo">
  <div class="overlay-logo-wrap">
    <img class="overlay-logo-img" data-overlay-logo src="" alt="" />
  </div>
</div>`,
			js: `(function(el, deck, config) {
  var img = el.querySelector('[data-overlay-logo]');
  if (!img) return;
  var url = (config && config.logo_url) || '';
  if (!url) { img.style.display = 'none'; return; }
  img.style.display = '';
  var base = url.split('?')[0];
  if (img.src.split('?')[0] !== location.origin + base) img.src = url;
  var wrap = el.querySelector('.overlay-logo-wrap');
  if (wrap) {
    wrap.style.webkitMaskImage = 'url(' + url + ')';
    wrap.style.maskImage = 'url(' + url + ')';
  }
})`,
		},
	}

	for _, s := range overlaySeeds {
		_, _ = db.Exec(
			`INSERT OR IGNORE INTO overlay_elements (key, name, css, html, js, is_seed, data_type, verb, config, enabled, show_over_transition) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?)`,
			s.key, s.name, s.css, s.html, s.js, s.dataType, s.verb, s.config, s.showOverTransition,
		)
	}

	return nil
}
