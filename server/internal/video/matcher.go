package video

import (
	"context"
	"hash/fnv"
	"log/slog"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jota2rz/vdj-video-sync/server/internal/bpm"
	"github.com/jota2rz/vdj-video-sync/server/internal/models"
)

// Supported video file extensions.
var videoExts = map[string]bool{
	".mp4": true,
}

// Match level constants (0 = best, 5 = worst).
const (
	MatchExact    = 0 // Exact filename (with extension)
	MatchStem     = 1 // Filename without extension
	MatchFuzzy    = 2 // ≥70% filename similarity
	MatchBPMFuzzy = 3 // Closest BPM + ≥30% filename similarity
	MatchBPM      = 4 // Closest BPM (random among ties)
	MatchRandom   = 5 // Any random video
)

// Similarity thresholds.
const (
	fuzzyThreshold    = 0.70 // Level 2: minimum filename similarity
	bpmFuzzyThreshold = 0.30 // Level 3: minimum filename similarity with BPM
	halfTimeTolerance = 3.0  // BPM tolerance for half-time detection
)

// indexedFile stores a video file with its pre-computed lowercase stem
// for fast matching. Stems are computed once during scan and reused
// across all Match() calls.
type indexedFile struct {
	file models.VideoFile
	stem string // lowercase name without extension
}

// Matcher scans a directory for video files and matches them by
// filename, similarity, or BPM using a tiered fallback strategy.
type Matcher struct {
	dir          string
	pathPrefix   string
	bpmCache     *bpm.Cache // optional; nil disables BPM analysis
	mu           sync.RWMutex
	indexed      []indexedFile   // pre-computed stems
	bpmMu        sync.Mutex      // protects bpmCorrected (separate from mu to avoid contention)
	bpmCorrected map[string]bool // paths whose BPM has been half-time corrected (prevent re-correction)
}

// NewMatcher creates a Matcher for the given directory.
// pathPrefix is prepended to filenames in the served path (e.g. "/videos/").
// bpmCache is optional (pass nil to skip audio BPM analysis).
// The matcher starts empty — call Scan() to populate it.
func NewMatcher(dir string, pathPrefix string, bpmCache *bpm.Cache) *Matcher {
	return &Matcher{dir: dir, pathPrefix: pathPrefix, bpmCache: bpmCache, bpmCorrected: make(map[string]bool)}
}

// SetDir updates the directory to scan for videos.
func (m *Matcher) SetDir(dir string) {
	m.mu.Lock()
	m.dir = dir
	m.mu.Unlock()
}

// Dir returns the current video directory.
func (m *Matcher) Dir() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.dir
}

// Scan re-reads the video directory and caches the file list.
// For MP4 files with a BPM cache, it analyses audio to detect BPM.
func (m *Matcher) Scan() {
	m.mu.RLock()
	dir := m.dir
	m.mu.RUnlock()

	entries, err := os.ReadDir(dir)
	if err != nil {
		slog.Warn("video scan failed", "dir", dir, "error", err)
		return
	}

	indexed := make([]indexedFile, 0, len(entries))

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if !videoExts[ext] {
			continue
		}

		vf := models.VideoFile{
			Name: e.Name(),
			Path: m.pathPrefix + e.Name(),
		}

		// Try filename-based BPM first (e.g. "track_128bpm.mp4")
		vf.BPM = parseBPMFromName(e.Name())

		// If no filename BPM and we have a cache, try audio analysis (MP4 only)
		if vf.BPM <= 0 && m.bpmCache != nil && ext == ".mp4" {
			absPath := filepath.Join(dir, e.Name())
			vf.BPM = m.analyseBPM(absPath, e)
		}

		indexed = append(indexed, indexedFile{
			file: vf,
			stem: strings.ToLower(strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))),
		})
	}

	m.mu.Lock()
	m.indexed = indexed
	m.mu.Unlock()

	var analysed int
	for _, ix := range indexed {
		if ix.file.BPM > 0 {
			analysed++
		}
	}
	slog.Info("video scan complete", "count", len(indexed), "withBPM", analysed)
}

