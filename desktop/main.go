//go:build windows

// HRM Viewer desktop app: starts the viewer in the background and shows it in its own window
// (Microsoft Edge WebView2), instead of a browser tab. Closing the window closes the viewer.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

const (
	firstPort = 8765 // the viewer's usual address; the next free one is used if another program has it
	lastPort  = 8785
	title     = "HRM Viewer"
	exeName   = "HRM Viewer.exe"
	newExe    = "HRM Viewer.new.exe"
	oldExe    = "HRM Viewer.old.exe"
	noWindow  = 0x08000000 // CREATE_NO_WINDOW
	swRestore = 9
	swMax     = 3
)

var (
	port     = firstPort
	base     = fmt.Sprintf("http://127.0.0.1:%d/", firstPort)
	user32   = windows.NewLazySystemDLL("user32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	pMsgBox  = user32.NewProc("MessageBoxW")
	pFindWin = user32.NewProc("FindWindowW")
	pShow    = user32.NewProc("ShowWindow")
	pFore    = user32.NewProc("SetForegroundWindow")
	pShellEx = shell32.NewProc("ShellExecuteW")
	appDir   string
	logFile  *os.File
)

func u16(s string) *uint16 { p, _ := windows.UTF16PtrFromString(s); return p }

func msgBox(text string, flags uintptr) int {
	r, _, _ := pMsgBox.Call(0, uintptr(unsafe.Pointer(u16(text))), uintptr(unsafe.Pointer(u16(title))), flags)
	return int(r)
}

func openURL(u string) {
	pShellEx.Call(0, uintptr(unsafe.Pointer(u16("open"))), uintptr(unsafe.Pointer(u16(u))), 0, 0, 1)
}

func logf(format string, a ...interface{}) {
	if logFile != nil {
		fmt.Fprintf(logFile, "%s  "+format+"\n", append([]interface{}{time.Now().Format("2006-01-02 15:04:05")}, a...)...)
	}
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// A newer desktop app delivered by "Install an update" is swapped in the next time the app starts.
func swapInNewExe() bool {
	self, err := os.Executable()
	if err != nil {
		return false
	}
	os.Remove(filepath.Join(appDir, oldExe))
	nw := filepath.Join(appDir, newExe)
	if !exists(nw) || !strings.EqualFold(filepath.Base(self), exeName) {
		return false
	}
	old := filepath.Join(appDir, oldExe)
	if os.Rename(self, old) != nil {
		return false
	}
	if os.Rename(nw, self) != nil {
		os.Rename(old, self)
		return false
	}
	cmd := exec.Command(self, os.Args[1:]...)
	cmd.Dir = appDir
	return cmd.Start() == nil
}

// Which port to use: one where HRM Viewer is already running, otherwise the first one nothing else is using.
// (Another program sitting on 8765 used to leave the window stuck on "Almost there…".)
func choosePort() {
	// the port the viewer used last time comes first, so its address (and the settings kept for it) stays the same
	if last := lastPortUsed(); last > 0 {
		setPort(last)
		if serverUp() {
			logf("HRM Viewer is already running on port %d", last)
			return
		}
		if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", last)); err == nil {
			l.Close()
			return
		}
	}
	for p := firstPort; p <= lastPort; p++ {
		setPort(p)
		if serverUp() {
			logf("HRM Viewer is already running on port %d", p)
			return
		}
		if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			l.Close()
			if p != firstPort {
				logf("port %d is used by another program, so port %d is used instead", firstPort, p)
			}
			return
		}
		logf("port %d is used by another program", p)
	}
	setPort(firstPort)
}

func portFile() string { return filepath.Join(appDir, "data", "port.json") }

// The port the viewer itself reports it opened (it finds a free one if the one asked for is taken).
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

// Is the viewer already answering on its port?
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

