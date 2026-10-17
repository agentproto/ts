/**
 * MCP tools that expose browser service adapters (Camofox, Bureau, …) to
 * agents connected to the daemon. Lets a remote operator start, stop, and
 * inspect browser service sessions through the same MCP connection it uses
 * for fs/exec/agent-cli.
 *
 * Five tools:
 *   browser_adapter_list   discover available browser adapter ids + metadata
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
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import type { AdapterLister } from "@agentproto/provider-kit"
import { registerBuiltinTool } from "@agentproto/mcp-server"
import { catchErrors, paginated } from "@agentproto/tool"
import type { SessionsRegistry, SessionDescriptor } from "./sessions.js"
import { defaultBrowserAdapterIds } from "./browser-adapters.js"
import { encodeScreencastFramesToMp4, prepareScreencastOutDir } from "./browser-screencast.js"

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
  /** False when a non-blocking cold start returned before the service
   *  finished converging (background health-wait still running). */
  healthy: boolean
  health?(): Promise<{ ok: boolean; reason?: string }>
  screenshot?(tabId?: string): Promise<{ data: string; format: "png" | "jpeg"; width?: number; height?: number }>
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
  /** Where this adapter runs — "local" (default) or "cloud". */
  location?: "local" | "cloud"
  ensure(opts: {
    port?: number
    /** forwarded to dependent adapters (e.g. bureau→camofox) */
    camofoxPort?: number
    launchCmd?: string
    env?: Record<string, string>
    timeoutMs?: number
    /** Opt-in non-blocking cold start: wait only this long for a freshly
     *  spawned service before returning `healthy:false` and converging
     *  in the background. */
    initialWaitMs?: number
    log?: (s: string) => void
    /** Override execution location ("local" or "cloud"). */
    location?: "local" | "cloud"
    /** Base URL of the remote service when location="cloud". */
    baseUrl?: string
    /** Override the binary path for a local spawn. */
    binPath?: string
    /** chrome-live only: "dedicated" (default) or "personal" (attachIntent). Every other adapter ignores this. */
    profile?: "dedicated" | "personal"
  }): Promise<BrowserInstanceLike>
}

/**
 * Bounded window `start_browser` waits for a freshly-spawned service to become
 * healthy before returning `starting`. Heavy services (chromium, bureau) take
 * >60s to boot (pnpm + Chrome launch) and would otherwise time out the MCP
 * request; we return promptly and let health converge in the background.
 */
const START_BROWSER_INITIAL_WAIT_MS = 6_000

export type BrowserAdapterResolver = (id: string) => BrowserAdapterLike | undefined
export type BrowserAdapterLister = () => {
  id: string
  name: string
  description: string
  defaultPort: number
  /** Where this adapter runs — "local" (default) or "cloud". */
  location?: "local" | "cloud"
  /** Install methods — informational metadata from the adapter manifest. */
  install?: unknown[]
  /** Config prompts — informational metadata from the adapter manifest. */
  config?: unknown[]
}[]

/**
 * Family-specific descriptor surfaced in the kit-path `browser_adapter_list`
 * response. Fields match the legacy lister shape so the tool output is
 * unchanged regardless of which path is active.
 */
export interface BrowserAdapterInfo {
  id: string
  name: string
  description: string
  defaultPort: number
}

/** One `browser_adapter_list` row before projection: the legacy lister shape
 *  (id/name/description/defaultPort + optional manifest metadata). Kit-path
 *  rows (`BrowserAdapterInfo`) are structurally compatible. */
export interface BrowserAdapterListRow {
  id: string
  name: string
  description: string
  defaultPort: number
  location?: "local" | "cloud"
  install?: unknown[]
  config?: unknown[]
}

/**
 * `browser_adapter_list`'s COMPACT per-row projection: the fields a caller
 * needs to pick an adapter and route `start_browser` — id, display name,
 * default port, and (when declared) where it runs. The verbose prose
 * `description` and the bulky informational `install`/`config` manifest
 * arrays stay behind `full: true` / `compact: false`.
 */
export const compactBrowserAdapterRow = (a: BrowserAdapterListRow) => ({
  id: a.id,
  name: a.name,
  defaultPort: a.defaultPort,
  ...(a.location !== undefined ? { location: a.location } : {}),
})

