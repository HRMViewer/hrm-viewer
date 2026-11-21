//go:build !windows && webview

// HRM Viewer in its own window on Mac (WebKit) and Linux (WebKitGTK).
// On Linux this is lib/hrm-viewer-window, started by the "HRM Viewer" launcher; if it can't open a window
// it exits with exitNoWindow and the launcher opens the viewer in the browser instead.
package main

import (
	"os"
	"path/filepath"
	"runtime"
	"time"

	webview "github.com/webview/webview_go"
)

func main() {
	runtime.LockOSThread() // the window has to live on the main thread
	if runtime.GOOS == "linux" && os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		os.Exit(exitNoWindow)
	}
	if !canShowWindow() {
		os.Exit(exitNoWindow)
	}
	windowed = true
	w := webview.New(false)
	if w == nil || w.Window() == nil {
		os.Exit(exitNoWindow)
	}
	defer w.Destroy()
	w.SetTitle(title)
	w.SetSize(1440, 920, webview.HintNone)
	setupWindow(w) // Mac: the menu bar (copy and paste shortcuts, Quit)
	// the splash page calls this once it has been drawn: tells the Linux launcher the window really works
	w.Bind("hrmvShown", func() { os.Stdout.WriteString(windowShown + "\n") })
	w.SetHtml(splash)

	importPath := importArg()
	status := func(m string) {
		w.Dispatch(func() { w.Eval("document.getElementById('s').textContent=" + jsonStr(m)) })
	}
	fail := func(msg string) {
		w.Dispatch(func() {
			w.Eval("document.querySelector('.bar').style.display='none';document.getElementById('s').textContent='Something went wrong';" +
				"var e=document.getElementById('e');e.style.display='block';e.textContent=" + jsonStr(msg))
		})
	}

	var server *viewer
	go func() {
		if runtime.GOOS == "darwin" {
			status("Getting HRM Viewer ready…") // the first time, the viewer is copied to Application Support
		}
		if err := setup(); err != nil {
			fail("HRM Viewer couldn't get ready: " + err.Error())
			return
		}
		ready := startViewer(importPath, &server)
		t := time.NewTicker(time.Second)
		defer t.Stop()
		n := 0
		for {
			select {
			case err := <-ready:
				if err != nil {
					fail(failureText(err))
					return
				}
				logf("showing %s", base)
				w.Dispatch(func() { w.Navigate(base) })
				return
			case <-t.C:
				n++
				if n%4 == 0 && n/4 < len(startMsgs) {
					m := startMsgs[n/4]
					if importPath != "" && n/4 == 2 {
						m = "Loading " + filepath.Base(importPath) + " (this can take a few minutes)…"
					}
					status(m)
				}
			}
		}
	}()
	w.Run()
	// the window is closed: stop the viewer if this app started it
	stopServer(server)
}