func findPython() (string, []string) {
	// the full download carries its own Python in the "python" folder, so nothing needs installing
	if p := filepath.Join(appDir, "python", "python.exe"); exists(p) {
		return p, nil
	}
	for _, c := range []struct {
		exe  string
		args []string
	}{{"py.exe", []string{"-3"}}, {"python.exe", nil}, {"python3.exe", nil}} {
		if p, err := exec.LookPath(c.exe); err == nil {
			// the Microsoft Store stub "python.exe" only opens the Store
			if strings.Contains(strings.ToLower(p), `\windowsapps\`) && c.exe != "py.exe" {
				out, err := exec.Command(p, "--version").Output()
				if err != nil || !bytes.HasPrefix(out, []byte("Python 3")) {
					continue
				}
			}
			return p, c.args
		}
	}
	return "", nil
}

func startServer(importPath string) (*exec.Cmd, error) {
	py, pre := findPython()
	if py == "" {
		return nil, fmt.Errorf("nopython")
	}
	args := append(append([]string{}, pre...), "app.py", "--no-browser", "--port", fmt.Sprint(port))
	if importPath != "" {
		args = append(args, "--import", importPath)
	}
	cmd := exec.Command(py, args...)
	cmd.Dir = appDir
	// the viewer may move to another free port if this one is taken, and says where in data\port.json
	os.Remove(portFile())
	cmd.Env = append(os.Environ(), "HRMV_DESKTOP=1", "PYTHONUNBUFFERED=1", "PYTHONIOENCODING=utf-8",
		"HRMV_PORT_AUTO=1", "HRMV_PORT_FILE="+portFile())
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: noWindow}
	if logFile != nil {
		cmd.Stdout, cmd.Stderr = logFile, logFile
	}
	logf("starting: %s %s", py, strings.Join(args, " "))
	return cmd, cmd.Start()
}

func stopServer(cmd *exec.Cmd) {
	c := http.Client{Timeout: 2 * time.Second}
	if r, err := c.Post(base+"api/quit", "application/json", strings.NewReader("{}")); err == nil {
		r.Body.Close()
	}
	done := make(chan struct{})
	go func() { cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(6 * time.Second):
		k := exec.Command("taskkill", "/T", "/F", "/PID", fmt.Sprint(cmd.Process.Pid))
		k.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: noWindow}
		k.Run()
	}
	logf("viewer closed")
}

type desktopState struct {
	AskedShortcut bool `json:"asked_shortcut"`
}

func maybeOfferShortcut() {
	p := filepath.Join(appDir, "data", "desktop.json")
	var st desktopState
	if b, err := os.ReadFile(p); err == nil {
		json.Unmarshal(b, &st)
	}
	if st.AskedShortcut {
		return
	}
	st.AskedShortcut = true
	os.MkdirAll(filepath.Dir(p), 0o755)
	if b, err := json.Marshal(st); err == nil {
		os.WriteFile(p, b, 0o644)
	}
	if msgBox("Add HRM Viewer to your desktop and Start menu?\n\nYou can then open it like any other program.", 0x4|0x20|0x40000) != 6 { // Yes/No, question, topmost
		return
	}
	makeShortcuts()
}

func makeShortcuts() {
	self, _ := os.Executable()
	ps := `$w = New-Object -ComObject WScript.Shell
foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $s = $w.CreateShortcut((Join-Path $d 'HRM Viewer.lnk'))
  $s.TargetPath = '` + strings.ReplaceAll(self, "'", "''") + `'
  $s.WorkingDirectory = '` + strings.ReplaceAll(appDir, "'", "''") + `'
  $s.IconLocation = '` + strings.ReplaceAll(self, "'", "''") + `,0'
  $s.Description = 'HRM Viewer'
  $s.Save()
}`
	cmd := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: noWindow}
	if err := cmd.Run(); err != nil {
		logf("shortcut: %v", err)
	}
}

const splash = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{height:100%;margin:0;background:#0a1a3b;color:#fff;font:15px "Segoe UI",system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
.b{text-align:center}.l{width:76px;height:76px;margin:0 auto 18px}h1{font-size:26px;margin:0 0 6px;font-weight:600}h1 b{font-weight:800}
#s{color:#9fb3d9;min-height:22px}.bar{width:240px;height:4px;background:#1c2f5c;border-radius:4px;margin:18px auto 0;overflow:hidden}
.bar i{display:block;width:40%;height:100%;background:#e2231a;border-radius:4px;animation:m 1.2s ease-in-out infinite}
@keyframes m{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
#e{color:#ffb4ae;max-width:520px;margin:14px auto 0;line-height:1.5;display:none}</style></head><body><div class="b">
<svg class="l" viewBox="0 0 16 16"><rect width="16" height="16" rx="3.4" fill="#e2231a"/><path d="M4.3 13.2 3.7 9.3a4.3 4.3 0 0 1 8.6 0l-.6 3.9" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>
<h1>HRM <b>Viewer</b></h1><div id="s">Starting…</div><div class="bar"><i></i></div><div id="e"></div></div></body></html>`

func jsStr(s string) string { b, _ := json.Marshal(s); return string(b) }

func main() {
	self, _ := os.Executable()
	appDir = filepath.Dir(self)
	if swapInNewExe() {
		return
	}
	os.MkdirAll(filepath.Join(appDir, "data"), 0o755)
	logFile, _ = os.OpenFile(filepath.Join(appDir, "data", "desktop.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if fi, err := logFile.Stat(); err == nil && fi.Size() > 5<<20 {
		logFile.Truncate(0)
	}

	// one window at a time: a second launch brings the open window to the front
	_, err := windows.CreateMutex(nil, false, u16("HRMViewerDesktopApp"))
	if err == windows.ERROR_ALREADY_EXISTS {
		if h, _, _ := pFindWin.Call(0, uintptr(unsafe.Pointer(u16(title)))); h != 0 {
			pShow.Call(h, swRestore)
			pFore.Call(h)
		}
		return
	}

	if !exists(filepath.Join(appDir, "app.py")) {
		msgBox("HRM Viewer.exe needs to stay in the HRM Viewer folder, next to app.py.\n\nTo open it from elsewhere, use a shortcut instead (right-click the exe > Send to > Desktop).", 0x10)
		return
	}
	importPath := ""
	if len(os.Args) > 1 && strings.HasSuffix(strings.ToLower(os.Args[1]), ".db") {
		importPath = os.Args[1] // a database.db dropped onto the exe
	}

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		DataPath:  filepath.Join(appDir, "data", "webview2"),
		WindowOptions: webview2.WindowOptions{Title: title, Width: 1440, Height: 920, IconId: 1, Center: true},
	})

	var server *exec.Cmd
	owned := false
	ready := make(chan error, 1)
	go func() {
		choosePort()
		if serverUp() {
			if importPath != "" {
				body, _ := json.Marshal(map[string]string{"path": importPath})
				http.Post(base+"api/import/path", "application/json", bytes.NewReader(body))
			}
			ready <- nil
			return
		}
		cmd, err := startServer(importPath)
		if err != nil {
			ready <- err
			return
		}
		server, owned = cmd, true
		exited := make(chan struct{})
		go func() { cmd.Wait(); close(exited) }()
		limit := time.Now().Add(15 * time.Minute) // loading a database first can take a while
		for time.Now().Before(limit) {
			select {
			case <-exited:
				if cmd.ProcessState != nil && cmd.ProcessState.ExitCode() == 4 {
					ready <- fmt.Errorf("portbusy") // another program took the port in the meantime
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

	if w == nil {
		// no WebView2 runtime: use the browser instead
		logf("WebView2 runtime not available")
		err := <-ready
		if err != nil {
			reportFailure(nil, err)
			return
		}
		if msgBox("HRM Viewer couldn't open its own window because the Microsoft Edge WebView2 Runtime isn't installed.\n\nIt will open in your browser this time. Click OK to also open the free WebView2 download page (choose \"Evergreen Bootstrapper\"), then start HRM Viewer again.", 0x1|0x30) == 1 {
			openURL("https://developer.microsoft.com/microsoft-edge/webview2/")
		}
		openURL(base)
		return
	}
	defer w.Destroy()
	w.SetHtml(splash)
	if h := w.Window(); h != nil {
		pShow.Call(uintptr(h), swMax)
	}
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		msgs := []string{"Starting…", "Starting the viewer…", "Opening your database…", "Getting your data ready…", "Almost there…"}
		n := 0
		for {
			select {
			case err := <-ready:
				if err != nil {
					w.Dispatch(func() { reportFailure(w, err) })
					return
				}
				w.Dispatch(func() { w.Navigate(base) })
				go maybeOfferShortcut()
				return
			case <-t.C:
				n++
				if n%4 == 0 && n/4 < len(msgs) {
					m := msgs[n/4]
					if importPath != "" && n/4 == 2 {
						m = "Loading " + filepath.Base(importPath) + " (this can take a few minutes)…"
					}
					w.Dispatch(func() { w.Eval("document.getElementById('s').textContent=" + jsStr(m)) })
				}
			}
		}
	}()
	w.Run()
	if owned && server != nil {
		stopServer(server)
	}
}

func reportFailure(w webview2.WebView, err error) {
	var msg string
	switch err.Error() {
	case "nopython":
		msg = "Part of HRM Viewer is missing (its \"python\" folder).\n\nClick OK to open the download page, download HRM-Viewer-<version>-full.zip, unzip it and open HRM Viewer.exe from there. To keep your data, copy your old \"data\" folder into the new HRM Viewer folder."
		if msgBox(msg, 0x1|0x30) == 1 {
			openURL("https://github.com/HRMViewer/hrm-viewer/releases/latest")
		}
		if w != nil {
			w.Terminate()
		}
		return
	case "portbusy":
		msg = fmt.Sprintf("Another program on this computer is using the viewer's address (port %d), so it couldn't start. Close that program or restart your PC, then open HRM Viewer again.", port)
	case "timeout":
		msg = "The viewer is taking too long to start."
	default:
		msg = "The viewer stopped while starting."
	}
	msg += " Details are in data\\desktop.log in the HRM Viewer folder."
	logf("failed: %v", err)
	if w != nil {
		w.Eval("document.querySelector('.bar').style.display='none';document.getElementById('s').textContent='Something went wrong';var e=document.getElementById('e');e.style.display='block';e.textContent=" + jsStr(msg))
		return
	}
	msgBox(msg, 0x10)
}