// analyseBPM checks the cache for a stored BPM, or runs audio analysis.
func (m *Matcher) analyseBPM(absPath string, entry os.DirEntry) float64 {
	info, err := entry.Info()
	if err != nil {
		return 0
	}
	modTime := info.ModTime().Unix()

	// Check cache first
	if cached, ok := m.bpmCache.Get(absPath, modTime); ok {
		slog.Debug("bpm cache hit", "file", entry.Name(), "bpm", cached)
		return cached
	}

	// Run audio analysis
	detected, err := bpm.AnalyseFile(absPath)
	if err != nil {
		slog.Warn("bpm analysis failed", "file", entry.Name(), "error", err)
		return 0
	}

	if detected > 0 {
		// Store in cache
		if err := m.bpmCache.Set(absPath, modTime, detected); err != nil {
			slog.Warn("bpm cache write failed", "file", entry.Name(), "error", err)
		}
		slog.Info("bpm detected", "file", entry.Name(), "bpm", detected)
	}

	return detected
}

// analyseBPMDirect checks the cache or runs audio analysis using a file
// path, name, and mod time directly (without an os.DirEntry).
func (m *Matcher) analyseBPMDirect(absPath, name string, modTime int64) float64 {
	if cached, ok := m.bpmCache.Get(absPath, modTime); ok {
		slog.Debug("bpm cache hit", "file", name, "bpm", cached)
		return cached
	}

	detected, err := bpm.AnalyseFile(absPath)
	if err != nil {
		slog.Warn("bpm analysis failed", "file", name, "error", err)
		return 0
	}

	if detected > 0 {
		if err := m.bpmCache.Set(absPath, modTime, detected); err != nil {
			slog.Warn("bpm cache write failed", "file", name, "error", err)
		}
		slog.Info("bpm detected", "file", name, "bpm", detected)
	}
	return detected
}

// ── Directory Watching ──────────────────────────────────

// dirSnapshot reads the video directory and returns a map of video files
// keyed by name with their modification times. The directory path is
// captured under lock and returned to avoid races with SetDir().
func (m *Matcher) dirSnapshot() (map[string]int64, string) {
	m.mu.RLock()
	dir := m.dir
	m.mu.RUnlock()

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, dir
	}

	snap := make(map[string]int64, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if !videoExts[ext] {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		snap[e.Name()] = info.ModTime().Unix()
	}
	return snap, dir
}

// Watch polls the video directory at the given interval and calls onChange
// whenever files are added, modified, or deleted. Only changed files are
// processed (incremental scan). Cancel the context to stop watching.
func (m *Matcher) Watch(ctx context.Context, interval time.Duration, onChange func()) {
	prev, _ := m.dirSnapshot()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			curr, dir := m.dirSnapshot()
			if curr == nil {
				continue
			}
			if !snapshotsEqual(prev, curr) {
				m.applyChanges(prev, curr, dir)
				if onChange != nil {
					onChange()
				}
				prev = curr
			}
		}
	}
}

// applyChanges incrementally updates the file list based on the diff
// between the previous and current directory snapshots. Only new/modified
// files are scanned for BPM; deleted files are simply removed. The dir
// parameter is the directory captured at snapshot time to avoid races.
func (m *Matcher) applyChanges(prev, curr map[string]int64, dir string) {
	var added []string   // new or modified file names
	var deleted []string // removed file names

	for name, modTime := range curr {
		oldMod, existed := prev[name]
		if !existed {
			added = append(added, name)
			slog.Info("video added", "file", name)
		} else if modTime != oldMod {
			added = append(added, name)
			slog.Info("video modified", "file", name)
		}
	}
	for name := range prev {
		if _, exists := curr[name]; !exists {
			deleted = append(deleted, name)
			slog.Info("video deleted", "file", name)
		}
	}

	// Build new indexed entries for added/modified files
	newEntries := make(map[string]indexedFile, len(added))
	for _, name := range added {
		ext := strings.ToLower(filepath.Ext(name))
		vf := models.VideoFile{
			Name: name,
			Path: m.pathPrefix + name,
		}
		vf.BPM = parseBPMFromName(name)
		if vf.BPM <= 0 && m.bpmCache != nil && ext == ".mp4" {
			absPath := filepath.Join(dir, name)
			info, err := os.Stat(absPath)
			if err == nil {
				vf.BPM = m.analyseBPMDirect(absPath, name, info.ModTime().Unix())
			}
		}
		newEntries[name] = indexedFile{
			file: vf,
			stem: strings.ToLower(strings.TrimSuffix(name, filepath.Ext(name))),
		}
	}

	// Build a set of deleted names for fast lookup
	deletedSet := make(map[string]bool, len(deleted))
	for _, name := range deleted {
		deletedSet[name] = true
	}

	// Update the file list: keep unchanged, replace modified, drop deleted
	m.mu.Lock()
	result := make([]indexedFile, 0, len(m.indexed))
	for _, ix := range m.indexed {
		if deletedSet[ix.file.Name] {
			continue // removed
		}
		if nix, ok := newEntries[ix.file.Name]; ok {
			result = append(result, nix) // replaced (modified)
			delete(newEntries, ix.file.Name)
		} else {
			result = append(result, ix) // unchanged
		}
	}
	// Append truly new files (not yet in the list)
	for _, nix := range newEntries {
		result = append(result, nix)
	}
	// Keep sorted by filename for consistent library display
	sort.Slice(result, func(i, j int) bool {
		return strings.ToLower(result[i].file.Name) < strings.ToLower(result[j].file.Name)
	})
	m.indexed = result
	m.mu.Unlock()

	slog.Info("incremental scan complete",
		"added", len(added), "deleted", len(deleted), "total", len(result))
}

