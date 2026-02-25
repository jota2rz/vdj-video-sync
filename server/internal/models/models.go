package models

// DeckState represents the current state of a VirtualDJ deck,
// received from the C++ plugin via HTTP POST.
type DeckState struct {
	Deck        int     `json:"deck"`
	IsAudible   bool    `json:"isAudible"`   // is_audible: audible at all
	IsPlaying   bool    `json:"isPlaying"`   // play: deck is currently playing
	Volume      float64 `json:"volume"`      // get_volume: fader volume 0.0-1.0
	ElapsedMs   int     `json:"elapsedMs"`   // get_time elapsed absolute (ms)
	BPM         float64 `json:"bpm"`         // get_bpm
	Filename    string  `json:"filename"`    // get_filename (no path)
	Pitch       float64 `json:"pitch"`       // get_pitch_value, centered on 100%, used for video playbackRate
	TotalTimeMs int     `json:"totalTimeMs"` // get_totaltime_ms: total song length in ms
	Title       string  `json:"title"`       // get_title: song title metadata
	Artist      string  `json:"artist"`      // get_artist: song artist metadata
}

// VideoFile represents a video available for playback.
type VideoFile struct {
	Name       string  `json:"name"`
	Path       string  `json:"path"`
	BPM        float64 `json:"bpm,omitempty"`
	MatchType  string  `json:"matchType,omitempty"`  // legacy compat
	MatchLevel int     `json:"matchLevel"`           // 0-5 tiered match
	Similarity float64 `json:"similarity,omitempty"` // 0-1 filename similarity
}

// ConfigEntry is a key-value pair stored in the database.
type ConfigEntry struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// TransitionEffect represents a CSS transition effect stored in the database.
type TransitionEffect struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Direction string `json:"direction"` // "in" or "out"
	CSS       string `json:"css"`
	Enabled   bool   `json:"enabled"`
	IsSeed    bool   `json:"isSeed"`
}

// OverlayElement represents a configurable on-screen overlay element.
type OverlayElement struct {
	ID                 int    `json:"id"`
	Key                string `json:"key"`                // unique identifier: "progress", "bpm", "song_name", "artist", "custom_text"
	Name               string `json:"name"`               // display name
	Enabled            bool   `json:"enabled"`            // visible on player
	CSS                string `json:"css"`                // custom CSS styles
	HTML               string `json:"html"`               // HTML template (uses {{value}} placeholders)
	JS                 string `json:"js"`                 // JavaScript logic (runs per frame)
	IsSeed             bool   `json:"isSeed"`             // built-in element (cannot be deleted)
	DataType           string `json:"dataType"`           // "verb" or "custom"
	Verb               string `json:"verb"`               // VDJ verb used to obtain data (empty for custom)
	Config             string `json:"config"`             // JSON config (e.g. custom text value)
	ShowOverTransition bool   `json:"showOverTransition"` // show above transition videos
}
