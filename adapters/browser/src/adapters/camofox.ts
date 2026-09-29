import { camofox } from "@agentproto/adapter-browser-camofox"
import { toAdapterHandle } from "../providers/to-adapter-handle.js"
import type { BrowserAdapterHandle } from "../types.js"

/** Facade over the kit `camofox` provider (`@agentproto/adapter-browser-camofox`). */
export const camofoxAdapter: BrowserAdapterHandle = toAdapterHandle(camofox, {
  defaultPort: 9377,
  healthPath: "/health",
  name: "Camofox (stealth Firefox headless)",
  description:
    "Camofox headless stealth Firefox REST API on :9377. Exposes /sessions, /tabs, and /health. Required dependency for the bureau adapter.",
})
