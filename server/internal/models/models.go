package models

// DeckState represents the current state of a VirtualDJ deck,
// received from the C++ plugin via HTTP POST.
type DeckState struct {
	Deck      int     `json:"deck"`
	IsAudible bool    `json:"isAudible"` // is_audible: audible at all
	IsPlaying bool    `json:"isPlaying"` // play: deck is currently playing
	Volume    float64 `json:"volume"`    // get_volume: fader volume 0.0-1.0
	ElapsedMs int     `json:"elapsedMs"` // get_time elapsed absolute (ms)
	BPM       float64 `json:"bpm"`       // get_bpm
	Filename  string  `json:"filename"`  // get_filename (no path)
	Pitch     float64 `json:"pitch"`     // get_pitch_value, centered on 100%, used for video playbackRate
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
