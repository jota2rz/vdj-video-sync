//go:build windows

package browser

import "os/exec"

func open(url string) error {
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func hasDisplay() bool {
	// Windows Server Core still has a desktop (even if minimal).
	// The open command will simply fail silently if no browser is available.
	return true
}
