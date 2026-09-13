/**
 * Browser-side IIFE entry point for the embedded xterm.js bundle used by the
 * transcript panel's PTY mode. Re-exported onto `window.AgentprotoXterm` so
 * the webview's inline script can construct a terminal without needing an
 * import mechanism (the webview has none).
 */

import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"

// @ts-expect-error — assigning to the global window object inside a browser IIFE.
window.AgentprotoXterm = { Terminal, FitAddon }
