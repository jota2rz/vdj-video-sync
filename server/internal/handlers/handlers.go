package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/jota2rz/vdj-video-sync/server/internal/config"
	"github.com/jota2rz/vdj-video-sync/server/internal/models"
	"github.com/jota2rz/vdj-video-sync/server/internal/sse"
	"github.com/jota2rz/vdj-video-sync/server/internal/transitions"
	"github.com/jota2rz/vdj-video-sync/server/internal/video"
	"github.com/jota2rz/vdj-video-sync/server/templates/pages"
)

// Handlers holds dependencies for all HTTP handlers.
type Handlers struct {
	cfg               *config.Config
	hub               *sse.Hub
	matcher           *video.Matcher
	transitionMatcher *video.Matcher
	transitions       *transitions.Store

	// Logging state: track last-logged values and times per deck.
	// Protected by logMu since HandleDeckUpdate, HandleForceVideo, and
	// HandleVideoEnded can run concurrently.
	logMu        sync.Mutex
	lastLogState map[int]models.DeckState // keyed by deck number
	lastLogTime  map[int]time.Time        // last throttled log time per deck

	// In-memory cache of latest SSE event per deck (for new client replay).
	deckCacheMu sync.RWMutex
	deckCache   map[int][]byte // keyed by deck number, value is the SSE-formatted event

	// Cached analysis-status SSE event for new client sync
	analysisCache []byte

	// Active-deck tracking for transition detection
	activeDeckMu     sync.Mutex
	activeDeck       int // current active deck number (0 = none)
	activeDeckStates map[int]*activeDeckInfo

	// Transition pool: server keeps 3 transition videos ready at all times.
	// Protected by activeDeckMu.
	transitionPool     [3]*transitionPoolEntry
	transitionNextSlot int // which slot to play next (cycles 0→1→2→0…)

	// Cached transition-pool SSE event for new client sync
	transitionPoolCache []byte

	// Cached config-updated SSE events for new client sync (keyed by config key)
	configCache map[string][]byte

	// Deck 3/4 visibility: server-side timers to auto-hide after 1 minute idle
	deckVisMu     sync.Mutex
	deckVisible   map[int]bool        // current visibility per deck (3/4)
	deckHideTimer map[int]*time.Timer // pending hide timers
	visCache      map[int][]byte      // cached SSE events for replay

	// BPM analysis state: true while analysis is running
	analysing   bool
	analysingMu sync.Mutex

	// Forced video override per deck: user can force a specific video
	// for the active deck via the library UI. Cleared when the deck's
	// filename changes.
	forcedMu       sync.Mutex
	forcedVideo    map[int]*models.VideoFile // keyed by deck number
	forcedFilename map[int]string            // filename when force was set

	// Video position tracking for cross-client sync (match levels 2+).
	// Since these videos don't correspond to the VDJ song, we track
	// playback position server-side so all clients stay synchronised.
	videoSyncMu sync.Mutex
	videoSync   map[int]*deckVideoSync // keyed by deck number
}

// deckVideoSync tracks video playback position for match levels 2+.
// Updated incrementally on each deck-update from VDJ, accumulating
// elapsed time at the current playback rate.
type deckVideoSync struct {
	videoPath     string    // served path of the current video
	lastUpdate    time.Time // wall clock of last update
	accumulatedMs float64   // accumulated playback time (ms)
	lastRate      float64   // last computed playback rate
	playing       bool      // was the deck playing at last update
}

// activeDeckInfo tracks per-deck state for active-deck priority calculation.
type activeDeckInfo struct {
	IsAudible bool
	IsPlaying bool
	Volume    float64
	HasVideo  bool
}

// transitionPoolEntry is a single slot in the server's 2-slot transition pool.
type transitionPoolEntry struct {
	Video string  `json:"video"`
	BPM   float64 `json:"bpm,omitempty"`
}

// New creates a Handlers instance.
func New(cfg *config.Config, hub *sse.Hub, matcher *video.Matcher, transitionMatcher *video.Matcher, ts *transitions.Store) *Handlers {
	return &Handlers{
		cfg:               cfg,
		hub:               hub,
		matcher:           matcher,
		transitionMatcher: transitionMatcher,
		transitions:       ts,
		lastLogState:      make(map[int]models.DeckState),
		lastLogTime:       make(map[int]time.Time),
		deckCache:         make(map[int][]byte),
		activeDeckStates:  make(map[int]*activeDeckInfo),
		deckVisible:       make(map[int]bool),
		deckHideTimer:     make(map[int]*time.Timer),
		visCache:          make(map[int][]byte),
		forcedVideo:       make(map[int]*models.VideoFile),
		forcedFilename:    make(map[int]string),
		videoSync:         make(map[int]*deckVideoSync),
	}
}

// ── Plugin API ──────────────────────────────────────────

