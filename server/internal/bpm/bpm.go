// Package bpm provides BPM detection for video files by extracting and
// analysing their audio tracks.
//
// Pipeline:
//  1. Parse MP4 container (abema/go-mp4)
//  2. Detect audio codec (AAC or Opus) by inspecting stsd box entries
//  3. Decode audio frames → mono float32 PCM
//     - AAC:  skrashevich/go-aac
//     - Opus: lostromb/concentus (pure Go, SILK + CELT)
//  4. Energy-based onset detection + autocorrelation → BPM
//
// All dependencies are pure Go — no CGo, no ffmpeg.
package bpm

import (
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"runtime/debug"

	gomp4 "github.com/abema/go-mp4"
	concentus "github.com/lostromb/concentus/go/opus"
	aacdecoder "github.com/skrashevich/go-aac/pkg/decoder"
)

// maxSeconds limits how much audio we analyse (keeps it fast).
const maxSeconds = 30

// ── Public API ──────────────────────────────────────────

// AnalyseFile detects the BPM of a video file's audio track.
// Returns 0 if detection fails or the file has no audio.
func AnalyseFile(path string) (float64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("bpm: open %s: %w", path, err)
	}
	defer f.Close()

	pcm, sampleRate, err := extractPCM(f)
	if err != nil {
		return 0, fmt.Errorf("bpm: extract PCM from %s: %w", path, err)
	}
	if len(pcm) == 0 {
		return 0, fmt.Errorf("bpm: no audio samples in %s", path)
	}

	bpm := detectBPM(pcm, sampleRate)

	// Release PCM buffer and force Go to return freed memory to the OS.
	// debug.FreeOSMemory() runs a full GC then aggressively releases
	// virtual pages — without this Go keeps them mapped for reuse.
	pcm = nil
	debug.FreeOSMemory()

	return bpm, nil
}

// ── Audio codec detection ───────────────────────────────

// audioCodec identifies the audio coding format inside the MP4.
type audioCodec int

const (
	codecUnknown audioCodec = iota
	codecAAC
	codecOpus
)

// detectAudioCodec walks the MP4 box tree to see whether the audio sample
// description uses mp4a (AAC) or Opus.  go-mp4's Probe only tags mp4a as
// CodecMP4A and leaves Opus/AC-3/etc. as CodecUnknown, so we look at the
// actual stsd children ourselves.
func detectAudioCodec(rs io.ReadSeeker) audioCodec {
	if _, err := rs.Seek(0, io.SeekStart); err != nil {
		return codecUnknown
	}

	codec := codecUnknown
	_, _ = gomp4.ReadBoxStructure(rs, func(h *gomp4.ReadHandle) (interface{}, error) {
		if codec != codecUnknown {
			return nil, nil // already found
		}
		switch h.BoxInfo.Type {
		case gomp4.BoxTypeMp4a():
			codec = codecAAC
			return nil, nil
		case gomp4.BoxTypeOpus():
			codec = codecOpus
			return nil, nil
		case gomp4.BoxTypeMoov(), gomp4.BoxTypeTrak(), gomp4.BoxTypeMdia(),
			gomp4.BoxTypeMinf(), gomp4.BoxTypeStbl(), gomp4.BoxTypeStsd():
			// Only expand known container boxes — never mdat (raw media data).
			_, _ = h.Expand()
		}
		return nil, nil
	})
	return codec
}

// ── MP4 → PCM extraction ────────────────────────────────

// extractPCM parses an MP4 file, detects the audio codec, decodes up to
// ~30 seconds of audio, and returns mono float32 PCM + sample rate.
func extractPCM(rs io.ReadSeeker) ([]float32, int, error) {
	// Probe the MP4 structure
	info, err := gomp4.Probe(rs)
	if err != nil {
		return nil, 0, fmt.Errorf("mp4 probe: %w", err)
	}

	// Detect which audio codec is used
	codec := detectAudioCodec(rs)

	// Find the audio track
	audioTrack, err := findAudioTrack(info, codec)
	if err != nil {
		return nil, 0, err
	}

	sampleRate := int(audioTrack.Timescale)

	// Route to the appropriate decoder
	switch codec {
	case codecAAC:
		return decodeAAC(rs, audioTrack, sampleRate)
	case codecOpus:
		return decodeOpus(rs, audioTrack, sampleRate)
	default:
		return nil, 0, fmt.Errorf("unsupported audio codec")
	}
}

