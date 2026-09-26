/**
 * `@agentproto/config` — daemon-wide configuration as its own standalone app.
 *
 * A separate app from `ops-panel` (not a section of it): ops-panel is the
 * daemon operations cockpit (sessions, crons, housekeeping); this app is the
 * visual twin of `agentproto config` — wallets (auth profiles + spend),
 * harnesses, the model catalog, defaults/messaging knobs, remote/pairing,
 * and a raw config escape hatch. `ops-panel` is referenced only for its app
 * mechanics (`defineApp`, self-contained panel HTML, `app_tool_call` gated
 * by a `ui.tools` allowlist) — see `ui.ts`.
 *
 * READ-ONLY v1: `agents: []` (UI only, no durable sessions to launch), and
 * every `ui.tools` entry is a read tool — no write flow ships in this PR.
 */

import { defineApp, type AppHandle } from "@agentproto/app-kit"
import { CONFIG_HTML, CONFIG_TOOLS } from "./ui.js"

export const configApp: AppHandle = defineApp({
  id: "@agentproto/config",
  name: "agentproto config",
  version: "0.1.0",
  description:
    "Daemon-wide configuration, read-only: wallets (auth profiles + spend), harnesses, " +
    "the model catalog, defaults & messaging knobs, remote & pairing, and a raw config dump.",
  agents: [],
  ui: {
    html: CONFIG_HTML,
    title: "agentproto config",
    tools: [...CONFIG_TOOLS],
  },
})

export { CONFIG_TOOLS } from "./ui.js"
export { parseConfigFragment, buildConfigFragment, CONFIG_SECTIONS } from "./fragment.js"
export type { ConfigSection, ParsedConfigFragment } from "./fragment.js"