/**
 * `list_browsers`'s COMPACT per-row projection: the identity/routing fields
 * of a browser session descriptor — id, name/label, status, the browser
 * coordinates (`browserAdapterId`/`browserPort`/`browserBaseUrl`/
 * `browserLocation`), pid, and activity timestamps. The bulky descriptor
 * remainder (resume/restart bookkeeping, spawn metadata, … — fields a
 * browser lister never consumes) stays behind `full: true` /
 * `compact: false`, which return the unmodified SessionDescriptor rows.
 */
export const compactBrowserSessionRow = (d: SessionDescriptor) => ({
  id: d.id,
  ...(d.name !== undefined ? { name: d.name } : {}),
  ...(d.label !== undefined ? { label: d.label } : {}),
  status: d.status,
  ...(d.pid != null ? { pid: d.pid } : {}),
  ...(d.browserAdapterId !== undefined ? { browserAdapterId: d.browserAdapterId } : {}),
  ...(d.browserPort !== undefined ? { browserPort: d.browserPort } : {}),
  ...(d.browserBaseUrl !== undefined ? { browserBaseUrl: d.browserBaseUrl } : {}),
  ...(d.browserLocation !== undefined ? { browserLocation: d.browserLocation } : {}),
  startedAt: d.startedAt,
  ...(d.lastActivityAt !== undefined ? { lastActivityAt: d.lastActivityAt } : {}),
})

// ── Shared result helpers ─────────────────────────────────────────────────────

const okResult = (r: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(r) }],
  structuredContent: r,
})

const errResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
})

// ── Registration ──────────────────────────────────────────────────────────────

// Live browser adapter instances, keyed by the registry session id. This MUST
// live at module scope: `mcpServerFactory` re-runs `registerBrowserTools` once
// per `/mcp` request (the SDK's stateless per-request transport pattern,
// packages/runtime/src/index.ts), so a map closed over by a single
// registration dies with that request — `start_browser` stored the instance in
// a map its next tool call never saw (chrome-live screenshots failed with
// "provider instance unavailable" right after a successful attach). The
// adapter-level singleton (`chromeLive`) survives because browsers hold their
// own module-level entries map — this map must survive the same way.
const liveInstances = new Map<string, BrowserInstanceLike>()

// Track the registry id an instance is stored under (the id only becomes
// known after `registerBrowser` returns); the `start_browser` handler wires
// the registry's `stop` to drop the entry.
export function setLiveBrowserInstance(
  sessionId: string,
  instance: BrowserInstanceLike
): void {
  liveInstances.set(sessionId, instance)
}

export function getLiveBrowserInstance(
  sessionId: string
): BrowserInstanceLike | undefined {
  return liveInstances.get(sessionId)
}

export function forgetLiveBrowserInstance(sessionId: string): void {
  liveInstances.delete(sessionId)
}

interface RegisterBrowserToolsOptions {
  registry: SessionsRegistry
  /** Resolver for browser adapters — injected by the serve/CLI layer (P6).
   *  Required for `start_browser`; the tool returns a clear error when unset. */
  resolveBrowserAdapter?: BrowserAdapterResolver
  /** Lister for available browser adapters — when unset, `browser_adapter_list`
   *  returns a "not configured" message. */
  listBrowserAdapters?: BrowserAdapterLister
  /**
   * Kit-path lister (Phase 3). When provided, `browser_adapter_list` calls
   * this async lister and extracts `AdapterEntry.info` fields for the response,
   * preserving the existing `{ id, name, description, defaultPort }[]` shape.
   * When absent, the legacy `listBrowserAdapters` path is used.
   */
  lister?: AdapterLister<BrowserAdapterInfo>
  log?: (msg: string) => void
}

