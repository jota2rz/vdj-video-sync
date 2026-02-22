//go:build !windows && !darwin

package browser

import (
	"os"
	"os/exec"
)

func open(url string) error {
	return exec.Command("xdg-open", url).Start()
}

func hasDisplay() bool {
	// On Linux / BSD, a graphical session sets $DISPLAY (X11) or
	// $WAYLAND_DISPLAY. If neither is present we're likely headless.
	return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
}