// findAudioTrack picks the best audio track from the probe results.
func findAudioTrack(info *gomp4.ProbeInfo, codec audioCodec) (*gomp4.Track, error) {
	// Strategy 1: if codec is AAC, look for CodecMP4A first
	if codec == codecAAC {
		for _, t := range info.Tracks {
			if t.Codec == gomp4.CodecMP4A {
				return t, nil
			}
		}
	}

	// Strategy 2: pick any non-video track with samples
	for _, t := range info.Tracks {
		if t.Codec == gomp4.CodecAVC1 {
			continue
		}
		if len(t.Samples) == 0 || len(t.Chunks) == 0 {
			continue
		}
		// Audio timescales are standard sample rates; video uses 600/24000/etc.
		if isAudioTimescale(t.Timescale) {
			return t, nil
		}
	}

	trackInfo := make([]string, 0, len(info.Tracks))
	for _, t := range info.Tracks {
		trackInfo = append(trackInfo, fmt.Sprintf(
			"id=%d codec=%d ts=%d samples=%d",
			t.TrackID, t.Codec, t.Timescale, len(t.Samples),
		))
	}
	return nil, fmt.Errorf("no audio track found (%d tracks: %v)", len(info.Tracks), trackInfo)
}

// isAudioTimescale returns true if the timescale matches a standard audio
// sample rate (8 kHz – 96 kHz).
func isAudioTimescale(ts uint32) bool {
	switch ts {
	case 8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000:
		return true
	}
	return false
}

// ── AAC decoding ────────────────────────────────────────

func decodeAAC(rs io.ReadSeeker, track *gomp4.Track, sampleRate int) ([]float32, int, error) {
	asc, err := getAudioSpecificConfig(rs)
	if err != nil {
		return nil, 0, fmt.Errorf("get AudioSpecificConfig: %w", err)
	}

	dec := aacdecoder.New()
	if err := dec.SetASC(asc); err != nil {
		return nil, 0, fmt.Errorf("set ASC: %w", err)
	}

	if dec.Config.SampleRate > 0 {
		sampleRate = dec.Config.SampleRate
	}

	maxSamples := sampleRate * maxSeconds
	channels := dec.Config.ChanConfig
	if channels < 1 {
		channels = 1
	}

	// Limit frame count: AAC produces ~1024 PCM samples per frame.
	frameLimit := (maxSamples/1024 + 1) * 2
	samples := buildSampleLocations(track, frameLimit)

	// Pre-allocate mono and reuse a single raw buffer.
	mono := make([]float32, 0, maxSamples)
	var maxRawSize uint32
	for _, loc := range samples {
		if loc.size > maxRawSize {
			maxRawSize = loc.size
		}
	}
	rawBuf := make([]byte, maxRawSize)

	for _, loc := range samples {
		if len(mono) >= maxSamples {
			break
		}
		if _, err := rs.Seek(int64(loc.offset), io.SeekStart); err != nil {
			continue
		}
		raw := rawBuf[:loc.size]
		if _, err := io.ReadFull(rs, raw); err != nil {
			continue
		}
		pcm, err := dec.DecodeFrame(raw)
		if err != nil {
			slog.Debug("bpm: skip AAC frame", "error", err)
			continue
		}
		frameLen := len(pcm) / channels
		for i := 0; i < frameLen; i++ {
			var sum float32
			for ch := 0; ch < channels; ch++ {
				sum += pcm[i*channels+ch]
			}
			mono = append(mono, sum/float32(channels))
		}
	}

	return mono, sampleRate, nil
}