export function registerBrowserTools(
  server: McpServer,
  opts: RegisterBrowserToolsOptions
): void {
  const { registry, resolveBrowserAdapter, listBrowserAdapters, lister, log } = opts

  // ── browser_adapter_list ────────────────────────────────────────────────────
  // Migrated onto the AIP contract layer (defineTool + implementTool +
  // toMcpTool): pagination/compact/fields via `paginated()` and error
  // normalization via `catchErrors()` at registration. The not-configured
  // guard now THROWS the same message — `catchErrors()` turns it into the
  // same canonical error result.
  const browserAdapterListSchema = z.object({})
  type BrowserAdapterListInput = z.infer<typeof browserAdapterListSchema>

  registerBuiltinTool<BrowserAdapterListInput, BrowserAdapterListRow[]>(server, {
    id: "browser_adapter_list",
    description: "List available browser adapter ids and their metadata (name, default port). " +
      "Use the `id` field to reference an adapter in `start_browser`. " +
      "COMPACT BY DEFAULT: rows are {id, name, defaultPort, location?}; pass " +
      "`full: true` (or `compact: false`) to also carry the prose " +
      "`description` and the informational `install`/`config` manifest arrays.",
    inputSchema: browserAdapterListSchema,
    handler: async () => {
      // Kit path: async lister supplied — extract info fields to preserve the
      // existing { id, name, description, defaultPort }[] response shape.
      if (lister) {
        const entries = await lister()
        return entries.flatMap(e => (e.info ? [e.info] : []))
      }
      // Legacy path: synchronous injected lister.
      if (!listBrowserAdapters) {
        throw new Error(
          "browser_adapter_list is not enabled — the daemon was started without " +
            "a browser adapter lister. Re-run with `listBrowserAdapters` wired.",
        )
      }
      return listBrowserAdapters()
    },
    transformers: [
      catchErrors(),
      paginated({
        project: compactBrowserAdapterRow,
        keyOf: a => a.id,
        maxLimit: 200,
        itemKey: "adapters",
      }),
    ],
  })

  // ── start_browser ────────────────────────────────────────────────────────────
  server.tool(
    "start_browser",
    "Ensure a browser adapter service is running, then register it as a tracked session. " +
      "Idempotent: if the service is already healthy, returns wasAlreadyRunning=true without spawning. " +
      "Returns the session descriptor (sessionId, browserBaseUrl, …) for subsequent calls. " +
      "For adapter 'chrome-live': `profile` picks a dedicated, zero-consent Chrome (default) or the " +
      "user's own, logged-in Chrome — see `profile`'s own description for when to choose which.",
    {
      adapter: z
        .string()
        .min(1)
        .describe(
          "Browser adapter id — one of the ids returned by `browser_adapter_list` " +
            "(e.g. 'camofox', 'bureau')."
        ),
      profile: z
        .enum(["dedicated", "personal"])
        .optional()
        .describe(
          "chrome-live only; every other adapter ignores this. 'dedicated' (default) launches or " +
            "reuses a dedicated, zero-consent Chrome on its own profile — use this unless the task " +
            "specifically needs it. 'personal' attaches to the user's own, logged-in Chrome instead " +
            "(their real cookies/sessions, a consent click the first time) — choose 'personal' ONLY " +
            "when the task needs to see something from the user's own accounts (their inbox, their " +
            "logged-in dashboard, a site only their session can reach); never for a public page or a " +
            "source you can read logged out."
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
      location: z
        .enum(["local", "cloud"])
        .optional()
        .describe(
          "Override execution location. 'local' spawns the adapter process on this machine (default). " +
            "'cloud' health-checks a remote endpoint at `baseUrl` without spawning anything."
        ),
      baseUrl: z
        .string()
        .optional()
        .describe(
          "Base URL of the remote service when location='cloud' " +
            "(e.g. 'https://browser-service.example.com'). Required when location='cloud'."
        ),
      binPath: z
        .string()
        .optional()
        .describe(
          "Override the binary path used for the local spawn. " +
            "When unset, the adapter resolves its own default binary."
        ),
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
          : defaultBrowserAdapterIds().join(", ")
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
          location: input.location,
          baseUrl: input.baseUrl,
          binPath: input.binPath,
          profile: input.profile,
          // Non-blocking cold start: if the freshly spawned service isn't
          // healthy within this bounded window, register it as `starting`
          // and let health converge in the background instead of blocking
          // the MCP request until the full health timeout.
          initialWaitMs: START_BROWSER_INITIAL_WAIT_MS,
          log: msg => log?.(`[start_browser:${input.adapter}] ${msg}`),
        })
        // The registry's `stop` wrapper drops the map entry keyed by this
        // session id (registry kill() → browserStop → wrapper → delete).
        const pendingId: { current?: string } = {}
        const stopInstance = instance.stop.bind(instance)
        const desc = registry.registerBrowser({
          adapterId: instance.id,
          port: instance.port,
          baseUrl: instance.baseUrl,
          location: input.location ?? adapter.location,
          pid: instance.pid,
          wasAlreadyRunning: instance.wasAlreadyRunning,
          status: instance.healthy ? "running" : "starting",
          stop: async () => {
            if (pendingId.current) liveInstances.delete(pendingId.current)
            await stopInstance()
          },
          label: input.label,
        })
        pendingId.current = desc.id
        setLiveBrowserInstance(desc.id, instance)
        const stillStarting = !instance.healthy
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
                  ...(stillStarting
                    ? {
                        hint:
                          `Service is still booting (cold start). It was spawned successfully ` +
                          `and is converging to healthy in the background — poll ` +
                          `\`browser_status\` with sessionId "${desc.id}" until status is "running".`,
                      }
                    : {}),
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
      const ok = registry.kill(input.sessionId)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok, sessionId: input.sessionId }),
          },
        ],
      }
    }
  )

  // ── list_browsers ────────────────────────────────────────────────────────────
  // Migrated onto the AIP contract layer (defineTool + implementTool +
  // toMcpTool): pagination/compact/fields via `paginated()` and error
  // normalization via `catchErrors()` at registration.
  const listBrowsersSchema = z.object({
    onlyAlive: z
      .boolean()
      .optional()
      .describe(
        "When true, return only sessions with status='running'. Default false (all including killed/exited)."
      ),
  })
  type ListBrowsersInput = z.infer<typeof listBrowsersSchema>

  registerBuiltinTool<ListBrowsersInput, SessionDescriptor[]>(server, {
    id: "list_browsers",
    description: "List browser sessions tracked by the daemon (all or alive-only). " +
      "COMPACT BY DEFAULT: each row is a slim projection (id/name/label/" +
      "status/browserAdapterId/browserPort/browserBaseUrl/browserLocation/" +
      "pid/startedAt/lastActivityAt); pass `full: true` (or `compact: false`) " +
      "for the complete, unprojected session descriptors.",
    inputSchema: listBrowsersSchema,
    handler: async (input) => {
      const all = registry
        .list()
        .filter(d => d.kind === "browser")
      return input.onlyAlive
        ? all.filter(d => d.status === "running")
        : all
    },
    transformers: [
      catchErrors(),
      paginated({
        project: compactBrowserSessionRow,
        keyOf: d => d.id,
        maxLimit: 200,
        itemKey: "browsers",
      }),
    ],
  })

  // ── browser_status ───────────────────────────────────────────────────────────
  server.tool(
    "browser_status",
    "Get the descriptor and live health status for a specific browser session. " +
      "Probes the service's /health endpoint, or the provider's live connection when HTTP health is unavailable.",
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
      const liveInstance = liveInstances.get(desc.id)
      if (desc.browserAdapterId === "chrome-live") {
        if (liveInstance?.health) {
          try {
            const result = await liveInstance.health()
            healthy = result.ok
            healthBody = result
          } catch (err) {
            healthy = false
            healthBody = { reason: err instanceof Error ? err.message : String(err) }
          }
        } else {
          healthBody = { reason: "provider instance unavailable; chrome-live has no HTTP health endpoint" }
        }
      } else if (desc.browserBaseUrl) {
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
            text: JSON.stringify({ descriptor: desc, healthy, healthBody }),
          },
        ],
      }
    }
  )

  // ── browser_screenshot ───────────────────────────────────────────────────────
  server.tool(
    "browser_screenshot",
    "Capture a base64-encoded screenshot of what an agent's browser session is currently showing. " +
      "Dispatches to the correct backend by the session's browserAdapterId: " +
      "camofox → GET /tabs/:tabId/screenshot, " +
      "bureau → POST /mcp browser_screenshot, " +
      "chromium → POST /sessions/:id/screenshot; providers may supply their own owned-target capture. " +
      "Returns { data (base64, no data: prefix), format, width?, height? } in both text and structuredContent.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` or `list_browsers`."),
      tabId: z
        .string()
        .optional()
        .describe(
          "Camofox: tabId to screenshot (default: first active tab). " +
            "Chromium: service-internal session id (default: first listed session). " +
            "Chrome Live: provider-owned target id (default: first active agent tab; foreign tabs are rejected). " +
            "Bureau: ignored (bureau screenshots its current tab)."
        ),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc)
        return errResult(`browser_screenshot: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(
          `browser_screenshot: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`
        )
      if (!desc.browserBaseUrl)
        return errResult(`browser_screenshot: session "${input.sessionId}" has no browserBaseUrl.`)

      const liveInstance = liveInstances.get(desc.id)
      if (liveInstance?.screenshot) {
        try {
          return okResult(await liveInstance.screenshot(input.tabId))
        } catch (err) {
          return errResult(`browser_screenshot: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (desc.browserAdapterId === "chrome-live") {
        return errResult("browser_screenshot: chrome-live provider instance is unavailable; start the browser again to reconnect")
      }

      // Normalise to IPv4 — node/undici resolves localhost→::1 first but these
      // services bind IPv4 only.
      const rawUrl = new URL(desc.browserBaseUrl)
      if (rawUrl.hostname === "localhost") rawUrl.hostname = "127.0.0.1"
      const base = rawUrl.href.replace(/\/$/, "")
      const adapterId = desc.browserAdapterId ?? ""

      // AbortController created after all guard-returns so the finally block
      // below covers every path that reaches the network.
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 15_000)

      try {
        // ── camofox (port 9377): GET /tabs/:tabId/screenshot ────────────────────
        if (adapterId === "camofox") {
          let tabId = input.tabId
          if (!tabId) {
            const tabsRes = await fetch(`${base}/tabs?userId=main`, { signal: ac.signal })
            if (!tabsRes.ok) throw new Error(`camofox /tabs: HTTP ${tabsRes.status}`)
            const tabsBody = (await tabsRes.json()) as { tabs?: { tabId: string }[] }
            tabId = tabsBody.tabs?.[0]?.tabId
            if (!tabId) throw new Error("camofox: no active tabs found")
          }
          const shotRes = await fetch(
            `${base}/tabs/${encodeURIComponent(tabId)}/screenshot?userId=main&format=png`,
            { signal: ac.signal }
          )
          if (!shotRes.ok) throw new Error(`camofox screenshot: HTTP ${shotRes.status}`)
          const data = Buffer.from(await shotRes.arrayBuffer()).toString("base64")
          return okResult({ data, format: "png" as const })
        }

        // ── bureau (port 8830): POST /mcp → browser_screenshot MCP tool ─────────
        if (adapterId === "bureau") {
          const mcpBody = {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "browser_screenshot", arguments: { format: "png" } },
          }
          const mcpRes = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify(mcpBody),
            signal: ac.signal,
          })
          if (!mcpRes.ok) throw new Error(`bureau /mcp: HTTP ${mcpRes.status}`)
          const envelope = (await mcpRes.json()) as {
            result?: { content?: { type: string; text?: string }[] }
            error?: { message?: string }
          }
          if (envelope.error)
            throw new Error(`bureau MCP error: ${envelope.error.message ?? "unknown"}`)
          const textBlock = envelope.result?.content?.find(c => c.type === "text")
          if (!textBlock?.text) throw new Error("bureau MCP: no text content block in response")
          const shot = JSON.parse(textBlock.text) as {
            base64?: string
            format?: string
            width?: number
            height?: number
          }
          if (!shot.base64) throw new Error("bureau MCP: screenshot result missing base64 field")
          return okResult({
            data: shot.base64,
            format: (shot.format ?? "png") as "png" | "jpeg",
            ...(shot.width != null ? { width: shot.width } : {}),
            ...(shot.height != null ? { height: shot.height } : {}),
          })
        }

        // ── chromium (port 3200): POST /sessions/:id/screenshot ─────────────────
        if (adapterId === "chromium") {
          let chromiumSessionId = input.tabId
          if (!chromiumSessionId) {
            const listRes = await fetch(`${base}/sessions`, { signal: ac.signal })
            if (!listRes.ok) throw new Error(`chromium /sessions: HTTP ${listRes.status}`)
            const listBody = (await listRes.json()) as { sessions?: { id: string }[] }
            chromiumSessionId = listBody.sessions?.[0]?.id
            if (!chromiumSessionId) throw new Error("chromium: no active sessions found")
          }
          const shotRes = await fetch(
            `${base}/sessions/${encodeURIComponent(chromiumSessionId)}/screenshot`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ format: "png" }),
              signal: ac.signal,
            }
          )
          if (!shotRes.ok) throw new Error(`chromium screenshot: HTTP ${shotRes.status}`)
          const data = Buffer.from(await shotRes.arrayBuffer()).toString("base64")
          return okResult({ data, format: "png" as const })
        }

        return errResult(
          `browser_screenshot: adapter "${adapterId}" is not supported. ` +
            "Supported adapters: camofox, bureau, chromium."
        )
      } catch (err) {
        return errResult(
          `browser_screenshot: ${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        clearTimeout(timer)
      }
    }
  )

  // ── browser_screencast_* ─────────────────────────────────────────────────────
  // Live view + recording over the agent's OWN tab inside the chrome-live browser
  // (dedicated by default, or the user's own Chrome on an explicit attachIntent ask).
  // CAPABILITY/STATE SPLIT — the same shape the liveInstances fix uses:
  //   • the long-lived frame buffer + CDP mechanics live on the chrome-live
  //     adapter instance (module-level `entries` in live.ts), reached through
  //     the module-scope `liveInstances` map above — so this state SURVIVES the
  //     per-request `mcpServerFactory` runs (the stateless-transport bug class:
  //     per-registration closures would strand every started screencast on the
  //     request that started it),
  //   • while the mp4 encoding below is a pure frames-in → file-out function
  //     (browser-screencast.ts) — nothing live to lose.
  // NOTE: this is the agent tab inside Chrome only (what CDP can see). It is
  // NOT a desktop/screen-capture feature, and it has nothing to do with the
  // separate Bureau (:8830) browser service.

  // Structural shapes matching ChromeLiveInstance's screencast methods — the
  // runtime stays free of a hard dependency on @agentproto/adapter-browser.
  interface ScreencastOptionsLike {
    format?: "jpeg" | "png"
    quality?: number
    everyNthFrame?: number
    maxWidth?: number
    maxHeight?: number
  }
  interface ScreencastFrameLike {
    data: string
    format: "jpeg" | "png"
    timestampMs: number
    index: number
    width?: number
    height?: number
  }

  const screencastInstance = (
    desc: SessionDescriptor
  ): (BrowserInstanceLike &
    {
      screencastStart?: (opts?: ScreencastOptionsLike) => Promise<{ targetId: string; index: number }>
      screencastFrame?: () => Promise<ScreencastFrameLike | null>
      screencastStop?: () => Promise<{ targetId: string | undefined; frameCount: number; total: number; frames: ScreencastFrameLike[] }>
    }) | undefined => {
    if (desc.kind !== "browser" || desc.browserAdapterId !== "chrome-live") return undefined
    return liveInstances.get(desc.id) as BrowserInstanceLike & {
      screencastStart?: (opts?: ScreencastOptionsLike) => Promise<{ targetId: string; index: number }>
      screencastFrame?: () => Promise<ScreencastFrameLike | null>
      screencastStop?: () => Promise<{ targetId: string | undefined; frameCount: number; total: number; frames: ScreencastFrameLike[] }>
    }
  }

  const screencastInstanceUnavailable = (
    toolName: string,
    sessionId: string
  ): ReturnType<typeof errResult> =>
    errResult(
      `${toolName}: chrome-live provider instance is unavailable; start the browser again to reconnect ` +
        `(session "${sessionId}")`
    )

  server.tool(
    "browser_screencast_start",
    "chrome-live only. Start a live screencast of the agent's OWN tab (the dedicated Chrome by default, or the user's own Chrome on an explicit attachIntent ask) " +
      "(CDP Page.startScreencast; never a foreign tab, never the desktop). " +
      "Frames stream to the daemon HTTP surface: open the daemon URL + viewPath " +
      "(`/sessions/<sessionId>/screencast`) in a browser, or expose it remotely with `tunnel_create` " +
      "over the daemon's HTTP port. `browser_screencast_frame` (or the .jpg endpoint) grabs the latest " +
      "frame; `browser_screencast_stop` ends it and optionally encodes the buffered frames to mp4 " +
      "(needs ffmpeg on PATH).",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      format: z.enum(["jpeg", "png"]).optional(),
      quality: z.number().int().min(1).max(100).optional(),
      everyNthFrame: z.number().int().min(1).optional(),
      maxWidth: z.number().int().min(1).optional(),
      maxHeight: z.number().int().min(1).optional(),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_screencast_start: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(
          `browser_screencast_start: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`
        )
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live") {
        return errResult(
          `browser_screencast_start: adapter "${adapterId}" does not support screencast; ` +
            "only the chrome-live adapter does (a dedicated Chrome by default, or the user's running Chrome on an explicit attachIntent ask)."
        )
      }
      const inst = screencastInstance(desc)
      if (!inst?.screencastStart) return screencastInstanceUnavailable("browser_screencast_start", input.sessionId)
      try {
        const started = await inst.screencastStart({
          ...(input.format ? { format: input.format } : {}),
          ...(input.quality !== undefined ? { quality: input.quality } : {}),
          ...(input.everyNthFrame !== undefined ? { everyNthFrame: input.everyNthFrame } : {}),
          ...(input.maxWidth !== undefined ? { maxWidth: input.maxWidth } : {}),
          ...(input.maxHeight !== undefined ? { maxHeight: input.maxHeight } : {}),
        })
        return okResult({
          ok: true,
          sessionId: input.sessionId,
          targetId: started.targetId,
          viewPath: `/sessions/${input.sessionId}/screencast`,
          mjpegPath: `/sessions/${input.sessionId}/screencast.mjpg`,
          latestFramePath: `/sessions/${input.sessionId}/screencast.jpg`,
          tip:
            "Watch live: open <daemon http url>" +
            viewPathSuffix(input.sessionId) +
            " (same-origin HTML viewer, MJPEG). Remote: run `tunnel_create` over the daemon's HTTP port " +
            "and use the same path behind the tunnel's signed URL. Record: call `browser_screencast_stop`.",
        })
      } catch (err) {
        return errResult(
          `browser_screencast_start: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
   )

  server.tool(
    "browser_screencast_frame",
    "chrome-live only. Return the latest buffered screencast frame of the agent's tab as base64, " +
      "plus how many frames arrived since `browser_screencast_start`. `frame: null` means no frame yet.",
    {
      sessionId: z.string().min(1).describe("Browser session id (adapter `chrome-live`)."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_screencast_frame: session "${input.sessionId}" not found.`)
      const adapterId = desc.browserAdapterId ?? ""
      if (desc.kind !== "browser")
        return errResult(
          `browser_screencast_frame: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`
        )
      if (adapterId !== "chrome-live") {
        return errResult(
          `browser_screencast_frame: adapter "${adapterId}" does not support screencast; ` +
            "only the chrome-live adapter does."
        )
      }
      const inst = screencastInstance(desc)
      if (!inst?.screencastFrame) return screencastInstanceUnavailable("browser_screencast_frame", input.sessionId)
      try {
        const frame = await inst.screencastFrame()
        return okResult({ frame })
      } catch (err) {
        return errResult(`browser_screencast_frame: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  server.tool(
    "browser_screencast_stop",
    "chrome-live only. Stop the live screencast started with `browser_screencast_start`. When ffmpeg " +
      "is on PATH and at least 2 frames were captured, the buffered frames are encoded to an mp4 saved " +
      "in the session directory; the tool returns its path. Without ffmpeg, the frames are dropped and " +
      "the response explains why (nothing live is ever left on the instance).",
    {
      sessionId: z.string().min(1).describe("Browser session id (adapter `chrome-live`)."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_screencast_stop: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(
          `browser_screencast_stop: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`
        )
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live") {
        return errResult(
          `browser_screencast_stop: adapter "${adapterId}" does not support screencast; ` +
            "only the chrome-live adapter does."
        )
      }
      const inst = screencastInstance(desc)
      if (!inst?.screencastStop) return screencastInstanceUnavailable("browser_screencast_stop", input.sessionId)
      try {
        const stopped = await inst.screencastStop()
        let filePath: string | undefined
        let encodeNote: string | undefined
        if (stopped.frames.length >= 2) {
          try {
            const outDir = outDirOf(desc)
            await prepareScreencastOutDir(outDir)
            const outPath = join(outDir, `screencast-${Date.now()}.mp4`)
            filePath = await encodeScreencastFramesToMp4(stopped.frames, outPath)
          } catch (err) {
            encodeNote = err instanceof Error ? err.message : String(err)
          }
        } else {
          encodeNote =
            "fewer than 2 frames were captured — nothing to encode (was the screencast started just now?)"
        }
        return okResult({
          ok: true,
          sessionId: input.sessionId,
          frameCount: stopped.frameCount,
          total: stopped.total,
          ...(filePath ? { filePath } : {}),
          ...(encodeNote ? { note: encodeNote } : {}),
        })
      } catch (err) {
        return errResult(`browser_screencast_stop: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )
}

function viewPathSuffix(sessionId: string): string {
  return `/sessions/${sessionId}/screencast`
}

/** Recording output dir: the session's own directory (derived from its events path), tmp as fallback. */
function outDirOf(desc: SessionDescriptor): string {
  return dirname(desc.eventsPath ?? join(tmpdir(), "chrome-live-screencast"))
}
