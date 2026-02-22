package main

import (
	"context"
	"flag"
	"log/slog"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jota2rz/vdj-video-sync/server/internal/bpm"
	"github.com/jota2rz/vdj-video-sync/server/internal/browser"
	"github.com/jota2rz/vdj-video-sync/server/internal/config"
	"github.com/jota2rz/vdj-video-sync/server/internal/db"
	"github.com/jota2rz/vdj-video-sync/server/internal/handlers"
	"github.com/jota2rz/vdj-video-sync/server/internal/sse"
	"github.com/jota2rz/vdj-video-sync/server/internal/video"
)

func main() {
	// ── Flags ───────────────────────────────────────────
	addr := flag.String("addr", ":8090", "HTTP listen address")
	dbPath := flag.String("db", "vdj-video-sync.db", "SQLite database path")
	videosDir := flag.String("videos", "./videos", "Directory containing video files")
	debug := flag.Bool("debug", false, "Enable debug logging")
	noBrowser := flag.Bool("no-browser", false, "Do not open the dashboard in a browser on startup")
	flag.Parse()

	// ── Logger ──────────────────────────────────────────
	logLevel := slog.LevelInfo
	if *debug {
		logLevel = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))
	slog.SetDefault(logger)

	// ── Database ────────────────────────────────────────
	database, err := db.Open(*dbPath)
	if err != nil {
		slog.Error("failed to open database", "error", err)
		os.Exit(1)
	}
	defer database.Close()

	// ── Config ──────────────────────────────────────────
	cfg := config.New(database)

	// ── SSE Hub ─────────────────────────────────────────
	hub := sse.NewHub()
	go hub.Run()

	// ── BPM Analysis Cache ────────────────────────────────
	bpmCache := bpm.NewCache(database)

	// ── Video Matchers (deferred scan — will run after server starts) ──
	vDir := cfg.Get("videos_dir", *videosDir)
	matcher := video.NewMatcher(vDir, "/videos/", bpmCache)

	tDir := cfg.Get("transition_videos_dir", "./transition-videos")
	transitionMatcher := video.NewMatcher(tDir, "/transition-videos/", bpmCache)

	// ── Routes ──────────────────────────────────────────
	mux := http.NewServeMux()
	h := handlers.New(cfg, hub, matcher, transitionMatcher)

	// API – receives updates from VDJ plugin
	mux.HandleFunc("POST /api/deck/update", h.HandleDeckUpdate)

	// SSE – browser clients subscribe here
	mux.HandleFunc("GET /events", h.HandleSSE)

	// Pages
	mux.HandleFunc("GET /dashboard", h.HandleDashboard)
	mux.HandleFunc("GET /library", h.HandleLibrary)
	mux.HandleFunc("GET /player", h.HandlePlayer)
	mux.HandleFunc("GET /", h.HandleIndex)

	// Dashboard API
	mux.HandleFunc("GET /api/config", h.HandleGetConfig)
	mux.HandleFunc("POST /api/config", h.HandleSetConfig)
	mux.HandleFunc("GET /api/videos", h.HandleListVideos)
	mux.HandleFunc("POST /api/force-video", h.HandleForceVideo)
	mux.HandleFunc("POST /api/force-deck-video", h.HandleForceDeckVideo)
	mux.HandleFunc("POST /api/deck/video-ended", h.HandleVideoEnded)

	// Graceful shutdown channel (created early so /api/shutdown can use it)
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	// Shutdown endpoint
	mux.HandleFunc("POST /api/shutdown", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"shutting down"}`))
		go func() {
			time.Sleep(500 * time.Millisecond)
			done <- os.Interrupt
		}()
	})

	// Static files (CSS, JS)
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))
	// Song video files – served dynamically from matcher's current directory
	mux.HandleFunc("GET /videos/", func(w http.ResponseWriter, r *http.Request) {
		dir := matcher.Dir()
		http.StripPrefix("/videos/", http.FileServer(http.Dir(dir))).ServeHTTP(w, r)
	})
	// Transition video files – served dynamically from transition matcher's directory
	mux.HandleFunc("GET /transition-videos/", func(w http.ResponseWriter, r *http.Request) {
		dir := transitionMatcher.Dir()
		http.StripPrefix("/transition-videos/", http.FileServer(http.Dir(dir))).ServeHTTP(w, r)
	})

	// ── HTTP Server ────────────────────────────────────────
	srv := &http.Server{
		Addr:         *addr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 0, // SSE needs unlimited write time
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		slog.Info("HTTP server starting", "addr", *addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("HTTP server error", "error", err)
			os.Exit(1)
		}
	}()

	// ── Auto-open dashboard ───────────────────────────────
	// Resolve the listen address to an actual URL (handle ":port" form).
	if !*noBrowser && !*debug {
		host, port, _ := net.SplitHostPort(*addr)
		if host == "" {
			host = "localhost"
		}
		dashURL := fmt.Sprintf("http://%s/dashboard", net.JoinHostPort(host, port))
		slog.Info("opening dashboard in browser", "url", dashURL)
		browser.Open(dashURL)
	}

	// ── Background BPM analysis + directory watchers ───
	// Server is already accepting connections; dashboard shows an overlay.
	// watchCtx is canceled on shutdown to stop directory watchers.
	watchCtx, watchCancel := context.WithCancel(context.Background())

	go func() {
		h.SetAnalysing(true)
		slog.Info("bpm analysis starting")
		matcher.Scan()
		transitionMatcher.Scan()
		bpmCache.Cleanup()
		h.SetAnalysing(false)
		slog.Info("bpm analysis complete")

		// Broadcast initial library state so any connected clients refresh
		h.BroadcastLibraryUpdated("song")
		h.BroadcastLibraryUpdated("transition")

		// Start directory watchers — poll every 2 seconds for file changes
		go matcher.Watch(watchCtx, 2*time.Second, func() {
			h.BroadcastLibraryUpdated("song")
		})
		go transitionMatcher.Watch(watchCtx, 2*time.Second, func() {
			h.BroadcastLibraryUpdated("transition")
		})
	}()

	<-done
	slog.Info("shutting down...")

	watchCancel() // stop directory watchers

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hub.Close()
	_ = srv.Shutdown(ctx)
}
