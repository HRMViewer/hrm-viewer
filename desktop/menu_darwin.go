//go:build darwin && webview

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// The usual Mac menu bar. Without an Edit menu, Cmd+C, Cmd+V and Cmd+A don't work in the window's text boxes.
// Quit closes the window (rather than ending the app at once), so the viewer is stopped properly.
static void hrmvMenu(void) {
	NSMenu *bar = [[NSMenu alloc] init];

	NSMenuItem *appItem = [[NSMenuItem alloc] init];
	NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"HRM Viewer"];
	[appMenu addItemWithTitle:@"Hide HRM Viewer" action:@selector(hide:) keyEquivalent:@"h"];
	NSMenuItem *others = [appMenu addItemWithTitle:@"Hide Others" action:@selector(hideOtherApplications:) keyEquivalent:@"h"];
	[others setKeyEquivalentModifierMask:NSEventModifierFlagCommand | NSEventModifierFlagOption];
	[appMenu addItemWithTitle:@"Show All" action:@selector(unhideAllApplications:) keyEquivalent:@""];
	[appMenu addItem:[NSMenuItem separatorItem]];
	[appMenu addItemWithTitle:@"Quit HRM Viewer" action:@selector(performClose:) keyEquivalent:@"q"];
	[appItem setSubmenu:appMenu];
	[bar addItem:appItem];

	NSMenuItem *editItem = [[NSMenuItem alloc] init];
	NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
	[edit addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
	NSMenuItem *redo = [edit addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"z"];
	[redo setKeyEquivalentModifierMask:NSEventModifierFlagCommand | NSEventModifierFlagShift];
	[edit addItem:[NSMenuItem separatorItem]];
	[edit addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
	[edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
	[edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
	[edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
	[editItem setSubmenu:edit];
	[bar addItem:editItem];

	NSMenuItem *winItem = [[NSMenuItem alloc] init];
	NSMenu *win = [[NSMenu alloc] initWithTitle:@"Window"];
	[win addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
	[win addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
	[win addItem:[NSMenuItem separatorItem]];
	[win addItemWithTitle:@"Close" action:@selector(performClose:) keyEquivalent:@"w"];
	[winItem setSubmenu:win];
	[bar addItem:winItem];

	[NSApp setMainMenu:bar];
	[NSApp setWindowsMenu:win];
}

static void hrmvZoom(void *w) {
	NSWindow *win = (__bridge NSWindow *)w;
	// open as big as the screen allows, like the Windows app opens maximised
	NSRect f = [[win screen] visibleFrame];
	[win setFrame:f display:YES];
}
*/
import "C"

import webview "github.com/webview/webview_go"

func setupWindow(w webview.WebView) {
	C.hrmvMenu()
	if p := w.Window(); p != nil {
		C.hrmvZoom(p)
	}
}