// BroadcastLibraryUpdated sends a library-updated SSE event to all clients,
// indicating the video list has changed and should be refreshed.
// The type parameter is "song" or "transition".
func (h *Handlers) BroadcastLibraryUpdated(libraryType string) {
	data, _ := json.Marshal(map[string]string{"type": libraryType})
	h.hub.Broadcast("library-updated", data)
	slog.Info("library updated broadcast", "type", libraryType)

	// If the song library changed, verify the loop video still exists.
	// If the file was deleted, clear the config so clients stop using
	// a stale path.
	if libraryType == "song" {
		h.checkLoopVideoExists()
	}
}

// checkLoopVideoExists verifies that the configured loop_video path still
// exists in the song video library.  If the file has been deleted, this
// clears both the loop_video and loop_video_enabled config keys and
// broadcasts the changes so all clients react.
func (h *Handlers) checkLoopVideoExists() {
	loopPath := h.cfg.Get("loop_video", "")
	if loopPath == "" {
		return // nothing configured
	}

	if _, ok := h.matcher.GetByPath(loopPath); ok {
		return // file still exists
	}

	slog.Info("loop video no longer in library, clearing config", "path", loopPath)

	// Clear loop_video
	if err := h.cfg.Set("loop_video", ""); err != nil {
		slog.Error("failed to clear loop_video config", "error", err)
		return
	}
	payload, _ := json.Marshal(map[string]string{"key": "loop_video", "value": ""})
	sseMsg := fmt.Appendf(nil, "event: config-updated\ndata: %s\n\n", payload)
	h.deckCacheMu.Lock()
	if h.configCache == nil {
		h.configCache = make(map[string][]byte)
	}
	h.configCache["loop_video"] = sseMsg
	h.deckCacheMu.Unlock()
	h.hub.Broadcast("config-updated", payload)

	// Also disable loop_video_enabled
	if h.cfg.Get("loop_video_enabled", "0") == "1" {
		if err := h.cfg.Set("loop_video_enabled", "0"); err != nil {
			slog.Error("failed to clear loop_video_enabled config", "error", err)
			return
		}
		payload2, _ := json.Marshal(map[string]string{"key": "loop_video_enabled", "value": "0"})
		sseMsg2 := fmt.Appendf(nil, "event: config-updated\ndata: %s\n\n", payload2)
		h.deckCacheMu.Lock()
		h.configCache["loop_video_enabled"] = sseMsg2
		h.deckCacheMu.Unlock()
		h.hub.Broadcast("config-updated", payload2)
	}
}

// SetAnalysing updates the analysis flag and broadcasts the status via SSE.
func (h *Handlers) SetAnalysing(v bool) {
	h.analysingMu.Lock()
	h.analysing = v
	h.analysingMu.Unlock()

	status := "running"
	if !v {
		status = "done"
	}
	data, _ := json.Marshal(map[string]string{"status": status})
	sseMsg := fmt.Appendf(nil, "event: analysis-status\ndata: %s\n\n", data)

	// Cache for new SSE clients
	h.deckCacheMu.Lock()
	h.analysisCache = sseMsg
	h.deckCacheMu.Unlock()

	h.hub.Broadcast("analysis-status", data)
}

// maxDecks is the maximum number of decks this application supports.
const maxDecks = 4

