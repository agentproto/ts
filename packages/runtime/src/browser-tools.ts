/**
 * MCP tools that expose browser service adapters (Camofox, Bureau, …) to
 * agents connected to the daemon. Lets a remote operator start, stop, and
 * inspect browser service sessions through the same MCP connection it uses
 * for fs/exec/agent-cli.
 *
 * Five tools:
 *   list_adapter_browsers   discover available browser adapter ids + metadata
 *   start_browser           ensure a browser adapter is up, register as a session
 *   stop_browser            kill a running browser session
 *   list_browsers           browse alive/recent browser sessions
 *   browser_status          descriptor + live health probe for one session
 *
 * Auth: same as every other daemon tool — gated by the gateway's auth source.
 *
 * Injection pattern: `resolveBrowserAdapter` is passed in, not imported.
 * This keeps the runtime package free of a hard dep on @agentproto/adapter-browser.
 * The types below are minimal structural shapes — equivalent to `AgentSessionLike`
 * in sessions.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SessionsRegistry } from "./sessions.js"

// ── Minimal structural types (no dep on @agentproto/adapter-browser) ──────────

/**
 * Minimal shape of a BrowserAdapterInstance — structurally compatible with
 * @agentproto/adapter-browser's BrowserAdapterInstance. Kept local so the
 * runtime package stays free of a hard dependency on the adapter package.
 */
interface BrowserInstanceLike {
  id: string
  port: number
  baseUrl: string
  pid?: number
  wasAlreadyRunning: boolean
  stop(): Promise<void>
}

/**
 * Minimal shape of a BrowserAdapterHandle — structurally compatible with
 * @agentproto/adapter-browser's BrowserAdapterHandle.
 */
interface BrowserAdapterLike {
  id: string
  name: string
  description: string
  defaultPort: number
  healthPath: string
  ensure(opts: {
    port?: number
    /** forwarded to dependent adapters (e.g. bureau→camofox) */
    camofoxPort?: number
    launchCmd?: string
    env?: Record<string, string>
    timeoutMs?: number
    log?: (s: string) => void
  }): Promise<BrowserInstanceLike>
}

export type BrowserAdapterResolver = (id: string) => BrowserAdapterLike | undefined
export type BrowserAdapterLister = () => {
  id: string
  name: string
  description: string
  defaultPort: number
}[]

// ── Registration ──────────────────────────────────────────────────────────────

interface RegisterBrowserToolsOptions {
  registry: SessionsRegistry
  /** Resolver for browser adapters — injected by the serve/CLI layer (P6).
   *  Required for `start_browser`; the tool returns a clear error when unset. */
  resolveBrowserAdapter?: BrowserAdapterResolver
  /** Lister for available browser adapters — when unset, `list_adapter_browsers`
   *  returns a "not configured" message. */
  listBrowserAdapters?: BrowserAdapterLister
  log?: (msg: string) => void
}

