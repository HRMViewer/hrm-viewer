//go:build !windows

// HRM Viewer for Mac and Linux: the parts shared by the window app and the browser fallback.
// Starts the viewer (app.py, with the Python that ships in the package) on a free local port,
// waits until it answers, and stops it again afterwards.
//
// Where things live:
//   - Linux: everything in the unpacked "HRM Viewer" folder, like on Windows (data/ next to app.py).
//   - Mac: the .app can't be written to (and changing it would break its signature), so the viewer and its
//     Python are copied to ~/Library/Application Support/HRM Viewer the first time and whenever a newer .app
//     is opened. Updates from inside the viewer and your data stay there.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	firstPort = 8765 // the viewer's usual address; the next free one is used if another program has it
	lastPort  = 8785
	title     = "HRM Viewer"
	// the window app exits with this when it can't open a window (no display, or WebKitGTK missing),
	// so the launcher uses the browser instead
	exitNoWindow = 120
)

var (
	port     = firstPort
	base     = fmt.Sprintf("http://127.0.0.1:%d/", firstPort)
	appDir   string // app.py and data/
	exeDir   string // where this program is
	logFile  *os.File
	windowed bool // shown in our own window (so downloads and outside links go through the viewer)
	// kept open for as long as this program runs (see startServer)
	launcherPipe *os.File
)

func logf(format string, a ...interface{}) {
	if logFile != nil {
		fmt.Fprintf(logFile, "%s  "+format+"\n", append([]interface{}{time.Now().Format("2006-01-02 15:04:05")}, a...)...)
	}
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// ------------------------------------------------------------------ where the viewer is

var versionRe = regexp.MustCompile(`(?m)^VERSION = "([^"]+)"`)

func appVersion(appPy string) string {
	b, err := os.ReadFile(appPy)
	if err != nil {
		return ""
	}
	if m := versionRe.FindSubmatch(b); m != nil {
		return string(m[1])
	}
	return ""
}

// "14.10" is newer than "14.9"
func versionLess(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

// copy a folder, keeping symbolic links (Python's bin/python3 is one) and file permissions
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(p)
			if err != nil {
				return err
			}
			os.Remove(target)
			return os.Symlink(link, target)
		case info.IsDir():
			return os.MkdirAll(target, 0o755)
		default:
			in, err := os.Open(p)
			if err != nil {
				return err
			}
			defer in.Close()
			tmp := target + ".tmp"
			out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm()|0o200)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, in); err != nil {
				out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
			return os.Rename(tmp, target)
		}
	})
}

// Mac: put the viewer and its Python in Application Support (see the top of this file).
// The viewer's own files are only replaced by a newer version, so an update installed from
// inside the viewer isn't undone by opening the app; Python is refreshed whenever the app changes.
func syncMacHome(res, home string) error {
	if err := os.MkdirAll(home, 0o755); err != nil {
		return err
	}
	bundled := appVersion(filepath.Join(res, "app", "app.py"))
	stampFile := filepath.Join(home, ".app-version")
	stamp, _ := os.ReadFile(stampFile)
	arch := "x86_64"
	if runtime.GOARCH == "arm64" {
		arch = "arm64"
	}
	py := filepath.Join(home, "python")
	if string(stamp) == bundled && exists(filepath.Join(home, "app.py")) && exists(filepath.Join(py, "bin", "python3")) {
		return nil
	}
	installed := appVersion(filepath.Join(home, "app.py"))
	if installed == "" || versionLess(installed, bundled) {
		logf("putting version %s in place (had %q)", bundled, installed)
		if err := copyTree(filepath.Join(res, "app"), home); err != nil {
			return fmt.Errorf("copying the viewer: %w", err)
		}
	}
	logf("putting Python (%s) in place", arch)
	tmp := py + ".new"
	os.RemoveAll(tmp)
	if err := copyTree(filepath.Join(res, "python-"+arch), tmp); err != nil {
		return fmt.Errorf("copying Python: %w", err)
	}
	os.RemoveAll(py)
	if err := os.Rename(tmp, py); err != nil {
		return err
	}
	return os.WriteFile(stampFile, []byte(bundled), 0o644)
}

// Work out appDir. Returns an error message for the person if the package is incomplete.
func setup() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if s, err := filepath.EvalSymlinks(self); err == nil {
		self = s
	}
	exeDir = filepath.Dir(self)
	if runtime.GOOS == "darwin" && strings.HasSuffix(exeDir, filepath.Join(".app", "Contents", "MacOS")) {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		appDir = filepath.Join(home, "Library", "Application Support", "HRM Viewer")
		openLog()
		res := filepath.Join(exeDir, "..", "Resources")
		if err := syncMacHome(res, appDir); err != nil {
			logf("setting up: %v", err)
			return err
		}
		return nil
	}
	appDir = exeDir
	if !exists(filepath.Join(appDir, "app.py")) && exists(filepath.Join(exeDir, "..", "app.py")) {
		appDir = filepath.Dir(exeDir) // the Linux window app sits in lib/
	}
	openLog()
	if !exists(filepath.Join(appDir, "app.py")) {
		return fmt.Errorf("HRM Viewer needs to stay in its folder, next to app.py")
	}
	return nil
}