// HandleDeckUpdate receives deck state from the VDJ plugin.
func (h *Handlers) HandleDeckUpdate(w http.ResponseWriter, r *http.Request) {
	// Ignore VDJ updates while BPM analysis is running
	h.analysingMu.Lock()
	busy := h.analysing
	h.analysingMu.Unlock()
	if busy {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	var state models.DeckState
	if err := json.Unmarshal(body, &state); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	// Ignore invalid or out-of-range decks.
	if state.Deck < 1 || state.Deck > maxDecks {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Try to match a video for this deck (tiered fallback)
	var matched *models.VideoFile

	// Check for forced video override
	h.forcedMu.Lock()
	if fv, ok := h.forcedVideo[state.Deck]; ok {
		// Clear the override if the deck loaded a different song
		if h.forcedFilename[state.Deck] != state.Filename {
			delete(h.forcedVideo, state.Deck)
			delete(h.forcedFilename, state.Deck)
		} else {
			matched = fv
		}
	}
	h.forcedMu.Unlock()

	if matched == nil {
		if v, ok := h.matcher.Match(state.Filename, state.BPM); ok {
			matched = &v
		}
	}

	// ── Video position tracking for levels 2+ (cross-client sync) ──
	var videoElapsedMs *float64
	if matched != nil && matched.MatchLevel >= 2 {
		now := time.Now()
		h.videoSyncMu.Lock()
		vs := h.videoSync[state.Deck]
		if vs == nil {
			vs = &deckVideoSync{}
			h.videoSync[state.Deck] = vs
		}

		// Reset on video change
		if vs.videoPath != matched.Path {
			vs.videoPath = matched.Path
			vs.accumulatedMs = 0
			vs.lastUpdate = now
			vs.lastRate = 1.0
			vs.playing = false
		}

		// Accumulate elapsed time at previous rate (only while playing)
		if vs.playing && !vs.lastUpdate.IsZero() {
			dt := now.Sub(vs.lastUpdate).Seconds() * 1000
			vs.accumulatedMs += dt * vs.lastRate
		}

		// Compute current playback rate (same formula as client-side)
		rate := state.Pitch / 100.0
		if state.BPM > 0 && matched.BPM > 0 {
			rate = (state.Pitch / 100.0) * (state.BPM / matched.BPM)
		}
		if rate < 0.25 {
			rate = 0.25
		} else if rate > 4.0 {
			rate = 4.0
		}

		vs.lastRate = rate
		vs.lastUpdate = now
		vs.playing = state.IsPlaying

		elapsed := vs.accumulatedMs
		videoElapsedMs = &elapsed
		h.videoSyncMu.Unlock()
	}

	// Build the event payload
	event := struct {
		models.DeckState
		Timestamp      time.Time         `json:"timestamp"`
		Video          *models.VideoFile `json:"video,omitempty"`
		VideoElapsedMs *float64          `json:"videoElapsedMs,omitempty"`
	}{
		DeckState:      state,
		Timestamp:      time.Now(),
		Video:          matched,
		VideoElapsedMs: videoElapsedMs,
	}

	data, _ := json.Marshal(event)

	// ── Active deck tracking & transition detection ──
	// Must run BEFORE broadcasting the deck-update so that any transition
	// event reaches clients first.  The Hub is FIFO, so if we broadcast
	// deck-update first the client would try to play a transition that
	// hasn't been preloaded yet → direct swap with no transition video.
	h.checkActiveDeckChange(state, matched)

	// Cache the latest event per deck (for new-client replay) and
	// broadcast immediately to all connected SSE clients.
	sseMsg := fmt.Appendf(nil, "event: deck-update\ndata: %s\n\n", data)
	h.deckCacheMu.Lock()
	h.deckCache[state.Deck] = sseMsg
	h.deckCacheMu.Unlock()
	h.hub.Broadcast("deck-update", data)

	// ── Deck 3/4 visibility ──
	if state.Deck > 2 && state.Deck <= maxDecks {
		h.updateDeckVisibility(state.Deck, state.IsPlaying)
	}

	// ── Logging: realtime for key state changes, throttled for frequent fields ──
	h.logMu.Lock()
	prev, hasPrev := h.lastLogState[state.Deck]

	// Realtime: log immediately when audible, playing, or filename changes
	if !hasPrev || prev.IsAudible != state.IsAudible || prev.IsPlaying != state.IsPlaying || prev.Filename != state.Filename {
		slog.Info("deck state", "deck", state.Deck, "audible", state.IsAudible, "playing", state.IsPlaying, "filename", state.Filename)
	}

	// Throttled (1s): log bpm, volume, elapsedMs, pitch changes
	lastT := h.lastLogTime[state.Deck]
	if time.Since(lastT) >= time.Second {
		if !hasPrev || prev.BPM != state.BPM || prev.Volume != state.Volume || prev.ElapsedMs != state.ElapsedMs || prev.Pitch != state.Pitch {
			slog.Info("deck data", "deck", state.Deck, "bpm", state.BPM, "volume", state.Volume, "elapsedMs", state.ElapsedMs, "pitch", state.Pitch)
			h.lastLogTime[state.Deck] = time.Now()
		}
	}

	h.lastLogState[state.Deck] = state
	h.logMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

// HandleForceVideo forces a specific video to be used for the current active
// deck. Triggers a transition and immediately broadcasts the updated deck
// state with the forced video. The override persists until the deck's song
// (filename) changes.
func (h *Handlers) HandleForceVideo(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Path == "" {
		http.Error(w, "invalid json: path required", http.StatusBadRequest)
		return
	}

	// Find the video in the matcher
	vf, ok := h.matcher.GetByPath(req.Path)
	if !ok {
		http.Error(w, "video not found", http.StatusNotFound)
		return
	}

	// Determine the active deck
	h.activeDeckMu.Lock()
	deck := h.activeDeck
	h.activeDeckMu.Unlock()

	if deck == 0 {
		http.Error(w, "no active deck", http.StatusConflict)
		return
	}

	// Get the current deck state (for filename tracking)
	h.logMu.Lock()
	lastState, exists := h.lastLogState[deck]
	h.logMu.Unlock()
	if !exists {
		http.Error(w, "no deck state available", http.StatusConflict)
		return
	}

	// Mark as forced match — use MatchBPM level so the client applies
	// BPM-based playback rate calculation (not elapsed sync).
	vf.MatchLevel = video.MatchBPM
	vf.MatchType = "forced"
	vf.Similarity = 1.0

	// Store the forced override
	h.forcedMu.Lock()
	h.forcedVideo[deck] = &vf
	h.forcedFilename[deck] = lastState.Filename
	h.forcedMu.Unlock()

	// Reset video position tracking for the forced video
	h.videoSyncMu.Lock()
	h.videoSync[deck] = &deckVideoSync{
		videoPath:  vf.Path,
		lastUpdate: time.Now(),
		lastRate:   1.0,
		playing:    lastState.IsPlaying,
	}
	h.videoSyncMu.Unlock()

	// Play a transition and refill the used slot
	h.activeDeckMu.Lock()
	h.playAndRefillTransition()
	h.activeDeckMu.Unlock()

	// Re-broadcast the deck-update with the forced video
	var zero float64
	event := struct {
		models.DeckState
		Timestamp      time.Time         `json:"timestamp"`
		Video          *models.VideoFile `json:"video,omitempty"`
		VideoElapsedMs *float64          `json:"videoElapsedMs,omitempty"`
	}{
		DeckState:      lastState,
		Timestamp:      time.Now(),
		Video:          &vf,
		VideoElapsedMs: &zero,
	}

	data, _ := json.Marshal(event)
	sseMsg := fmt.Appendf(nil, "event: deck-update\ndata: %s\n\n", data)
	h.deckCacheMu.Lock()
	h.deckCache[deck] = sseMsg
	h.deckCacheMu.Unlock()
	h.hub.Broadcast("deck-update", data)

	slog.Info("video forced", "deck", deck, "video", vf.Name)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "video": vf.Name})
}

// HandleForceDeckVideo forces a specific video on a specific deck (1-4).
// Unlike HandleForceVideo which targets the active (master) deck, this
// allows forcing on any deck that has reported state.
func (h *Handlers) HandleForceDeckVideo(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	var req struct {
		Path string `json:"path"`
		Deck int    `json:"deck"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Path == "" || req.Deck < 1 || req.Deck > maxDecks {
		http.Error(w, "invalid json: path and deck (1-4) required", http.StatusBadRequest)
		return
	}

	// Find the video in the matcher
	vf, ok := h.matcher.GetByPath(req.Path)
	if !ok {
		http.Error(w, "video not found", http.StatusNotFound)
		return
	}

	deck := req.Deck

	// Get the current deck state (for filename tracking)
	h.logMu.Lock()
	lastState, exists := h.lastLogState[deck]
	h.logMu.Unlock()
	if !exists {
		http.Error(w, "deck has no state (not active in VDJ)", http.StatusConflict)
		return
	}

	// Mark as forced match
	vf.MatchLevel = video.MatchBPM
	vf.MatchType = "forced"
	vf.Similarity = 1.0

	// Store the forced override
	h.forcedMu.Lock()
	h.forcedVideo[deck] = &vf
	h.forcedFilename[deck] = lastState.Filename
	h.forcedMu.Unlock()

	// Reset video position tracking for the forced video
	h.videoSyncMu.Lock()
	h.videoSync[deck] = &deckVideoSync{
		videoPath:  vf.Path,
		lastUpdate: time.Now(),
		lastRate:   1.0,
		playing:    lastState.IsPlaying,
	}
	h.videoSyncMu.Unlock()

	// If forcing on the active deck, play a transition
	h.activeDeckMu.Lock()
	if deck == h.activeDeck {
		h.playAndRefillTransition()
	}
	h.activeDeckMu.Unlock()

	// For decks 3/4, ensure they become visible on the dashboard
	if deck > 2 {
		h.updateDeckVisibility(deck, true)
	}

	// Re-broadcast the deck-update with the forced video
	var zero float64
	event := struct {
		models.DeckState
		Timestamp      time.Time         `json:"timestamp"`
		Video          *models.VideoFile `json:"video,omitempty"`
		VideoElapsedMs *float64          `json:"videoElapsedMs,omitempty"`
	}{
		DeckState:      lastState,
		Timestamp:      time.Now(),
		Video:          &vf,
		VideoElapsedMs: &zero,
	}

	data, _ := json.Marshal(event)
	sseMsg := fmt.Appendf(nil, "event: deck-update\ndata: %s\n\n", data)
	h.deckCacheMu.Lock()
	h.deckCache[deck] = sseMsg
	h.deckCacheMu.Unlock()
	h.hub.Broadcast("deck-update", data)

	slog.Info("video forced on deck", "deck", deck, "video", vf.Name)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "video": vf.Name, "deck": fmt.Sprintf("%d", deck)})
}

// HandleVideoEnded is called by the player client when a video reaches its
// natural end (song outlasts video). Behaviour depends on match level:
//
//   - Levels 0-1: broadcast a fresh transition event (client loops the same
//     video locally). Response: {"action":"loop"}.
//   - Levels 2+: pick a different random video, store as forced override,
//     reset video sync, broadcast transition + deck-update so all clients
//     switch. Response: {"action":"switch"} or {"action":"loop"} if only
//     one video is available.
func (h *Handlers) HandleVideoEnded(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	var req struct {
		Deck         int    `json:"deck"`
		MatchLevel   int    `json:"matchLevel"`
		CurrentVideo string `json:"currentVideo"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Deck == 0 {
		http.Error(w, "invalid json: deck required", http.StatusBadRequest)
		return
	}
	if req.Deck > maxDecks {
		http.Error(w, "deck out of range", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if req.MatchLevel <= 1 {
		// Levels 0-1: client loops the video locally; refresh the pool
		// so there's a fresh transition video for next time.
		h.refillAndBroadcastPool()
		slog.Info("video ended (loop)", "deck", req.Deck, "level", req.MatchLevel)
		json.NewEncoder(w).Encode(map[string]string{"action": "loop"})
		return
	}

	// Levels 2+: switch to a different random video.
	h.logMu.Lock()
	lastState, exists := h.lastLogState[req.Deck]
	h.logMu.Unlock()
	if !exists {
		http.Error(w, "no deck state available", http.StatusConflict)
		return
	}

	vf, ok := h.matcher.RandomExcluding(req.CurrentVideo, lastState.BPM)
	if !ok {
		http.Error(w, "no videos available", http.StatusNotFound)
		return
	}

	// If only one video exists we can't avoid repeating it — just loop.
	if vf.Path == req.CurrentVideo {
		h.refillAndBroadcastPool()
		slog.Info("video ended (loop, single video)", "deck", req.Deck)
		json.NewEncoder(w).Encode(map[string]string{"action": "loop"})
		return
	}

	// Store as forced override (cleared when the deck's song changes)
	h.forcedMu.Lock()
	h.forcedVideo[req.Deck] = &vf
	h.forcedFilename[req.Deck] = lastState.Filename
	h.forcedMu.Unlock()

	// Reset video position tracking
	h.videoSyncMu.Lock()
	h.videoSync[req.Deck] = &deckVideoSync{
		videoPath:  vf.Path,
		lastUpdate: time.Now(),
		lastRate:   1.0,
		playing:    lastState.IsPlaying,
	}
	h.videoSyncMu.Unlock()

	// Broadcast deck-update with the new video first (client plays the
	// already-preloaded transition), then broadcast a fresh transition
	// for preloading.
	var zero float64
	event := struct {
		models.DeckState
		Timestamp      time.Time         `json:"timestamp"`
		Video          *models.VideoFile `json:"video,omitempty"`
		VideoElapsedMs *float64          `json:"videoElapsedMs,omitempty"`
	}{
		DeckState:      lastState,
		Timestamp:      time.Now(),
		Video:          &vf,
		VideoElapsedMs: &zero,
	}
	data, _ := json.Marshal(event)
	sseMsg := fmt.Appendf(nil, "event: deck-update\ndata: %s\n\n", data)
	h.deckCacheMu.Lock()
	h.deckCache[req.Deck] = sseMsg
	h.deckCacheMu.Unlock()
	h.hub.Broadcast("deck-update", data)

	// Refresh the transition pool for the next video-end or deck switch.
	h.refillAndBroadcastPool()

	slog.Info("video ended (switch)", "deck", req.Deck, "from", req.CurrentVideo, "to", vf.Path)
	json.NewEncoder(w).Encode(map[string]string{"action": "switch", "video": vf.Name})
}

// checkActiveDeckChange recalculates which deck is "active" (highest volume,
// audible, playing, with a matched video). When the active deck changes from
// one deck to another, it broadcasts a "transition" SSE event with a randomly
// selected transition video so all clients play the same transition.
func (h *Handlers) checkActiveDeckChange(state models.DeckState, matched *models.VideoFile) {
	h.activeDeckMu.Lock()
	defer h.activeDeckMu.Unlock()

	// Update per-deck tracking
	if h.activeDeckStates[state.Deck] == nil {
		h.activeDeckStates[state.Deck] = &activeDeckInfo{}
	}
	info := h.activeDeckStates[state.Deck]
	info.IsAudible = state.IsAudible
	info.IsPlaying = state.IsPlaying
	info.Volume = state.Volume
	info.HasVideo = matched != nil

	// Determine the best deck (same logic as client-side updatePriority)
	bestDeck := 0
	bestVolume := -1.0
	for d, di := range h.activeDeckStates {
		if di.IsAudible && di.IsPlaying && di.HasVideo {
			// Prefer the current active deck on ties to avoid flip-flopping
			// (Go map iteration order is random, so strict > can oscillate)
			if di.Volume > bestVolume || (di.Volume == bestVolume && d == h.activeDeck) {
				bestVolume = di.Volume
				bestDeck = d
			}
		}
	}

	// If no qualified deck, keep the last active one
	if bestDeck == 0 && h.activeDeck != 0 {
		bestDeck = h.activeDeck
	}

	// No change
	if bestDeck == h.activeDeck {
		return
	}

	prevDeck := h.activeDeck
	h.activeDeck = bestDeck

	if prevDeck == 0 && bestDeck != 0 {
		// First deck became active — fill the pool so clients have
		// transitions ready for the first crossfade.
		h.fillTransitionPool()
		h.broadcastTransitionPool()
	} else if prevDeck != 0 && bestDeck != 0 {
		// Switching from one deck to another — tell clients to play
		// a transition, then refill the used slot.
		h.playAndRefillTransition()
	}
}

// pickRandomTransition picks a random transition video, excluding the given
// paths to avoid putting duplicate videos in the pool.
// Must be called with activeDeckMu held.
func (h *Handlers) pickRandomTransition(excludePaths []string) *transitionPoolEntry {
	if dir := h.cfg.Get("transition_videos_dir", ""); dir != "" && dir != h.transitionMatcher.Dir() {
		h.transitionMatcher.SetDir(dir)
	}
	videos := h.transitionMatcher.ListAll()
	if len(videos) == 0 {
		return nil
	}

	if len(excludePaths) > 0 && len(videos) > 1 {
		excludeSet := make(map[string]bool, len(excludePaths))
		for _, p := range excludePaths {
			excludeSet[p] = true
		}
		filtered := make([]models.VideoFile, 0, len(videos))
		for _, v := range videos {
			if !excludeSet[v.Path] {
				filtered = append(filtered, v)
			}
		}
		if len(filtered) > 0 {
			videos = filtered
		}
	}

	chosen := videos[rand.IntN(len(videos))]
	return &transitionPoolEntry{Video: chosen.Path, BPM: chosen.BPM}
}

// fillTransitionPool fills any empty slots in the transition pool.
// Must be called with activeDeckMu held.
func (h *Handlers) fillTransitionPool() {
	for i := range h.transitionPool {
		if h.transitionPool[i] == nil {
			// Collect paths from already-filled slots to avoid duplicates
			var exclude []string
			for j, e := range h.transitionPool {
				if j != i && e != nil {
					exclude = append(exclude, e.Video)
				}
			}
			h.transitionPool[i] = h.pickRandomTransition(exclude)
		}
	}
}

// broadcastTransitionPool sends the current 3-slot pool to all clients.
// Must be called with activeDeckMu held.
func (h *Handlers) broadcastTransitionPool() {
	payload := struct {
		Slots [3]*transitionPoolEntry `json:"slots"`
	}{
		Slots: h.transitionPool,
	}
	data, _ := json.Marshal(payload)

	h.deckCacheMu.Lock()
	h.transitionPoolCache = fmt.Appendf(nil, "event: transition-pool\ndata: %s\n\n", data)
	h.deckCacheMu.Unlock()

	h.hub.Broadcast("transition-pool", data)
	slog.Info("transition pool broadcast",
		"slot0", h.transitionPool[0],
		"slot1", h.transitionPool[1],
		"slot2", h.transitionPool[2])
}

// playAndRefillTransition tells clients to play the next transition slot,
// then refills that slot with a new random pick and broadcasts the updated pool.
// Must be called with activeDeckMu held.
func (h *Handlers) playAndRefillTransition() {
	slot := h.transitionNextSlot

	// Pick random enabled "in" and "out" effects
	var inCSS, outCSS string
	if fx, err := h.transitions.RandomEnabled("in"); err == nil && fx != nil {
		inCSS = fx.CSS
	}
	if fx, err := h.transitions.RandomEnabled("out"); err == nil && fx != nil {
		outCSS = fx.CSS
	}

	// Broadcast play command with CSS effects
	playPayload := struct {
		Slot   int    `json:"slot"`
		InCSS  string `json:"inCSS,omitempty"`
		OutCSS string `json:"outCSS,omitempty"`
	}{Slot: slot, InCSS: inCSS, OutCSS: outCSS}
	playData, _ := json.Marshal(playPayload)
	h.hub.Broadcast("transition-play", playData)

	entry := h.transitionPool[slot]
	var playedVideo string
	if entry != nil {
		playedVideo = entry.Video
	}
	slog.Info("transition play", "slot", slot, "video", playedVideo)

	// Advance to the next slot for next time
	h.transitionNextSlot = (slot + 1) % 3

	// Refill the used slot with a new pick (different from the other slots)
	var exclude []string
	for i, e := range h.transitionPool {
		if i != slot && e != nil {
			exclude = append(exclude, e.Video)
		}
	}
	h.transitionPool[slot] = h.pickRandomTransition(exclude)

	// Broadcast the updated pool so clients preload the new video
	h.broadcastTransitionPool()
}

// refillAndBroadcastPool is a convenience wrapper for callers that don't
// need to play a transition but want to refresh the pool (e.g. video-ended
// loops). It acquires activeDeckMu, refills empty slots, and broadcasts.
func (h *Handlers) refillAndBroadcastPool() {
	h.activeDeckMu.Lock()
	defer h.activeDeckMu.Unlock()

	// Mark the next slot as used (pick a fresh video) so the pool rotates
	slot := h.transitionNextSlot
	var exclude []string
	for i, e := range h.transitionPool {
		if i != slot && e != nil {
			exclude = append(exclude, e.Video)
		}
	}
	h.transitionPool[slot] = h.pickRandomTransition(exclude)
	h.transitionNextSlot = (slot + 1) % 3
	h.broadcastTransitionPool()
}

// ── Deck 3/4 Visibility ────────────────────────────────

// deckHideDelay is how long a paused deck 3/4 waits before being hidden.
const deckHideDelay = 60 * time.Second

// updateDeckVisibility manages server-side timers for deck 3/4 auto-hide.
// When a deck starts playing it is made visible immediately.
// When it stops playing a 60-second timer starts; on expiry the deck is hidden.
func (h *Handlers) updateDeckVisibility(deck int, isPlaying bool) {
	h.deckVisMu.Lock()
	defer h.deckVisMu.Unlock()

	if isPlaying {
		// Cancel any pending hide timer
		if t, ok := h.deckHideTimer[deck]; ok {
			t.Stop()
			delete(h.deckHideTimer, deck)
		}
		// Show if not already visible
		if !h.deckVisible[deck] {
			h.deckVisible[deck] = true
			h.broadcastDeckVisibility(deck, true)
		}
	} else {
		// Already hidden or timer already running — nothing to do
		if !h.deckVisible[deck] || h.deckHideTimer[deck] != nil {
			return
		}
		// Start hide timer
		h.deckHideTimer[deck] = time.AfterFunc(deckHideDelay, func() {
			h.deckVisMu.Lock()
			defer h.deckVisMu.Unlock()
			h.deckVisible[deck] = false
			delete(h.deckHideTimer, deck)
			h.broadcastDeckVisibility(deck, false)
		})
	}
}

// broadcastDeckVisibility sends a deck-visibility SSE event and caches it.
// Must be called with deckVisMu held.
func (h *Handlers) broadcastDeckVisibility(deck int, visible bool) {
	payload := struct {
		Deck    int  `json:"deck"`
		Visible bool `json:"visible"`
	}{Deck: deck, Visible: visible}
	data, _ := json.Marshal(payload)

	sseMsg := fmt.Appendf(nil, "event: deck-visibility\ndata: %s\n\n", data)

	h.deckCacheMu.Lock()
	h.visCache[deck] = sseMsg
	h.deckCacheMu.Unlock()

	h.hub.Broadcast("deck-visibility", data)
	slog.Info("deck visibility", "deck", deck, "visible", visible)
}

// ── SSE ─────────────────────────────────────────────────

// HandleSSE streams server-sent events to browser clients.
func (h *Handlers) HandleSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	client := &sse.Client{
		ID:     fmt.Sprintf("%d", time.Now().UnixNano()),
		Events: make(chan []byte, 256),
	}

	h.hub.Register(client)
	defer h.hub.Unregister(client)

	// Send initial keepalive
	fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	// Replay cached states so new clients get synced immediately
	h.deckCacheMu.RLock()
	if h.analysisCache != nil {
		w.Write(h.analysisCache)
	}
	for _, msg := range h.visCache {
		w.Write(msg)
	}
	for _, msg := range h.deckCache {
		w.Write(msg)
	}
	if h.transitionPoolCache != nil {
		w.Write(h.transitionPoolCache)
	}
	for _, msg := range h.configCache {
		w.Write(msg)
	}
	h.deckCacheMu.RUnlock()
	flusher.Flush()

	for {
		select {
		case msg, ok := <-client.Events:
			if !ok {
				return
			}
			w.Write(msg)
			// Drain any queued messages before flushing so multiple
			// events batch into a single TCP write.
		drain:
			for {
				select {
				case extra, ok := <-client.Events:
					if !ok {
						flusher.Flush()
						return
					}
					w.Write(extra)
				default:
					break drain
				}
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

// ── Pages ───────────────────────────────────────────────

// HandleIndex redirects to the dashboard.
func (h *Handlers) HandleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.Redirect(w, r, "/dashboard", http.StatusFound)
}

// HandleDashboard renders the dashboard page.
// If X-SPA header is set, only the <main> partial is returned.
func (h *Handlers) HandleDashboard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Header.Get("X-SPA") != "" {
		pages.DashboardContent().Render(r.Context(), w)
	} else {
		pages.Dashboard().Render(r.Context(), w)
	}
}

// HandleLibrary renders the video library page.
// If X-SPA header is set, only the <main> partial is returned.
func (h *Handlers) HandleLibrary(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Header.Get("X-SPA") != "" {
		pages.LibraryContent().Render(r.Context(), w)
	} else {
		pages.Library().Render(r.Context(), w)
	}
}

// HandlePlayer renders the video player page.
func (h *Handlers) HandlePlayer(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	pages.Player().Render(r.Context(), w)
}

// ── Dashboard API ───────────────────────────────────────

// HandleGetConfig returns all config as JSON.
func (h *Handlers) HandleGetConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(h.cfg.All())
}

// HandleSetConfig saves a config key-value pair.
func (h *Handlers) HandleSetConfig(w http.ResponseWriter, r *http.Request) {
	var entry models.ConfigEntry
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&entry); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := h.cfg.Set(entry.Key, entry.Value); err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}

	// Broadcast config change to all clients via SSE
	payload := map[string]string{"key": entry.Key, "value": entry.Value}
	data, _ := json.Marshal(payload)
	sseMsg := fmt.Appendf(nil, "event: config-updated\ndata: %s\n\n", data)
	h.deckCacheMu.Lock()
	if h.configCache == nil {
		h.configCache = make(map[string][]byte)
	}
	h.configCache[entry.Key] = sseMsg
	h.deckCacheMu.Unlock()
	h.hub.Broadcast("config-updated", data)

	w.WriteHeader(http.StatusNoContent)
}

// HandleListVideos returns the list of available video files.
// Use ?type=transition to list transition videos instead of song videos.
func (h *Handlers) HandleListVideos(w http.ResponseWriter, r *http.Request) {
	isTransition := r.URL.Query().Get("type") == "transition"

	var m *video.Matcher
	var configKey string
	if isTransition {
		m = h.transitionMatcher
		configKey = "transition_videos_dir"
	} else {
		m = h.matcher
		configKey = "videos_dir"
	}

	if dir := h.cfg.Get(configKey, ""); dir != "" && dir != m.Dir() {
		m.SetDir(dir)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(m.ListAll())
}

// ── Transitions Page ────────────────────────────────────

// broadcastTransitionsUpdated sends a transitions-updated SSE event to all
// connected clients so they can refresh their transition effects list.
func (h *Handlers) broadcastTransitionsUpdated() {
	data := []byte(`{}`)
	h.hub.Broadcast("transitions-updated", data)
}

// HandleTransitions renders the transitions management page.
// If X-SPA header is set, only the <main> partial is returned.
func (h *Handlers) HandleTransitions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Header.Get("X-SPA") != "" {
		pages.TransitionsContent().Render(r.Context(), w)
	} else {
		pages.Transitions().Render(r.Context(), w)
	}
}

// ── Transitions API ─────────────────────────────────────

// HandleListTransitions returns all transition effects as JSON.
// Use ?direction=in or ?direction=out to filter.
func (h *Handlers) HandleListTransitions(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("direction")
	effects, err := h.transitions.List(dir)
	if err != nil {
		slog.Error("list transitions", "error", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	if effects == nil {
		effects = []models.TransitionEffect{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(effects)
}

// HandleCreateTransition creates a new transition effect.
func (h *Handlers) HandleCreateTransition(w http.ResponseWriter, r *http.Request) {
	var req models.TransitionEffect
	if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if req.Name == "" || (req.Direction != "in" && req.Direction != "out") || req.CSS == "" {
		http.Error(w, "name, direction (in/out), and css are required", http.StatusBadRequest)
		return
	}
	effect, err := h.transitions.Create(req.Name, req.Direction, req.CSS)
	if err != nil {
		slog.Error("create transition", "error", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	h.broadcastTransitionsUpdated()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(effect)
}

// HandleUpdateTransition updates an existing transition effect.
func (h *Handlers) HandleUpdateTransition(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	var req models.TransitionEffect
	if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if req.Name == "" || (req.Direction != "in" && req.Direction != "out") || req.CSS == "" {
		http.Error(w, "name, direction (in/out), and css are required", http.StatusBadRequest)
		return
	}
	if err := h.transitions.Update(id, req.Name, req.Direction, req.CSS); err != nil {
		slog.Error("update transition", "error", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	h.broadcastTransitionsUpdated()
	w.WriteHeader(http.StatusNoContent)
}

// HandleToggleTransition toggles the enabled state of a transition effect.
func (h *Handlers) HandleToggleTransition(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 256)).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := h.transitions.SetEnabled(id, body.Enabled); err != nil {
		slog.Error("toggle transition", "error", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	h.broadcastTransitionsUpdated()
	w.WriteHeader(http.StatusNoContent)
}

// HandleDeleteTransition deletes a transition effect.
// Built-in seed effects cannot be deleted (returns 403).
func (h *Handlers) HandleDeleteTransition(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	if err := h.transitions.Delete(id); err != nil {
		if errors.Is(err, transitions.ErrSeedProtected) {
			http.Error(w, "built-in effects cannot be deleted", http.StatusForbidden)
			return
		}
		slog.Error("delete transition", "error", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	h.broadcastTransitionsUpdated()
	w.WriteHeader(http.StatusNoContent)
}

// HandleRandomPreviewVideos returns 2 random song videos and 1 random transition video for preview.
func (h *Handlers) HandleRandomPreviewVideos(w http.ResponseWriter, r *http.Request) {
	songVideos := h.matcher.ListAll()
	transVideos := h.transitionMatcher.ListAll()

	type previewVideos struct {
		Before     string `json:"before"`
		Transition string `json:"transition"`
		After      string `json:"after"`
	}

	var result previewVideos
	if len(songVideos) >= 2 {
		i := rand.IntN(len(songVideos))
		j := rand.IntN(len(songVideos))
		for j == i && len(songVideos) > 1 {
			j = rand.IntN(len(songVideos))
		}
		result.Before = songVideos[i].Path
		result.After = songVideos[j].Path
	} else if len(songVideos) == 1 {
		result.Before = songVideos[0].Path
		result.After = songVideos[0].Path
	}
	if len(transVideos) > 0 {
		result.Transition = transVideos[rand.IntN(len(transVideos))].Path
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}
