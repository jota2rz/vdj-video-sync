package overlay

import (
	"database/sql"
	"errors"

	"github.com/jota2rz/vdj-video-sync/server/internal/models"
)

// ErrSeedProtected is returned when attempting to delete a built-in element.
var ErrSeedProtected = errors.New("built-in overlay elements cannot be deleted")

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Store provides CRUD operations for overlay elements.
type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

func (s *Store) List() ([]models.OverlayElement, error) {
	rows, err := s.db.Query(
		"SELECT id, key, name, enabled, css, html, js, is_seed, data_type, verb, config, show_over_transition FROM overlay_elements ORDER BY is_seed DESC, id",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var elements []models.OverlayElement
	for rows.Next() {
		var e models.OverlayElement
		if err := rows.Scan(&e.ID, &e.Key, &e.Name, &e.Enabled, &e.CSS, &e.HTML, &e.JS, &e.IsSeed, &e.DataType, &e.Verb, &e.Config, &e.ShowOverTransition); err != nil {
			return nil, err
		}
		elements = append(elements, e)
	}
	return elements, rows.Err()
}

func (s *Store) Get(id int) (*models.OverlayElement, error) {
	var e models.OverlayElement
	err := s.db.QueryRow(
		"SELECT id, key, name, enabled, css, html, js, is_seed, data_type, verb, config, show_over_transition FROM overlay_elements WHERE id = ?", id,
	).Scan(&e.ID, &e.Key, &e.Name, &e.Enabled, &e.CSS, &e.HTML, &e.JS, &e.IsSeed, &e.DataType, &e.Verb, &e.Config, &e.ShowOverTransition)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

func (s *Store) Update(id int, name, css, html, js, config string, showOverTransition bool) error {
	show := 0
	if showOverTransition {
		show = 1
	}
	_, err := s.db.Exec(
		"UPDATE overlay_elements SET name = ?, css = ?, html = ?, js = ?, config = ?, show_over_transition = ? WHERE id = ?",
		name, css, html, js, config, show, id,
	)
	return err
}

func (s *Store) SetEnabled(id int, enabled bool) error {
	v := 0
	if enabled {
		v = 1
	}
	_, err := s.db.Exec("UPDATE overlay_elements SET enabled = ? WHERE id = ?", v, id)
	return err
}

// RestoreDefaults resets a seed element to its original CSS/HTML/JS/config.
// Returns the refreshed element after reset.
func (s *Store) RestoreDefaults(id int) (*models.OverlayElement, error) {
	var isSeed bool
	var key string
	if err := s.db.QueryRow("SELECT is_seed, key FROM overlay_elements WHERE id = ?", id).Scan(&isSeed, &key); err != nil {
		return nil, err
	}
	if !isSeed {
		return nil, errors.New("only built-in elements can be restored")
	}

	// Delete the row and let ensureSchema re-seed it on next restart.
	// Instead, we'll look up the seed values from the schema seeds.
	// For simplicity, we reset via a temporary approach: delete + re-insert
	// isn't ideal. Instead we expose default values inline.
	// Actually, the cleanest approach: just re-read from the DB seed data.
	// Since we can't easily call ensureSchema again, we store a copy
	// of the defaults here as a lookup.
	defaults := seedDefaults()
	def, ok := defaults[key]
	if !ok {
		return nil, errors.New("no default found for key: " + key)
	}

	_, err := s.db.Exec(
		"UPDATE overlay_elements SET name = ?, css = ?, html = ?, js = ?, config = ?, enabled = 1, show_over_transition = ? WHERE id = ?",
		def.Name, def.CSS, def.HTML, def.JS, def.Config, boolToInt(def.ShowOverTransition), id,
	)
	if err != nil {
		return nil, err
	}
	return s.Get(id)
}

func (s *Store) Delete(id int) error {
	var isSeed bool
	if err := s.db.QueryRow("SELECT is_seed FROM overlay_elements WHERE id = ?", id).Scan(&isSeed); err != nil {
		return err
	}
	if isSeed {
		return ErrSeedProtected
	}
	_, err := s.db.Exec("DELETE FROM overlay_elements WHERE id = ?", id)
	return err
}

// ListEnabled returns only enabled overlay elements.
func (s *Store) ListEnabled() ([]models.OverlayElement, error) {
	rows, err := s.db.Query(
		"SELECT id, key, name, enabled, css, html, js, is_seed, data_type, verb, config, show_over_transition FROM overlay_elements WHERE enabled = 1 ORDER BY id",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var elements []models.OverlayElement
	for rows.Next() {
		var e models.OverlayElement
		if err := rows.Scan(&e.ID, &e.Key, &e.Name, &e.Enabled, &e.CSS, &e.HTML, &e.JS, &e.IsSeed, &e.DataType, &e.Verb, &e.Config, &e.ShowOverTransition); err != nil {
			return nil, err
		}
		elements = append(elements, e)
	}
	return elements, rows.Err()
}

// seedDefault holds the default values for a built-in overlay element.
type seedDefault struct {
	Name, CSS, HTML, JS, Config string
	ShowOverTransition          bool
}

// seedDefaults returns the original seed values for each built-in overlay key.
// This is duplicated from schema.go seeds to support RestoreDefaults without
// re-running the full schema migration.
func seedDefaults() map[string]seedDefault {
	return map[string]seedDefault{
		"progress": {
			Name:               "Progress Bar",
			Config:             "{}",
			ShowOverTransition: false,
			CSS: `.overlay-progress {
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
			HTML: `<div class="overlay-progress">
  <div class="overlay-progress-track"></div>
  <div class="overlay-progress-fill" data-overlay-fill></div>
</div>`,
			JS: `(function(el, deck) {
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
		"bpm": {
			Name:               "BPM Display",
			Config:             "{}",
			ShowOverTransition: true,
			CSS: `.overlay-bpm {
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
  transition: opacity 0.3s ease;
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
			HTML: `<div class="overlay-bpm">
  <div class="overlay-bpm-circle">
    <span class="overlay-bpm-value" data-overlay-bpm></span>
    <span class="overlay-bpm-label">BPM</span>
  </div>
</div>`,
			JS: `(function(el, deck) {
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
		"song_name": {
			Name:               "Song Name",
			Config:             "{}",
			ShowOverTransition: false,
			CSS: `.overlay-song-name {
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
			HTML: `<div class="overlay-song-name">
  <span class="overlay-song-name-text" data-overlay-song></span>
</div>`,
			JS: `(function(el, deck) {
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
		"artist": {
			Name:               "Artist Name",
			Config:             "{}",
			ShowOverTransition: false,
			CSS: `.overlay-artist {
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
			HTML: `<div class="overlay-artist">
  <span class="overlay-artist-text" data-overlay-artist></span>
</div>`,
			JS: `(function(el, deck) {
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
		"custom_text": {
			Name:               "Custom Text",
			Config:             `{"text":"YOUR TEXT HERE"}`,
			ShowOverTransition: true,
			CSS: `.overlay-custom-text {
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
			HTML: `<div class="overlay-custom-text">
  <span class="overlay-custom-text-content" data-overlay-custom>YOUR TEXT HERE</span>
</div>`,
			JS: `(function(el, deck, config) {
  var textEl = el.querySelector('[data-overlay-custom]');
  if (!textEl) return;
  textEl.textContent = (config && config.text) || '';
})`,
		},
		"custom_logo": {
			Name:               "Custom Logo",
			Config:             `{"logo_url":""}`,
			ShowOverTransition: true,
			CSS: `.overlay-logo {
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
			HTML: `<div class="overlay-logo">
  <div class="overlay-logo-wrap">
    <img class="overlay-logo-img" data-overlay-logo src="" alt="" />
  </div>
</div>`,
			JS: `(function(el, deck, config) {
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
}
