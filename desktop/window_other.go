//go:build !windows && !darwin && webview

package main

/*
#cgo pkg-config: gtk+-3.0
#include <gtk/gtk.h>
#include <stdlib.h>

// can GTK reach a screen? (DISPLAY can be set while the screen behind it is gone)
static int hrmvCanShow(void) { return gtk_init_check(NULL, NULL) ? 1 : 0; }

static void hrmvSetup(void *w, const char *icon) {
	GtkWindow *win = GTK_WINDOW(w);
	if (icon) gtk_window_set_icon_from_file(win, icon, NULL);
	gtk_window_maximize(win);   // opens as big as the screen allows, like the Windows app
}
*/
import "C"

import (
	"os"
	"path/filepath"
	"unsafe"

	webview "github.com/webview/webview_go"
)

func canShowWindow() bool { return C.hrmvCanShow() == 1 }

func setupWindow(w webview.WebView) {
	p := w.Window()
	if p == nil {
		return
	}
	var icon *C.char
	if self, err := os.Executable(); err == nil {
		for _, c := range []string{filepath.Join(filepath.Dir(self), "..", "hrm-viewer.png"), filepath.Join(filepath.Dir(self), "hrm-viewer.png")} {
			if exists(c) {
				icon = C.CString(c)
				defer C.free(unsafe.Pointer(icon))
				break
			}
		}
	}
	C.hrmvSetup(p, icon)
}
