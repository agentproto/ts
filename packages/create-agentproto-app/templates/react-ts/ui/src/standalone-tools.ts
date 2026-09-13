/**
 * Mock tool handlers for standalone mode — the connection falls back to
 * these when there's no host `window.McpApp` and no `app dev` bridge to
 * reach (plain `vite dev`, or opening the built output via `file://`), so
 * the UI still renders with representative data instead of erroring.
 */

import type { StandaloneToolHandler } from "@agentproto/app-client"

export const standaloneTools: Readonly<Record<string, StandaloneToolHandler>> = {
  app_status: () => ({
    running: true,
    appId: "__APP_ID__",
  }),
  app_data_list: (args) => ({
    items: [
      `(standalone mock) key=${typeof args.key === "string" ? args.key : "default"}`,
      "replace standaloneTools with real app data once wired up",
    ],
  }),
}
