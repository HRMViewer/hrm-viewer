#!/bin/sh
# webview_go asks pkg-config for webkit2gtk-4.0, which current Linux releases no longer have;
# build against webkit2gtk-4.1 (the same API, newer network library) instead.
exec pkg-config $(printf '%s\n' "$@" | sed 's/^webkit2gtk-4\.0$/webkit2gtk-4.1/')
