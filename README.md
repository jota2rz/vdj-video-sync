# VDJ Video Sync

[![Build Server](https://github.com/jota2rz/vdj-video-sync/actions/workflows/build-server.yml/badge.svg)](https://github.com/jota2rz/vdj-video-sync/actions/workflows/build-server.yml)
[![Build Plugin](https://github.com/jota2rz/vdj-video-sync/actions/workflows/build-plugin.yml/badge.svg)](https://github.com/jota2rz/vdj-video-sync/actions/workflows/build-plugin.yml)

Synchronize local video playback with VirtualDJ — a C++ plugin sends real-time deck state to a Go server, which serves a browser-based video player that matches and syncs videos by exact filename, exact stem, filename similarity, BPM or random.

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

> **Note:** Mobile devices are not supported. The server UI requires simultaneous decoding of multiple video streams, triple-buffered transitions, canvas mirroring, and real-time playback rate adjustments — all of which exceed mobile browser video decoding performance. A desktop or laptop browser is required.

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
- BPM from audio analysis (AAC & Opus codecs, pure Go — no ffmpeg)
- Filename BPM fallback: parses BPM from filename (e.g. `loop_128bpm.mp4`) when audio analysis is unavailable

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

- Fullscreen video output (opens in new tab, no UI)
- Same transition and sync logic as the embedded dashboard player
- "Waiting for track..." fallback when no video is matched

### Control Bar

- Transition enabled/disabled toggle
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
├── .github/workflows/          # CI/CD pipelines
│   ├── build-plugin.yml        # Plugin builds (Windows x64, macOS arm64/amd64)
│   └── build-server.yml        # Server builds (Windows x64, macOS Universal, Linux x64)
│
├── docs/                       # GitHub Pages site (download page)
│
├── plugin/                     # C++ VirtualDJ plugin
│   ├── CMakeLists.txt
│   ├── src/
│   │   ├── main.cpp            # DllGetClassObject entry point
│   │   ├── VideoSyncPlugin.h
│   │   ├── VideoSyncPlugin.cpp
│   │   ├── VdjVideoSync.def    # DLL exports
│   │   └── Info.plist.in       # macOS bundle plist template
│   └── vendor/
│       └── httplib.h           # cpp-httplib (downloaded automatically by CI; for local builds, download manually)
│
├── server/                     # Go server
│   ├── main.go                 # HTTP server, routing, CLI flags
│   ├── go.mod
│   ├── Makefile
│   ├── internal/
│   │   ├── bpm/                # Audio BPM analysis (AAC/Opus → onset detection)
│   │   │   ├── bpm.go          # MP4 parsing, codec detection, autocorrelation
│   │   │   └── cache.go        # SQLite-backed BPM cache
│   │   ├── browser/            # Auto-open dashboard in browser on startup
│   │   ├── config/             # Thread-safe key-value config (SQLite-backed)
│   │   ├── db/                 # Database init & schema
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
├── VirtualDJ8_SDK_20211003/    # VDJ SDK headers (downloaded automatically by CI; for local builds, download manually)
│
└── LICENSE.md
```

## Prerequisites

### Plugin (C++)
- CMake 3.20+
- C++17 compiler: MSVC (Visual Studio 2022) on Windows, Clang/Xcode on macOS
- [cpp-httplib](https://github.com/yhirose/cpp-httplib) — download [httplib.h](https://raw.githubusercontent.com/yhirose/cpp-httplib/v0.32.0/httplib.h) and place it in `plugin/vendor/httplib.h`
- [VirtualDJ SDK](https://virtualdj.com/wiki/Developers) — download the SDK headers and place them in `VirtualDJ8_SDK_20211003/`

> **Note:** cpp-httplib and the VirtualDJ SDK are **not distributed** with this project. cpp-httplib is MIT-licensed but too large to vendor in git; the VDJ SDK has no clear open-source license. Download both before building.

### Server (Go)
- Go 1.25+
- [Templ CLI](https://templ.guide/) — `go install github.com/a-h/templ/cmd/templ@latest`
- [Tailwind CSS v4 standalone CLI](https://github.com/tailwindlabs/tailwindcss/releases) — download binary and place on PATH

## Building

### Plugin

**Windows:**
```bash
cd plugin
cmake -B build -A x64
cmake --build build --config Release
# Output: build/out/Release/VdjVideoSync.dll
# Copy to: %USERPROFILE%/AppData/Local/VirtualDJ/Plugins64/SoundEffect/
```

**macOS:**
```bash
cd plugin
cmake -B build
cmake --build build --config Release
# Output: build/out/VdjVideoSync.bundle
# Copy to: ~/Library/Application Support/VirtualDJ/Plugins64/SoundEffect/
```

Based on [szemek/virtualdj-plugins-examples](https://github.com/szemek/virtualdj-plugins-examples) for XCode compatibility.

### Server

The Go Server compiles natively on **Windows**, **macOS**, and **Linux** — all dependencies are pure Go (no CGo).

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
# -p 1 and -gcflags prevent OOM from concentus/SILK codec compilation
go build -p 1 -gcflags="github.com/lostromb/concentus/...=-N -l" -o vdj-video-sync-server .    # Linux / macOS
go build -p 1 -gcflags="github.com/lostromb/concentus/...=-N -l" -o vdj-video-sync-server.exe .  # Windows
./vdj-video-sync-server -port :8090 -videos ./videos
```

You can also cross-compile from any OS:

```bash
# -p 1 and -gcflags prevent OOM from concentus/SILK codec compilation
GOOS=windows GOARCH=amd64 go build -p 1 -gcflags="github.com/lostromb/concentus/...=-N -l" -o vdj-video-sync-server.exe .
GOOS=darwin  GOARCH=arm64 go build -p 1 -gcflags="github.com/lostromb/concentus/...=-N -l" -o vdj-video-sync-server .
GOOS=linux   GOARCH=amd64 go build -p 1 -gcflags="github.com/lostromb/concentus/...=-N -l" -o vdj-video-sync-server .
```

### Usage

1. Start the server — the dashboard opens automatically in your default browser
2. Put `VdjVideoSync.dll` at `Plugins64/SoundEffect/`
3. Launch VirtualDJ and enable the Master Effect called `VdjVideoSync`
4. *(Optional)* To change the server IP or port, open **Effect Controls** and click **Set IP** or **Set Port** — values are validated and saved automatically
5. Open `http://localhost:8090/player` in a separate window/tab/screen for fullscreen video output
6. Place video files in the configured videos directory (`.mp4` with AAC or Opus SILK or CELT audio, this means it's YouTube compatible)
7. Place transition videos in the transition videos directory

#### Server flags

| Flag | Default | Description |
|------|---------|-------------|
| `-port` | `:8090` | HTTP listen port |
| `-db` | `vdj-video-sync.db` | SQLite database path |
| `-videos` | `./videos` | Directory containing video files |
| `-transition-videos` | `./transition-videos` | Directory containing transition video files |
| `-debug` | `false` | Enable debug logging (also disables auto-open browser) |
| `-no-browser` | `false` | Do not open the dashboard in a browser on startup |

> **Headless / server environments:** On Linux, the browser is not opened when
> neither `$DISPLAY` nor `$WAYLAND_DISPLAY` is set. On any platform you can pass
> `-no-browser` to skip the attempt entirely.

## Dependencies

### Go Server

| Package | Purpose |
|---------|---------|
| [templ](https://github.com/a-h/templ) | Type-safe HTML templating |
| [go-mp4](https://github.com/abema/go-mp4) | MP4 container parsing — extracts audio tracks from video files |
| [concentus](https://github.com/lostromb/concentus) (Go port) | Pure-Go Opus decoder (SILK + CELT) (YouTube compatibility) — decodes audio for BPM analysis |
| [go-aac](https://github.com/skrashevich/go-aac) | Pure-Go AAC decoder — decodes audio for BPM analysis |
| [sqlite](https://pkg.go.dev/modernc.org/sqlite) | Pure-Go SQLite driver |

All dependencies are **pure Go** — no CGo, no ffmpeg, no native libraries required.

### VirtualDJ C++ Plugin

| Library | Purpose |
|---------|---------|
| [cpp-httplib](https://github.com/yhirose/cpp-httplib) | Single-header HTTP client for sending deck state (downloaded automatically by CI; for local builds, download manually) |
| [VirtualDJ SDK](https://virtualdj.com/wiki/Developers) | Plugin interface headers (downloaded automatically by CI; for local builds, download manually) |

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