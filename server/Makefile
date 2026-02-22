# VDJ Video Sync – Server Build
# Requires: Go 1.24+, templ CLI, tailwindcss standalone CLI
# Works on Windows (PowerShell/cmd) and Unix/macOS.

.PHONY: all generate css build run dev clean

# ── Paths ────────────────────────────────────────────────
BINARY      := vdj-video-sync-server
TEMPL       := templ
TAILWIND    := tailwindcss

# ── OS detection ─────────────────────────────────────────
# $(OS) is set to "Windows_NT" on all Windows versions.
ifeq ($(OS),Windows_NT)
  EXE     := .exe
  BG_CMD   = powershell -Command "Start-Process -NoNewWindow '$(1)' -ArgumentList '$(2)'"
  FIND_DEL = powershell -Command "Get-ChildItem -Recurse -Filter '*_templ.go' | Remove-Item -Force"
else
  EXE     :=
  BG_CMD   = $(1) $(2) &
  FIND_DEL = find . -name '*_templ.go' -delete
endif

# -p 1 and -gcflags disable parallel compilation and optimizations for the
# concentus/SILK codec, which consumes excessive memory during SSA passes.
GCFLAGS := -gcflags="github.com/lostromb/concentus/...=-N -l"

# ── All ──────────────────────────────────────────────────
all: generate css build

# ── Generate templ Go files ──────────────────────────────
generate:
	$(TEMPL) generate

# ── Build Tailwind CSS ───────────────────────────────────
css:
	$(TAILWIND) -i static/css/input.css -o static/css/output.css --minify

# ── Build Go binary ─────────────────────────────────────
build: generate css
	go build -p 1 $(GCFLAGS) -o $(BINARY)$(EXE) .

# ── Run server ───────────────────────────────────────────
run: build
	./$(BINARY)$(EXE)

# ── Dev: watch mode ──────────────────────────────────────
dev:
	$(call BG_CMD,$(TEMPL),generate --watch)
	$(call BG_CMD,$(TAILWIND),-i static/css/input.css -o static/css/output.css --watch)
	go run .

# ── Clean ────────────────────────────────────────────────
clean:
	-$(RM) $(BINARY) $(BINARY).exe
	-$(RM) static/css/output.css
	-$(FIND_DEL)