// getAudioSpecificConfig searches the MP4 for an esds descriptor containing
// the AudioSpecificConfig bytes needed by the AAC decoder.
func getAudioSpecificConfig(rs io.ReadSeeker) ([]byte, error) {
	paths := []gomp4.BoxPath{
		{gomp4.BoxTypeMoov(), gomp4.BoxTypeTrak(), gomp4.BoxTypeMdia(), gomp4.BoxTypeMinf(), gomp4.BoxTypeStbl(), gomp4.BoxTypeStsd(), gomp4.BoxTypeMp4a(), gomp4.BoxTypeEsds()},
		{gomp4.BoxTypeMoov(), gomp4.BoxTypeTrak(), gomp4.BoxTypeMdia(), gomp4.BoxTypeMinf(), gomp4.BoxTypeStbl(), gomp4.BoxTypeStsd(), gomp4.BoxTypeMp4a(), gomp4.BoxTypeWave(), gomp4.BoxTypeEsds()},
		{gomp4.BoxTypeMoov(), gomp4.BoxTypeTrak(), gomp4.BoxTypeMdia(), gomp4.BoxTypeMinf(), gomp4.BoxTypeStbl(), gomp4.BoxTypeStsd(), gomp4.BoxTypeEnca(), gomp4.BoxTypeEsds()},
	}

	if _, err := rs.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}

	bips, err := gomp4.ExtractBoxesWithPayload(rs, nil, paths)
	if err != nil {
		return nil, fmt.Errorf("extract esds: %w", err)
	}

	for _, bip := range bips {
		if bip.Info.Type != gomp4.BoxTypeEsds() {
			continue
		}
		esds, ok := bip.Payload.(*gomp4.Esds)
		if !ok {
			continue
		}
		for _, desc := range esds.Descriptors {
			if desc.Tag == gomp4.DecSpecificInfoTag && len(desc.Data) >= 2 {
				return desc.Data, nil
			}
		}
	}

	return nil, fmt.Errorf("AudioSpecificConfig not found in esds")
}

// ── Opus decoding (Concentus — full SILK + CELT) ────────

func decodeOpus(rs io.ReadSeeker, track *gomp4.Track, sampleRate int) ([]float32, int, error) {
	// Concentus requires one of: 8000, 12000, 16000, 24000, 48000
	decoderRate := sampleRate
	if decoderRate != 8000 && decoderRate != 12000 && decoderRate != 16000 &&
		decoderRate != 24000 && decoderRate != 48000 {
		decoderRate = 48000 // safe default for Opus
	}

	// Create a mono decoder (we'll downmix stereo ourselves if needed)
	// Use 2 channels since the stream may be stereo
	dec, err := concentus.NewOpusDecoder(decoderRate, 2)
	if err != nil {
		return nil, 0, fmt.Errorf("create opus decoder: %w", err)
	}

	maxSamples := decoderRate * maxSeconds

	// Limit frame count: Opus produces ~960 PCM samples per frame (20 ms).
	frameLimit := (maxSamples/960 + 1) * 2
	samples := buildSampleLocations(track, frameLimit)

	// Pre-allocate mono and reuse a single raw buffer.
	mono := make([]float32, 0, maxSamples)
	var maxRawSize uint32
	for _, loc := range samples {
		if loc.size > maxRawSize {
			maxRawSize = loc.size
		}
	}
	rawBuf := make([]byte, maxRawSize)

	// Max Opus frame: 120 ms at 48 kHz = 5760 samples per channel × 2 channels
	pcm16 := make([]int16, 5760*2)

	skipErrors := 0

	for _, loc := range samples {
		if len(mono) >= maxSamples {
			break
		}

		// Skip tiny packets (≤3 bytes are typically Opus padding/silence
		// frames that the decoder can't process)
		if loc.size <= 3 {
			continue
		}

		if _, err := rs.Seek(int64(loc.offset), io.SeekStart); err != nil {
			continue
		}
		raw := rawBuf[:loc.size]
		if _, err := io.ReadFull(rs, raw); err != nil {
			continue
		}

		// Decode one Opus packet → S16LE PCM
		nSamples, err := dec.Decode(raw, 0, len(raw), pcm16, 0, 5760, false)
		if err != nil {
			skipErrors++
			continue
		}

		// Downmix stereo → mono and convert int16 → float32
		channels := 2
		for i := 0; i < nSamples; i++ {
			var sum float32
			for ch := 0; ch < channels; ch++ {
				sum += float32(pcm16[i*channels+ch]) / 32768.0
			}
			mono = append(mono, sum/float32(channels))
		}
	}

	if skipErrors > 0 {
		slog.Debug("bpm: skipped undecoded Opus frames", "count", skipErrors, "total", len(samples))
	}

	return mono, decoderRate, nil
}

