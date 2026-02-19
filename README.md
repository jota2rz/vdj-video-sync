# VDJ Video Sync

Synchronize local video playback with VirtualDJ — a C++ plugin sends real-time deck state to a Go server, which serves a browser-based video player that matches and syncs videos by song title, filename similarity, or BPM.

> **100% vibe coded** with [Claude Opus 4.6](https://www.anthropic.com/claude) ✨

## Architecture

```
VDJ Plugin (C++ DLL)  ──HTTP POST──▶  Go Server  ──SSE──▶  Browser Clients
        │                               │                    ├─ /dashboard
        │  deck state every 50ms        │                    ├─ /library
        │  (filename, BPM, pitch,       │                    └─ /player
        │   volume, elapsed, play/      │
        │   pause, audible)             └─ SQLite (config & BPM cache)
        │
        └── VirtualDJ 8 DSP Plugin
```

## Features

### Video Matching (6-level tiered fallback)

| Level | Type | Description |
|-------|------|-------------|
| 0 | **Exact** | Video filename matches song filename exactly (with extension) |
| 1 | **Stem** | Filename match without extension |
| 2 | **Fuzzy** | ≥70% filename similarity (Levenshtein-based) |
| 3 | **BPM + Fuzzy** | Closest BPM among videos with ≥30% name similarity; random pick from top 5 |
| 4 | **BPM** | Closest BPM match; random pick from top 5 closest candidates |
| 5 | **Random** | Any random video (stable pick by song hash) |

- Half-time BPM correction: automatically detects and corrects half-time BPM readings
- BPM from filename parsing (e.g. `loop_128bpm.mp4`)
- BPM from audio analysis (AAC & Opus codecs, pure Go — no ffmpeg)

### Playback Synchronization

- **Elapsed time sync** — Levels 0-1 sync to VDJ elapsed time; levels 2+ sync to server-tracked independent position
- **Playback rate** — BPM-based rate matching: `(pitch / 100) × (deckBPM / videoBPM)`, clamped to 0.25–4.0x
- **Drift correction** — Soft catch-up (±15% rate adjustment) when drift >150ms, hard seek when >2000ms
- **Video looping** — Levels 0-1 loop with transition when video ends before the song; levels 2+ pick a different random video

### Transition System

- Server-driven triple-buffered design: 3 transition videos preloaded at all times
- Server chooses which buffer to play — all clients show the same transition
- Configurable duration (1-10 seconds) and enable/disable toggle from the control bar
- Uses `fetch()` + blob URLs to bypass Chrome's 6-media-preload limit
- Syncs playback rate to the incoming deck's BPM + pitch

### Dashboard (`/dashboard`)

- Real-time deck status cards (decks 1-2 always shown, 3-4 appear/hide dynamically)
- Embedded master video player with match type, playback rate, and BPM info
- Canvas-mirrored per-deck video previews (~15 fps)
- Active deck pulse animation
- Deck limit warning banner (decks > 4)
- BPM analysis overlay with progress indicator

### Video Library (`/library`)

- Tabbed browser: Song Videos / Transition Videos
- Search filter
- Video preview with click-to-pause
- "Force Master Video" — force a video on the active deck with transition
- "Force Deck 1-4" — force a video on a specific deck
- Auto-refreshes when server detects file changes on disk

### Standalone Player (`/player`)

- Fullscreen video output (opens in new tab, no UI chrome)
- Same transition and sync logic as the embedded dashboard player
- "Waiting for track..." fallback when no video is matched

### Control Bar

- Transition enabled/disabled toggle (iOS-style switch)
- Transition duration ± buttons (1-10 seconds)
- Config changes sync across all tabs via BroadcastChannel + SSE

### Settings & Config

- Videos directory and transition videos directory configurable from the UI
- Config persisted in SQLite, synced to all clients via SSE
- Graceful server shutdown from the UI

### Real-time Communication

- **Plugin → Server**: HTTP POST every 50ms per deck (JSON)
- **Server → Browser**: Server-Sent Events (SSE) via SharedWorker (single connection shared across all tabs to stay within HTTP/1.1 connection limits)
- **Cross-tab sync**: BroadcastChannel for instant same-browser config propagation
- Event types: `deck-update`, `transition-pool`, `transition-play`, `deck-visibility`, `analysis-status`, `library-updated`, `config-updated`

### VDJ Plugin

- VirtualDJ 8 DSP plugin (no audio modification — pass-through)
- Polls deck state every 50ms in a background thread
- Sends: deck number, filename, BPM, pitch, volume, elapsed time, playing, audible
- Duplicate/mirrored deck detection (filters VDJ master-bus mirrors)
- Change detection to minimize redundant HTTP traffic

## Project Structure

```
├── plugin/                     # C++ VirtualDJ plugin
│   ├── CMakeLists.txt
│   ├── src/
│   │   ├── main.cpp            # DllGetClassObject entry point
│   │   ├── VideoSyncPlugin.h
│   │   ├── VideoSyncPlugin.cpp
│   │   └── VdjVideoSync.def    # DLL exports
│   └── vendor/
│       └── httplib.h           # cpp-httplib (vendored)
│
├── server/                     # Go server
│   ├── main.go                 # HTTP server, routing, CLI flags
│   ├── go.mod
│   ├── Makefile
│   ├── internal/
│   │   ├── bpm/                # Audio BPM analysis (AAC/Opus → onset detection)
│   │   │   ├── bpm.go          # MP4 parsing, codec detection, autocorrelation
│   │   │   └── cache.go        # SQLite-backed BPM cache
│   │   ├── config/             # Thread-safe key-value config (SQLite-backed)
│   │   ├── db/                 # Database init & migrations
│   │   ├── handlers/           # HTTP & SSE handlers
│   │   ├── models/             # Shared data types
│   │   ├── sse/                # Pub/sub hub for Server-Sent Events
│   │   └── video/              # Video scanner, matcher, directory watcher
│   ├── templates/              # Templ templates (.templ → _templ.go)
│   │   ├── layouts/            # Base HTML layout
│   │   ├── pages/              # Dashboard, Library, Player
│   │   └── components/         # Header (nav), ControlBar (bottom)
│   └── static/
│       ├── css/                # Tailwind CSS (input.css → output.css)
│       └── js/
│           ├── app.js          # All client-side logic (~2000 lines)
│           └── sse-worker.js   # SharedWorker for SSE connection sharing
│
└── mp4-samples/                # Test video files
```

## Prerequisites

### Plugin (C++)
- CMake 3.20+
- MSVC (Visual Studio 2022) or compatible C++17 compiler
- [cpp-httplib](https://github.com/yhirose/cpp-httplib) — single header, already vendored in `plugin/vendor/httplib.h`
- [VirtualDJ SDK](https://virtualdj.com/wiki/Developers) — download the SDK headers and place them in `VirtualDJ8_SDK_20211003/`

> **Note:** The VirtualDJ SDK is **not distributed** with this project because it has no clear open-source license. You can download it directly from https://virtualdj.com/wiki/Developers.

### Server (Go)
- Go 1.24+
- [Templ CLI](https://templ.guide/) — `go install github.com/a-h/templ/cmd/templ@latest`
- [Tailwind CSS v4 standalone CLI](https://github.com/tailwindlabs/tailwindcss/releases) — download binary and place on PATH

## Building

### Plugin

```powershell
cd plugin
cmake -B build -A x64
cmake --build build --config Release
# Output: build/Release/VdjVideoSync.dll
# Copy to: %USERPROFILE%/Documents/VirtualDJ/Plugins64/AutoStart/
```

### Server

```bash
cd server

# Full build (generate templates + build CSS + compile Go binary)
make build

# Run after building
make run

# Development mode (watches templ, tailwind, and Go files)
make dev

# Clean generated files
make clean
```

Or manually:

```bash
cd server
templ generate
tailwindcss -i static/css/input.css -o static/css/output.css --minify
go build -o vdj-video-sync-server .
./vdj-video-sync-server -addr :8090 -videos ./videos
```

### Usage

1. Start the Go server
2. Load VirtualDJ with the plugin DLL in `Plugins64/AutoStart/`
3. Open `http://localhost:8090/dashboard` for the control interface
4. Open `http://localhost:8090/player` in a separate window/tab/screen for fullscreen video output
5. Place video files in the configured videos directory (`.mp4`, `.webm`, `.mkv`, `.avi`, `.mov`)
6. Place transition videos in the transition videos directory

## Dependencies

### Go Server

| Package | Purpose |
|---------|---------|
| [templ](https://github.com/a-h/templ) | Type-safe HTML templating |
| [go-mp4](https://github.com/abema/go-mp4) | MP4 container parsing for BPM analysis |
| [concentus](https://github.com/lostromb/concentus) (Go port) | Pure-Go Opus audio decoder (SILK + CELT) |
| [go-aac](https://github.com/skrashevich/go-aac) | Pure-Go AAC audio decoder |
| [sqlite](https://pkg.go.dev/modernc.org/sqlite) | Pure-Go SQLite driver (no CGo) |

All dependencies are **pure Go** — no CGo, no ffmpeg, no native libraries required.

### C++ Plugin

| Library | Purpose |
|---------|---------|
| [cpp-httplib](https://github.com/yhirose/cpp-httplib) | Single-header HTTP client for sending deck state |
| [VirtualDJ SDK](https://virtualdj.com/wiki/Developers) | Plugin interface headers (not distributed — download separately) |

### Frontend

| Technology | Purpose |
|------------|---------|
| [Tailwind CSS v4](https://tailwindcss.com/) | Utility-first CSS framework |
| Vanilla JavaScript | No framework — single `app.js` file |

### AI

| Technology | Purpose |
|------------|---------|
| [Claude Opus 4.6](https://www.anthropic.com/claude) | Vibe-coded the entire application — architecture, plugin, server, frontend, and this README |

## License

GPL-3.0