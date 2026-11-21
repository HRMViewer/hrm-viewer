//go:build !windows && !webview

// HRM Viewer for Linux: the "HRM Viewer" program in the unpacked folder.
// It opens the viewer in its own window (lib/hrm-viewer-window) when it can. Without a desktop session or
// WebKitGTK (the system library the window needs) it starts the viewer itself and opens it in the browser,
// staying open until the viewer stops (Ctrl+C, or Quit in the viewer's Settings).
package main

import (
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
)

func main() {
	self, _ := os.Executable()
	if s, err := filepath.EvalSymlinks(self); err == nil {
		self = s
	}
	helper := filepath.Join(filepath.Dir(self), "lib", "hrm-viewer-window")
	if exists(helper) && os.Getenv("HRMV_NO_WINDOW") == "" {
		cmd := exec.Command(helper, os.Args[1:]...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		cmd.Env = append(os.Environ(), "HRMV_LAUNCHER="+self)
		err := cmd.Run()
		code := 0
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else if err != nil {
			code = 127
		}
		// 127/126: the window app couldn't load (WebKitGTK isn't installed); exitNoWindow: no screen to show it on
		if code != 127 && code != 126 && code != exitNoWindow {
			os.Exit(code)
		}
		if code == exitNoWindow {
			os.Stderr.WriteString("HRM Viewer can't open its own window here, so it's opening in your browser.\n")
		} else {
			os.Stderr.WriteString("HRM Viewer can't open its own window here (it needs WebKitGTK), so it's opening in your browser.\n")
		}
	}
	os.Setenv("HRMV_LAUNCHER", self)
	if err := setup(); err != nil {
		notify(err.Error())
		os.Exit(1)
	}
	logf("browser mode")
	var server *viewer
	ready := startViewer(importArg(), &server)
	if err := <-ready; err != nil {
		notify(failureText(err))
		os.Exit(1)
	}
	openURL(base)
	if server == nil {
		return // it was already running
	}
	os.Stdout.WriteString("HRM Viewer is running at " + base + " - leave this open while you use it (Ctrl+C to stop).\n")
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	select {
	case <-stop:
		stopServer(server)
	case <-server.exited:
	}
}