func openLog() {
	os.MkdirAll(filepath.Join(appDir, "data"), 0o755)
	logFile, _ = os.OpenFile(filepath.Join(appDir, "data", "desktop.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if logFile != nil {
		if fi, err := logFile.Stat(); err == nil && fi.Size() > 5<<20 {
			logFile.Truncate(0)
		}
	}
}

// ------------------------------------------------------------------ the port (same rules as on Windows)

func portFile() string { return filepath.Join(appDir, "data", "port.json") }

func lastPortUsed() int {
	b, err := os.ReadFile(portFile())
	if err != nil {
		return 0
	}
	var v struct {
		Port int `json:"port"`
	}
	if json.Unmarshal(b, &v) != nil || v.Port <= 0 || v.Port > 65535 {
		return 0
	}
	return v.Port
}

func setPort(p int) {
	port = p
	base = fmt.Sprintf("http://127.0.0.1:%d/", p)
}

func serverUp() bool {
	c := http.Client{Timeout: 1500 * time.Millisecond}
	r, err := c.Get(base + "api/status")
	if err != nil {
		return false
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	return r.StatusCode == 200 && bytes.Contains(b, []byte(`"app"`))
}

func portFree(p int) bool {
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
	if err != nil {
		return false
	}
	l.Close()
	return true
}

func choosePort() {
	if last := lastPortUsed(); last > 0 {
		setPort(last)
		if serverUp() || portFree(last) {
			return
		}
	}
	for p := firstPort; p <= lastPort; p++ {
		setPort(p)
		if serverUp() || portFree(p) {
			return
		}
		logf("port %d is used by another program", p)
	}
	setPort(firstPort)
}

// ------------------------------------------------------------------ the viewer itself

func findPython() string {
	if p := filepath.Join(appDir, "python", "bin", "python3"); exists(p) {
		return p
	}
	// no bundled Python (someone running the viewer from the source): any Python 3 will do
	for _, c := range []string{"python3", "python"} {
		if p, err := exec.LookPath(c); err == nil {
			if out, err := exec.Command(p, "--version").Output(); err == nil && bytes.HasPrefix(out, []byte("Python 3")) {
				return p
			}
		}
	}
	return ""
}

func startServer(importPath string) (*exec.Cmd, error) {
	py := findPython()
	if py == "" {
		return nil, fmt.Errorf("nopython")
	}
	args := []string{"app.py", "--no-browser", "--port", fmt.Sprint(port)}
	if importPath != "" {
		args = append(args, "--import", importPath)
	}
	cmd := exec.Command(py, args...)
	cmd.Dir = appDir
	os.Remove(portFile())
	env := append(os.Environ(), "HRMV_DESKTOP=1", "PYTHONUNBUFFERED=1", "PYTHONIOENCODING=utf-8",
		"HRMV_PORT_AUTO=1", "HRMV_PORT_FILE="+portFile(), "HRMV_PLATFORM="+runtime.GOOS)
	if windowed {
		env = append(env, "HRMV_WINDOW=webkit")
	}
	if l := launcherPath(); l != "" {
		env = append(env, "HRMV_LAUNCHER="+l)
	}
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // its own group, so it can be stopped with everything it started
	// a pipe the viewer watches: when this program goes away for any reason (even Quit from the Dock, which
	// ends a Mac app straight away), the pipe closes and the viewer stops instead of staying behind
	if r, w, err := os.Pipe(); err == nil {
		cmd.Stdin = r
		launcherPipe = w
		cmd.Env = append(cmd.Env, "HRMV_WATCH_STDIN=1")
	}
	if logFile != nil {
		cmd.Stdout, cmd.Stderr = logFile, logFile
	}
	logf("starting: %s %s", py, strings.Join(args, " "))
	return cmd, cmd.Start()
}

// the program a menu entry or shortcut should open (Linux: the "HRM Viewer" file next to app.py)
func launcherPath() string {
	if v := os.Getenv("HRMV_LAUNCHER"); v != "" {
		return v
	}
	if runtime.GOOS == "linux" {
		if p := filepath.Join(appDir, "HRM Viewer"); exists(p) {
			return p
		}
	}
	return ""
}

// a viewer this program started, and a channel that's closed when it has stopped
type viewer struct {
	cmd    *exec.Cmd
	exited chan struct{}
}

func stopServer(v *viewer) {
	if v == nil {
		return
	}
	c := http.Client{Timeout: 2 * time.Second}
	if r, err := c.Post(base+"api/quit", "application/json", strings.NewReader("{}")); err == nil {
		r.Body.Close()
	}
	cmd, done := v.cmd, v.exited
	select {
	case <-done:
	case <-time.After(6 * time.Second):
		syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
	}
	logf("viewer closed")
}

// Find or start the viewer. The channel says when it's answering (nil) or why it couldn't start.
// server is set to the viewer this program started (it stays nil if one was already running).
func startViewer(importPath string, server **viewer) (ready chan error) {
	ready = make(chan error, 1)
	go func() {
		choosePort()
		if serverUp() {
			if importPath != "" {
				body, _ := json.Marshal(map[string]string{"path": importPath})
				if r, err := http.Post(base+"api/import/path", "application/json", bytes.NewReader(body)); err == nil {
					r.Body.Close()
				}
			}
			ready <- nil
			return
		}
		cmd, err := startServer(importPath)
		if err != nil {
			ready <- err
			return
		}
		exited := make(chan struct{})
		go func() { cmd.Wait(); close(exited) }()
		*server = &viewer{cmd: cmd, exited: exited}
		limit := time.Now().Add(15 * time.Minute) // loading a database first can take a while
		for time.Now().Before(limit) {
			select {
			case <-exited:
				if cmd.ProcessState != nil && cmd.ProcessState.ExitCode() == 4 {
					ready <- fmt.Errorf("portbusy")
					return
				}
				ready <- fmt.Errorf("stopped")
				return
			default:
			}
			if p := lastPortUsed(); p > 0 && p != port {
				logf("the viewer opened on port %d", p)
				setPort(p)
			}
			if serverUp() {
				ready <- nil
				return
			}
			time.Sleep(400 * time.Millisecond)
		}
		ready <- fmt.Errorf("timeout")
	}()
	return ready
}

func failureText(err error) string {
	logf("failed: %v", err)
	switch err.Error() {
	case "nopython":
		return "Part of HRM Viewer is missing (its Python). Download HRM Viewer again from https://github.com/HRMViewer/hrm-viewer/releases/latest"
	case "portbusy":
		return fmt.Sprintf("Another program on this computer is using the viewer's address (port %d), so it couldn't start. Close that program or restart your computer, then open HRM Viewer again.", port)
	case "timeout":
		return "The viewer is taking too long to start. Details are in data/desktop.log in " + appDir
	case "stopped":
		return "The viewer stopped while starting. Details are in data/desktop.log in " + appDir
	}
	return err.Error()
}

func openURL(u string) {
	if runtime.GOOS == "darwin" {
		exec.Command("open", u).Start()
		return
	}
	exec.Command("xdg-open", u).Start()
}

// a message box without a window of our own (Linux browser fallback): use whatever the desktop offers
func notify(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	if runtime.GOOS == "darwin" {
		exec.Command("osascript", "-e", "display alert "+jsonStr(title)+" message "+jsonStr(msg)).Run()
		return
	}
	for _, c := range [][]string{{"zenity", "--error", "--title=" + title, "--text=" + msg}, {"kdialog", "--title", title, "--error", msg},
		{"notify-send", title, msg}} {
		if p, err := exec.LookPath(c[0]); err == nil {
			if exec.Command(p, c[1:]...).Run() == nil {
				return
			}
		}
	}
}

func jsonStr(s string) string { b, _ := json.Marshal(s); return string(b) }

// a database.db opened with the app (dropped on it, or "Open with")
func importArg() string {
	for _, a := range os.Args[1:] {
		if strings.HasSuffix(strings.ToLower(a), ".db") && exists(a) {
			return a
		}
	}
	return ""
}

const splash = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{height:100%;margin:0;background:#0a1a3b;color:#fff;font:15px -apple-system,"Segoe UI",system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
.b{text-align:center}.l{width:76px;height:76px;margin:0 auto 18px}h1{font-size:26px;margin:0 0 6px;font-weight:600}h1 b{font-weight:800}
#s{color:#9fb3d9;min-height:22px}.bar{width:240px;height:4px;background:#1c2f5c;border-radius:4px;margin:18px auto 0;overflow:hidden}
.bar i{display:block;width:40%;height:100%;background:#e2231a;border-radius:4px;animation:m 1.2s ease-in-out infinite}
@keyframes m{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
#e{color:#ffb4ae;max-width:520px;margin:14px auto 0;line-height:1.5;display:none}</style></head><body><div class="b">
<svg class="l" viewBox="0 0 16 16"><rect width="16" height="16" rx="3.4" fill="#e2231a"/><path d="M4.3 13.2 3.7 9.3a4.3 4.3 0 0 1 8.6 0l-.6 3.9" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>
<h1>HRM <b>Viewer</b></h1><div id="s">Starting…</div><div class="bar"><i></i></div><div id="e"></div></div></body></html>`

var startMsgs = []string{"Starting…", "Starting the viewer…", "Opening your database…", "Getting your data ready…", "Almost there…"}