// snapshotsEqual returns true if both snapshots have the same files with
// the same modification times.
func snapshotsEqual(a, b map[string]int64) bool {
	if len(a) != len(b) {
		return false
	}
	for name, modA := range a {
		if modB, ok := b[name]; !ok || modA != modB {
			return false
		}
	}
	return true
}

// ── Matching ────────────────────────────────────────────

// UpdateBPM updates the in-memory BPM for a video (by path) and persists
// to the cache if available. Used when half-time correction detects a
// more accurate BPM.
func (m *Matcher) UpdateBPM(videoPath string, newBPM float64) {
	m.mu.Lock()
	for i, ix := range m.indexed {
		if ix.file.Path == videoPath {
			m.indexed[i].file.BPM = newBPM
			break
		}
	}
	m.mu.Unlock()

	// Persist to cache if available
	if m.bpmCache != nil {
		dir := m.Dir()
		name := filepath.Base(videoPath)
		absPath := filepath.Join(dir, name)
		info, err := os.Stat(absPath)
		if err == nil {
			_ = m.bpmCache.Set(absPath, info.ModTime().Unix(), newBPM)
			slog.Info("bpm corrected (half-time)", "file", name, "bpm", newBPM)
		}
	}
}

// Match finds the best video match for a song using a tiered fallback:
//
//  0. Exact filename (with extension)
//  1. Filename stem (without extension)
//  2. Fuzzy filename (≥70% similarity)
//  3. Closest BPM + ≥30% filename similarity
//  4. Closest BPM (random among ties)
//  5. Any random video
//
// Also performs half-time BPM correction: if videoBPM*2 is closer to
// deckBPM, the video's BPM is updated and persisted.
// Pre-computed stems avoid redundant string work on hot-path calls.
func (m *Matcher) Match(songFilename string, deckBPM float64) (models.VideoFile, bool) {
	m.mu.RLock()
	indexed := m.indexed // slice header copy; safe for read under RLock
	m.mu.RUnlock()

	if len(indexed) == 0 {
		return models.VideoFile{}, false
	}

	songLower := strings.ToLower(strings.TrimSpace(songFilename))
	songStem := strings.TrimSuffix(songLower, strings.ToLower(filepath.Ext(songLower)))

	// ── Level 0: Exact filename match ──
	for _, ix := range indexed {
		if strings.ToLower(ix.file.Name) == songLower {
			v := ix.file
			v.MatchLevel = MatchExact
			v.MatchType = "exact"
			v.Similarity = 1.0
			m.correctHalfTimeBPM(&v, deckBPM)
			return v, true
		}
	}

	// ── Level 1: Stem match (without extension) ──
	if songStem != "" {
		for _, ix := range indexed {
			if ix.stem == songStem {
				v := ix.file
				v.MatchLevel = MatchStem
				v.MatchType = "stem"
				v.Similarity = 1.0
				m.correctHalfTimeBPM(&v, deckBPM)
				return v, true
			}
		}
	}

	// ── Level 2: Fuzzy filename (≥70% similarity) ──
	bestSim := 0.0
	bestIdx := -1
	for i, ix := range indexed {
		sim := similarity(songStem, ix.stem)
		if sim >= fuzzyThreshold && sim > bestSim {
			bestSim = sim
			bestIdx = i
		}
	}
	if bestIdx >= 0 {
		v := indexed[bestIdx].file
		v.MatchLevel = MatchFuzzy
		v.MatchType = "fuzzy"
		v.Similarity = bestSim
		m.correctHalfTimeBPM(&v, deckBPM)
		return v, true
	}

	// ── Level 3: Closest BPM + ≥30% filename similarity ──
	// Collect candidates, sort by BPM proximity, pick randomly from
	// the top 5 to add variety (prevents the same video every time).
	if deckBPM > 0 {
		type bpmFuzzyCandidate struct {
			ix   indexedFile
			sim  float64
			diff float64
		}
		var candidates []bpmFuzzyCandidate
		for _, ix := range indexed {
			if ix.file.BPM <= 0 {
				continue
			}
			sim := similarity(songStem, ix.stem)
			if sim < bpmFuzzyThreshold {
				continue
			}
			diff := bpmDiff(deckBPM, ix.file.BPM)
			candidates = append(candidates, bpmFuzzyCandidate{ix, sim, diff})
		}
		if len(candidates) > 0 {
			sort.Slice(candidates, func(i, j int) bool {
				return candidates[i].diff < candidates[j].diff
			})
			top := 5
			if len(candidates) < top {
				top = len(candidates)
			}
			pick := stableIndex(songLower, top)
			v := candidates[pick].ix.file
			v.MatchLevel = MatchBPMFuzzy
			v.MatchType = "bpm-fuzzy"
			v.Similarity = candidates[pick].sim
			m.correctHalfTimeBPM(&v, deckBPM)
			return v, true
		}
	}

	// ── Level 4: Closest BPM ──
	// Collect candidates, sort by BPM proximity, pick randomly from
	// the top 5 to add variety.
	if deckBPM > 0 {
		type bpmCandidate struct {
			ix   indexedFile
			diff float64
		}
		var candidates []bpmCandidate
		for _, ix := range indexed {
			if ix.file.BPM <= 0 {
				continue
			}
			diff := bpmDiff(deckBPM, ix.file.BPM)
			candidates = append(candidates, bpmCandidate{ix, diff})
		}
		if len(candidates) > 0 {
			sort.Slice(candidates, func(i, j int) bool {
				return candidates[i].diff < candidates[j].diff
			})
			top := 5
			if len(candidates) < top {
				top = len(candidates)
			}
			pick := stableIndex(songLower, top)
			v := candidates[pick].ix.file
			v.MatchLevel = MatchBPM
			v.MatchType = "bpm"
			m.correctHalfTimeBPM(&v, deckBPM)
			return v, true
		}
	}

	// ── Level 5: Any video (stable pick by song name) ──
	v := indexed[stableIndex(songLower, len(indexed))].file
	v.MatchLevel = MatchRandom
	v.MatchType = "random"
	m.correctHalfTimeBPM(&v, deckBPM)
	return v, true
}