// ── Shared helpers ──────────────────────────────────────

// sampleLoc describes a single audio sample's position in the file.
type sampleLoc struct {
	offset uint64
	size   uint32
}

// buildSampleLocations creates a flat list of (file-offset, size) for
// audio samples.  limit caps how many entries are returned (0 = all).
func buildSampleLocations(track *gomp4.Track, limit int) []sampleLoc {
	capacity := len(track.Samples)
	if limit > 0 && limit < capacity {
		capacity = limit
	}
	result := make([]sampleLoc, 0, capacity)
	sampleIdx := 0

	for _, chunk := range track.Chunks {
		off := chunk.DataOffset
		for j := uint32(0); j < chunk.SamplesPerChunk; j++ {
			if sampleIdx >= len(track.Samples) {
				return result
			}
			if limit > 0 && len(result) >= limit {
				return result
			}
			sz := track.Samples[sampleIdx].Size
			result = append(result, sampleLoc{offset: off, size: sz})
			off += uint64(sz)
			sampleIdx++
		}
	}

	return result
}

// ── BPM Detection Algorithm ─────────────────────────────

// detectBPM analyses mono PCM audio and returns the dominant BPM.
// Uses energy-based onset detection followed by autocorrelation.
//
// Algorithm:
//  1. Split audio into short windows (~23ms each at 44100Hz)
//  2. Compute RMS energy per window
//  3. Compute spectral flux (energy difference between adjacent windows)
//  4. Half-wave rectify (keep only increases — beats are energy rises)
//  5. Autocorrelate the onset signal to find periodicity
//  6. Find the lag with highest correlation → convert to BPM
//  7. Clamp to [60, 200] BPM range (typical for DJ music)
func detectBPM(pcm []float32, sampleRate int) float64 {
	if len(pcm) == 0 || sampleRate == 0 {
		return 0
	}

	// Window size: 1024 samples ≈ 23ms at 44100Hz
	const windowSize = 1024

	// Step 1: Compute RMS energy per window
	numWindows := len(pcm) / windowSize
	if numWindows < 4 {
		return 0
	}

	energy := make([]float64, numWindows)
	for i := 0; i < numWindows; i++ {
		start := i * windowSize
		var sum float64
		for j := 0; j < windowSize; j++ {
			s := float64(pcm[start+j])
			sum += s * s
		}
		energy[i] = math.Sqrt(sum / float64(windowSize))
	}

	// Step 2: Spectral flux (half-wave rectified difference)
	flux := make([]float64, numWindows)
	for i := 1; i < numWindows; i++ {
		diff := energy[i] - energy[i-1]
		if diff > 0 {
			flux[i] = diff
		}
	}

	// Step 3: Autocorrelation of the onset signal
	// We look for periodicities corresponding to 60-200 BPM.
	//
	// windows per second = sampleRate / windowSize
	// lag for a given BPM = (wps * 60) / BPM
	wps := float64(sampleRate) / float64(windowSize)
	minLag := int(wps * 60.0 / 200.0) // 200 BPM → shortest period
	maxLag := int(wps * 60.0 / 60.0)  // 60 BPM → longest period

	if minLag < 1 {
		minLag = 1
	}
	if maxLag >= numWindows/2 {
		maxLag = numWindows/2 - 1
	}
	if minLag >= maxLag {
		return 0
	}

	// Compute autocorrelation for each candidate lag
	bestLag := minLag
	bestCorr := -1.0
	for lag := minLag; lag <= maxLag; lag++ {
		var corr float64
		var count int
		for i := 0; i+lag < numWindows; i++ {
			corr += flux[i] * flux[i+lag]
			count++
		}
		if count > 0 {
			corr /= float64(count)
		}
		if corr > bestCorr {
			bestCorr = corr
			bestLag = lag
		}
	}

	// Convert lag to BPM
	bpm := (wps * 60.0) / float64(bestLag)

	// Normalise to [60, 200] range
	// DJs often play at 120-140 BPM; if we detect a sub-harmonic or
	// harmonic, adjust it.
	for bpm < 60 {
		bpm *= 2
	}
	for bpm > 200 {
		bpm /= 2
	}

	// Round to 1 decimal place
	bpm = math.Round(bpm*10) / 10

	return bpm
}