export function registerBrowserTools(
  server: McpServer,
  opts: RegisterBrowserToolsOptions
): void {
  const { registry, resolveBrowserAdapter, listBrowserAdapters, log } = opts

  // ── list_adapter_browsers ────────────────────────────────────────────────────
  server.tool(
    "list_adapter_browsers",
    "List available browser adapter ids and their metadata (name, description, default port). " +
      "Use the `id` field to reference an adapter in `start_browser`.",
    {},
    async () => {
      if (!listBrowserAdapters) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "list_adapter_browsers is not enabled — the daemon was started without " +
                "a browser adapter lister. Re-run with `listBrowserAdapters` wired.",
            },
          ],
          isError: true,
        }
      }
      const adapters = listBrowserAdapters()
      return {
        content: [{ type: "text" as const, text: JSON.stringify(adapters, null, 2) }],
      }
    }
  )

  // ── start_browser ────────────────────────────────────────────────────────────
  server.tool(
    "start_browser",
    "Ensure a browser adapter service is running, then register it as a tracked session. " +
      "Idempotent: if the service is already healthy, returns wasAlreadyRunning=true without spawning. " +
      "Returns the session descriptor (sessionId, browserBaseUrl, …) for subsequent calls.",
    {
      adapter: z
        .string()
        .min(1)
        .describe(
          "Browser adapter id — one of the ids returned by `list_adapter_browsers` " +
            "(e.g. 'camofox', 'bureau')."
        ),
      port: z
        .number()
        .int()
        .optional()
        .describe("Override the adapter's default port."),
      camofoxPort: z
        .number()
        .int()
        .optional()
        .describe(
          "For adapters that depend on Camofox (e.g. 'bureau'): override the Camofox port (default 9377)."
        ),
      label: z
        .string()
        .optional()
        .describe("Free-text label surfaced in `list_browsers` and the UI."),
    },
    async input => {
      if (!resolveBrowserAdapter) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "start_browser is not enabled — the daemon was started without " +
                "a browser adapter resolver. Re-run with `resolveBrowserAdapter` wired.",
            },
          ],
          isError: true,
        }
      }
      const adapter = resolveBrowserAdapter(input.adapter)
      if (!adapter) {
        const available = listBrowserAdapters
          ? listBrowserAdapters()
              .map(a => a.id)
              .join(", ")
          : "camofox, bureau"
        return {
          content: [
            {
              type: "text" as const,
              text: `start_browser: adapter "${input.adapter}" not found. Available adapters: ${available}.`,
            },
          ],
          isError: true,
        }
      }
      try {
        const instance = await adapter.ensure({
          port: input.port,
          camofoxPort: input.camofoxPort,
          log: msg => log?.(`[start_browser:${input.adapter}] ${msg}`),
        })
        const desc = registry.registerBrowser({
          adapterId: instance.id,
          port: instance.port,
          baseUrl: instance.baseUrl,
          pid: instance.pid,
          wasAlreadyRunning: instance.wasAlreadyRunning,
          stop: instance.stop.bind(instance),
          label: input.label,
        })
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  sessionId: desc.id,
                  browserAdapterId: desc.browserAdapterId,
                  browserPort: desc.browserPort,
                  browserBaseUrl: desc.browserBaseUrl,
                  wasAlreadyRunning: instance.wasAlreadyRunning,
                  status: desc.status,
                },
                null,
                2
              ),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `start_browser: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── stop_browser ─────────────────────────────────────────────────────────────
  server.tool(
    "stop_browser",
    "Stop a browser session registered by `start_browser`. " +
      "Calls the adapter's stop() (best-effort SIGTERM) and marks the session as killed.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Session id returned by `start_browser` or `list_browsers`."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) {
        return {
          content: [
            {
              type: "text" as const,
              text: `stop_browser: session "${input.sessionId}" not found.`,
            },
          ],
          isError: true,
        }
      }
      if (desc.kind !== "browser") {
        return {
          content: [
            {
              type: "text" as const,
              text: `stop_browser: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`,
            },
          ],
          isError: true,
        }
      }
      const killed = registry.kill(input.sessionId)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ sessionId: input.sessionId, killed }, null, 2),
          },
        ],
      }
    }
  )

  // ── list_browsers ────────────────────────────────────────────────────────────
  server.tool(
    "list_browsers",
    "List browser sessions tracked by the daemon (all or alive-only).",
    {
      onlyAlive: z
        .boolean()
        .optional()
        .describe(
          "When true, return only sessions with status='running'. Default false (all including killed/exited)."
        ),
    },
    async input => {
      const all = registry
        .list()
        .filter(d => d.kind === "browser")
      const result = input.onlyAlive
        ? all.filter(d => d.status === "running")
        : all
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  // ── browser_status ───────────────────────────────────────────────────────────
  server.tool(
    "browser_status",
    "Get the descriptor and live health status for a specific browser session. " +
      "Probes the service's /health endpoint to confirm it is still responding.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Session id returned by `start_browser` or `list_browsers`."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) {
        return {
          content: [
            {
              type: "text" as const,
              text: `browser_status: session "${input.sessionId}" not found.`,
            },
          ],
          isError: true,
        }
      }
      if (desc.kind !== "browser") {
        return {
          content: [
            {
              type: "text" as const,
              text: `browser_status: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`,
            },
          ],
          isError: true,
        }
      }

      let healthy: boolean | null = null
      let healthBody: unknown = null
      if (desc.browserBaseUrl) {
        const healthUrl = `${desc.browserBaseUrl}/health`
        const ac = new AbortController()
        const t = setTimeout(() => ac.abort(), 3000)
        try {
          const r = await fetch(healthUrl, { signal: ac.signal })
          healthy = r.ok
          if (r.ok) {
            try { healthBody = await r.json() } catch { /* non-JSON health */ }
          }
        } catch {
          healthy = false
        } finally {
          clearTimeout(t)
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ descriptor: desc, healthy, healthBody }, null, 2),
          },
        ],
      }
    }
  )
}