// correctHalfTimeBPM checks if the video's BPM is a half-time false positive.
// If videoBPM*2 is closer to deckBPM than videoBPM itself (within tolerance),
// it doubles the stored BPM and persists the correction.
func (m *Matcher) correctHalfTimeBPM(v *models.VideoFile, deckBPM float64) {
	if v.BPM <= 0 || deckBPM <= 0 {
		return
	}
	// Only correct each video once to prevent flip-flopping when
	// different decks have different BPMs.
	m.bpmMu.Lock()
	if m.bpmCorrected[v.Path] {
		m.bpmMu.Unlock()
		return
	}
	diffDirect := math.Abs(v.BPM - deckBPM)
	diffDoubled := math.Abs(v.BPM*2 - deckBPM)
	if diffDoubled < diffDirect && diffDoubled <= halfTimeTolerance {
		newBPM := v.BPM * 2
		m.bpmCorrected[v.Path] = true
		m.bpmMu.Unlock()
		slog.Info("half-time BPM detected", "video", v.Name, "old", v.BPM, "new", newBPM, "deckBPM", deckBPM)
		v.BPM = newBPM
		m.UpdateBPM(v.Path, newBPM)
	} else {
		m.bpmMu.Unlock()
	}
}

// bpmDiff returns the BPM distance, accounting for half-time:
// min(|a-b|, |a-2b|, |2a-b|)
func bpmDiff(a, b float64) float64 {
	d1 := math.Abs(a - b)
	d2 := math.Abs(a - 2*b)
	d3 := math.Abs(2*a - b)
	return math.Min(d1, math.Min(d2, d3))
}

