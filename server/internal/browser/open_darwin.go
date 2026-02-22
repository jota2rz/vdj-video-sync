//go:build darwin

package browser

import "os/exec"

func open(url string) error {
	return exec.Command("open", url).Start()
}

func hasDisplay() bool {
	// macOS headless environments are rare; let open fail naturally.
	return true
}
