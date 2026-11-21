//go:build !windows && !webview

// HRM Viewer for Linux: the "HRM Viewer" program in the unpacked folder.
// It opens the viewer in its own window when it can, trying in turn:
//   1. lib/hrm-viewer-window      (built for WebKitGTK 4.1, current Linux releases)
//   2. lib/hrm-viewer-window-4.0  (built for WebKitGTK 4.0, which many systems still have instead)
// and, if a window app loads but breaks straight away (often the graphics driver), the same one again with
// WebKitGTK's safe graphics settings. What worked is remembered in data/window.json.
// Without any of that (no desktop session, or no WebKitGTK) it starts the viewer itself and opens it in the
// browser, staying open until the viewer stops; the reason is shown in the viewer's Settings and data/desktop.log.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// safe graphics: no DMA-BUF renderer and no accelerated compositing (fixes blank or crashing windows on some drivers)
var safeGraphics = []string{"WEBKIT_DISABLE_DMABUF_RENDERER=1", "WEBKIT_DISABLE_COMPOSITING_MODE=1"}

type windowChoice struct {
	Bin  string `json:"bin"`
	Safe bool   `json:"safe"`
}

func choiceFile() string { return filepath.Join(appDir, "data", "window.json") }

// the last lines a window app wrote to its error output (still shown on the terminal as they come)
type tail struct {
	mu   sync.Mutex
	buf  []byte
	seen bool // the window app said its first page is on screen
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	if bytes.Contains(p, []byte(windowShown)) {
		t.seen = true
	}
	t.buf = append(t.buf, p...)
	if len(t.buf) > 4000 {
		t.buf = t.buf[len(t.buf)-4000:]
	}
	t.mu.Unlock()
	return len(p), nil
}

func (t *tail) last() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := strings.Split(strings.TrimSpace(string(t.buf)), "\n")
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	return strings.TrimSpace(strings.Join(lines, " / "))
}

// run one window app; returns its exit code, whether it failed straight away, and its last error lines
func tryWindow(self, bin string, safe bool) (code int, quick bool, why string) {
	cmd := exec.Command(bin, os.Args[1:]...)
	t, out := &tail{}, &tail{}
	cmd.Stdin = os.Stdin
	cmd.Stdout = io.MultiWriter(os.Stdout, out)
	cmd.Stderr = io.MultiWriter(os.Stderr, t)
	cmd.Env = append(os.Environ(), "HRMV_LAUNCHER="+self)
	if safe {
		cmd.Env = append(cmd.Env, safeGraphics...)
	}
	began := time.Now()
	err := cmd.Run()
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode() // -1 when it was ended by a signal (a crash, or killed)
	} else if err != nil {
		code, why = 127, err.Error()
	}
	if why == "" {
		why = t.last()
	}
	// it worked if its first page was drawn (or, if that message never came, it ran a good while)
	out.mu.Lock()
	shown := out.seen
	out.mu.Unlock()
	quick = !shown && code != 0 && time.Since(began) < 30*time.Second
	logf("window app %s%s: exit %d after %s%s", filepath.Base(bin), map[bool]string{true: " (safe graphics)"}[safe], code,
		time.Since(began).Round(time.Second), map[bool]string{true: " - " + why}[why != "" && quick])
	return code, quick, why
}

func main() {
	self, _ := os.Executable()
	if s, err := filepath.EvalSymlinks(self); err == nil {
		self = s
	}
	os.Setenv("HRMV_LAUNCHER", self)
	if err := setup(); err != nil {
		notify(err.Error())
		os.Exit(1)
	}
	problem := ""
	if os.Getenv("HRMV_NO_WINDOW") == "" {
		lib := filepath.Join(filepath.Dir(self), "lib")
		bins := []string{}
		for _, n := range []string{"hrm-viewer-window", "hrm-viewer-window-4.0"} {
			if exists(filepath.Join(lib, n)) {
				bins = append(bins, filepath.Join(lib, n))
			}
		}
		// what worked last time goes first
		var last windowChoice
		if b, err := os.ReadFile(choiceFile()); err == nil && json.Unmarshal(b, &last) == nil && exists(last.Bin) {
			for i, b := range bins {
				if b == last.Bin {
					bins = append([]string{b}, append(bins[:i:i], bins[i+1:]...)...)
				}
			}
		}
		var reasons []string
	tries:
		for _, bin := range bins {
			for _, safe := range []bool{last.Bin == bin && last.Safe, !(last.Bin == bin && last.Safe)} {
				code, quick, why := tryWindow(self, bin, safe)
				if !quick { // the window opened (and has now been closed): remember how
					if b, err := json.Marshal(windowChoice{Bin: bin, Safe: safe}); err == nil {
						os.WriteFile(choiceFile(), b, 0o644)
					}
					if code < 0 {
						code = 0
					}
					os.Exit(code)
				}
				label := "WebKitGTK 4.1"
				if strings.HasSuffix(bin, "-4.0") {
					label = "WebKitGTK 4.0"
				}
				switch {
				case code == exitNoWindow:
					reasons = append(reasons, "no desktop screen to show a window on")
					break tries
				case code == 127 || code == 126:
					reasons = append(reasons, label+" isn't installed")
					continue tries // the other build may load
				default:
					reasons = append(reasons, fmt.Sprintf("the %s window stopped straight away%s", label, map[bool]string{true: " with safe graphics"}[safe]))
					if why != "" {
						reasons[len(reasons)-1] += " (" + why + ")"
					}
				}
			}
		}
		if len(reasons) > 0 {
			problem = strings.Join(reasons, "; ")
			os.Stderr.WriteString("HRM Viewer can't open its own window here (" + problem + "), so it's opening in your browser.\n")
		}
	}
	logf("browser mode%s", map[bool]string{true: ": " + problem}[problem != ""])
	if problem != "" {
		os.Setenv("HRMV_WINDOW_PROBLEM", problem)
	}
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