// stableIndex returns a deterministic index in [0, n) for a given key.
// Used instead of rand.IntN to ensure the same song always picks the
// same video from a pool of ties, preventing infinite video switching
// on repeated Match() calls.
func stableIndex(key string, n int) int {
	h := fnv.New32a()
	h.Write([]byte(key))
	return int(h.Sum32() % uint32(n))
}

// RandomExcluding picks a random video whose served path differs from
// excludePath. If only one video exists it returns that video anyway.
// Used when a video finishes and the caller needs a different one.
func (m *Matcher) RandomExcluding(excludePath string, deckBPM float64) (models.VideoFile, bool) {
	m.mu.RLock()
	indexed := m.indexed
	m.mu.RUnlock()

	if len(indexed) == 0 {
		return models.VideoFile{}, false
	}

	// Build candidates excluding the given path
	candidates := make([]indexedFile, 0, len(indexed))
	for _, ix := range indexed {
		if ix.file.Path != excludePath {
			candidates = append(candidates, ix)
		}
	}

	// If no other video exists, return the excluded one
	if len(candidates) == 0 {
		v := indexed[0].file
		v.MatchLevel = MatchRandom
		v.MatchType = "random"
		m.correctHalfTimeBPM(&v, deckBPM)
		return v, true
	}

	v := candidates[rand.IntN(len(candidates))].file
	v.MatchLevel = MatchRandom
	v.MatchType = "random"
	m.correctHalfTimeBPM(&v, deckBPM)
	return v, true
}

// ListAll returns all discovered video files.
func (m *Matcher) ListAll() []models.VideoFile {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]models.VideoFile, len(m.indexed))
	for i, ix := range m.indexed {
		out[i] = ix.file
	}
	return out
}

// GetByPath returns the video file with the given served path (e.g.
// "/videos/foo.mp4"), or false if not found.
func (m *Matcher) GetByPath(path string) (models.VideoFile, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, ix := range m.indexed {
		if ix.file.Path == path {
			return ix.file, true
		}
	}
	return models.VideoFile{}, false
}

// ── String similarity ───────────────────────────────────

// similarity returns a 0-1 similarity score between two strings using
// the Levenshtein distance normalised by the longer string's length.
func similarity(a, b string) float64 {
	if a == b {
		return 1.0
	}
	la, lb := len(a), len(b)
	if la == 0 || lb == 0 {
		return 0
	}
	d := levenshtein(a, b)
	maxLen := la
	if lb > maxLen {
		maxLen = lb
	}
	return 1.0 - float64(d)/float64(maxLen)
}

// levenshtein computes the edit distance between two strings.
// Uses a single reusable row to minimise allocations.
func levenshtein(a, b string) int {
	la, lb := len(a), len(b)
	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}

	// Single-row DP with in-place update (no second slice)
	row := make([]int, lb+1)
	for j := 0; j <= lb; j++ {
		row[j] = j
	}
	for i := 1; i <= la; i++ {
		prev := row[0]
		row[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			tmp := row[j]
			ins := row[j-1] + 1
			del := row[j] + 1
			sub := prev + cost
			v := ins
			if del < v {
				v = del
			}
			if sub < v {
				v = sub
			}
			row[j] = v
			prev = tmp
		}
	}
	return row[lb]
}

// ── BPM from filename ───────────────────────────────────

// parseBPMFromName tries to extract a BPM value from a filename.
// Expected format: "Something - 128bpm.mp4" or "track_128bpm.mp4"
func parseBPMFromName(name string) float64 {
	lower := strings.ToLower(name)
	idx := strings.Index(lower, "bpm")
	if idx <= 0 {
		return 0
	}

	// Walk backwards from "bpm" to collect digits and dots
	numStr := ""
	for i := idx - 1; i >= 0; i-- {
		c := lower[i]
		if (c >= '0' && c <= '9') || c == '.' {
			numStr = string(c) + numStr
		} else if len(numStr) > 0 {
			break
		}
	}

	var bpmVal float64
	if numStr != "" {
		fmt_scan(numStr, &bpmVal)
	}
	return bpmVal
}

func fmt_scan(s string, v *float64) {
	var result float64
	var decimal float64 = 1
	pastDot := false
	for _, c := range s {
		if c == '.' {
			if pastDot {
				break // second dot → stop parsing
			}
			pastDot = true
			continue
		}
		digit := float64(c - '0')
		if pastDot {
			decimal *= 10
			result += digit / decimal
		} else {
			result = result*10 + digit
		}
	}
	*v = result
}
