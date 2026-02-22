// Package browser provides a fire-and-forget helper to open a URL in the
// user's default browser. If opening fails (headless server, no browser
// installed, etc.) the error is logged at debug level and the caller is
// unaffected.
package browser

import "log/slog"

// Open attempts to launch the default browser at url.
// It returns immediately; failure is non-fatal.
func Open(url string) {
	if !hasDisplay() {
		slog.Debug("skipping browser open: no display detected")
		return
	}
	if err := open(url); err != nil {
		slog.Debug("could not open browser", "url", url, "error", err)
	}
}
