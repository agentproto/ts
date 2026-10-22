/**
 * MCP tools that expose browser service adapters (Camofox, Bureau, …) to
 * agents connected to the daemon. Lets a remote operator start, stop, and
 * inspect browser service sessions through the same MCP connection it uses
 * for fs/exec/agent-cli.
 *
 * Seventeen tools:
 *   browser_adapter_list    discover available browser adapter ids + metadata
 *   start_browser           ensure a browser adapter is up, register as a session
 *   stop_browser            kill a running browser session
 *   list_browsers           browse alive/recent browser sessions
 *   browser_status          descriptor + live health probe for one session
 *   browser_screenshot      capture what an agent's browser session is showing
 *   fetch_page              plain HTTP read (no browser) → { title, text, url, blocked }
 *   browser_navigate        chrome-live only: open/reuse an owned tab at a URL
 *   browser_extract_text    chrome-live only: purify an owned tab's DOM → { title, text, url }
 *   browser_get_dom         chrome-live only: raw serialized DOM of an owned tab
 *   browser_click           chrome-live only: click a CSS selector on an owned tab
 *   browser_fill            chrome-live only: fill a CSS selector on an owned tab
 *   browser_evaluate        chrome-live only: run JS in an owned tab, return the value
 *   browser_scroll          chrome-live only: scroll an owned tab (selector into view, or x/y)
 *   browser_press_key       chrome-live only: press Enter/Tab/arrows/… on an owned tab
 *   browser_select          chrome-live only: choose an option in a <select> on an owned tab
 *   browser_wait_for        chrome-live only: wait for an element to be visible/enabled, or for text
 *   browser_screencast_*    chrome-live only: live view + mp4 recording of an owned tab (start/frame/stop)
 *
 * ONE model for chrome-live: every one of these addresses the agent's OWN
 * tab (opened by `browser_navigate`, never a foreign one) — there is no
 * second, instance-wide control surface for chrome-live. (The generic,
 * unused `projectBrowserTools` in `browser-projection.ts` is a DIFFERENT
 * model — one whole attached instance, no per-agent tab ownership — and its
 * tool names are deliberately prefixed `browser_kit_*` so the two can never
 * collide if both ever get mounted on the same server.)
 *
 * Auth: same as every other daemon tool — gated by the gateway's auth source.
 *
 * Injection pattern: `resolveBrowserAdapter` is passed in, not imported.
 * This keeps the runtime package free of a hard dep on @agentproto/adapter-browser.
 * The types below are minimal structural shapes — equivalent to `AgentSessionLike`
 * in sessions.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { homedir } from "node:os"
import { tmpdir } from "node:os"
import { realpath } from "node:fs/promises"
import { z } from "zod"
import type { AdapterLister } from "@agentproto/provider-kit"
import { registerBuiltinTool } from "@agentproto/mcp-server"
import { catchErrors, paginated } from "@agentproto/tool"
import type { SessionsRegistry, SessionDescriptor } from "./sessions.js"
import { defaultBrowserAdapterIds } from "./browser-adapters.js"
import { encodeScreencastFramesToMp4, prepareScreencastOutDir } from "./browser-screencast.js"
import { extractPageText, looksBlocked } from "./page-text.js"
import {
  notifyBrowserAttach,
  notifyBrowserDetach,
  withBrowserObservers,
  type BrowserCaptureHandle,
} from "./browser-observers.js"

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
  navigate?(url: string, tabId?: string): Promise<{ targetId: string; url: string }>
  getDom?(tabId?: string): Promise<{ targetId: string; url: string; html: string }>
  click?(
    options: { selector: string; button?: "left" | "middle" | "right"; clickCount?: number },
    tabId?: string
  ): Promise<void>
  fill?(options: { selector: string; value: string; clear?: boolean }, tabId?: string): Promise<void>
  evaluate?<T = unknown>(
    options: { expression: string; awaitPromise?: boolean; returnByValue?: boolean; maxResultBytes?: number },
    tabId?: string
  ): Promise<{ value: T | undefined; truncated: boolean }>
  scroll?(options: { selector?: string; x?: number; y?: number }, tabId?: string): Promise<{ targetId: string }>
  /** Press one key via trusted CDP input, optionally focusing a selector first (chrome-live). */
  pressKey?(
    options: { key: string; selector?: string; count?: number; modifiers?: readonly ("Alt" | "Control" | "Meta" | "Shift")[] },
    tabId?: string
  ): Promise<{ targetId: string; key: string }>
  /** Select a `<select>` option by value, label or index (chrome-live). */
  selectOption?(
    options: { selector: string; value?: string; label?: string; index?: number },
    tabId?: string
  ): Promise<{ targetId: string; value: string; label: string; index: number }>
  /** Wait for an element to be attached/visible/enabled, or for text (chrome-live). */
  waitFor?(
    options: { selector?: string; state?: "attached" | "visible" | "enabled" | "text"; text?: string; timeoutMs?: number; pollMs?: number },
    tabId?: string
  ): Promise<{ targetId: string; state: "attached" | "visible" | "enabled" | "text"; matched: true; elapsedMs: number }>
  /** Attach local files to one `<input type=file>` on an owned tab (CDP DOM.setFileInputFiles; paths absolute). */
  uploadFileOntoFileInput?(
    options: { selector: string; paths: readonly string[] },
    tabId?: string
  ): Promise<{ targetId: string; files: readonly string[] }>
  /** Open a FRESH tab (never reusing an existing one) and navigate it to `url`. */
  openNewTab?(url?: string): Promise<{ targetId: string; url: string }>
  /** Tabs owned by this provider instance on its endpoint. */
  listOwnedTabs?(): Promise<{ targetId: string; url: string; windowId?: number }[]>
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
    /** chrome-live only: the real Chrome profile directory a configured cookie source should trace injected cookies back to. Every other adapter ignores this. */
    chromeProfile?: string
    /** chrome-live only: narrows which domains' cookies a configured cookie source injects. Every other adapter ignores this. */
    domains?: readonly string[]
  }): Promise<BrowserInstanceLike>
}

/**
 * Bounded window `start_browser` waits for a freshly-spawned service to become
 * healthy before returning `starting`. Heavy services (chromium, bureau) take
 * >60s to boot (pnpm + Chrome launch) and would otherwise time out the MCP
 * request; we return promptly and let health converge in the background.
 */
const START_BROWSER_INITIAL_WAIT_MS = 6_000

/** Env var listing directories `browser_upload_file` may read files from, separated by `:`. */
export const BROWSER_UPLOAD_ALLOW_DIRS_ENV = "AGENTPROTO_BROWSER_UPLOAD_ALLOW_DIRS"

/**
 * The baseline upload allowlist: the agent's shared data dir (`~/.pygmalion/data`,
 * where session artifacts land) plus any extra dir named in the env var. Each
 * entry collapsed to an absolute path.
 */
export function defaultBrowserUploadAllowDirs(): string[] {
  const env = (process.env[BROWSER_UPLOAD_ALLOW_DIRS_ENV] ?? "")
    .split(":")
    .map((d) => d.trim())
    .filter(Boolean)
  return [resolve(join(homedir(), ".pygmalion", "data")), ...env.map((p) => resolve(p))]
}

/**
 * Validate + canonicalize `browser_upload_file` paths: every path must be
 * absolute, must exist (readable, via realpath so symlinks are collapsed —
 * the check is on the REAL target), and must live inside one of `allowDirs`.
 * Read-only: nothing is ever written; CDP only points the file input at these.
 */
async function checkUploadPaths(
  paths: readonly string[],
  allowDirs: readonly string[]
): Promise<string[]> {
  const dirs = await Promise.all(
    allowDirs.map(async (d) => {
      // Canonicalize like the candidate paths (`realpath` collapses symlinks, e.g.
      // a symlinked workspace or data dir); fall back to `resolve` when the dir
      // does not exist yet — a non-existent allowDir just never matches.
      try {
        return await realpath(d)
      } catch {
        return resolve(d)
      }
    })
  )
  const allowed = (real: string): boolean =>
    dirs.some((dir) => {
      const realWithSep = real.endsWith(sep) ? real : real + sep
      const dirWithSep = dir.endsWith(sep) ? dir : dir + sep
      return real === dir || realWithSep.startsWith(dirWithSep)
    })
  const out: string[] = []
  for (const p of paths) {
    if (!isAbsolute(p)) {
      throw new Error(`browser_upload_file: path "${p}" is not absolute (give an absolute path on this machine)`)
    }
    let real: string
    try {
      real = await realpath(p)
    } catch (err) {
      throw new Error(
        `browser_upload_file: cannot read "${p}": ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (!allowed(real)) {
      throw new Error(
        `browser_upload_file: "${p}" is outside the upload allowlist ` +
          `(${dirs.join(", ") || "empty"} — extend it with ${BROWSER_UPLOAD_ALLOW_DIRS_ENV})`
      )
    }
    out.push(real)
  }
  return out
}

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

function browserCaptureHandle(instance: BrowserInstanceLike): BrowserCaptureHandle {
  return {
    screenshot: tabId => instance.screenshot!(tabId),
    evaluate: async (expression, tabId) =>
      (await instance.evaluate!({ expression, returnByValue: true }, tabId)).value,
  }
}

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
  /** Extra directories `browser_upload_file` may read files from (absolute).
   *  Merged over the defaults (see `defaultBrowserUploadAllowDirs`). */
  uploadAllowDirs?: readonly string[]
  log?: (msg: string) => void
}

export function registerBrowserTools(
  rawServer: McpServer,
  opts: RegisterBrowserToolsOptions
): void {
  const server = withBrowserObservers(rawServer)
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
      chromeProfile: z
        .string()
        .optional()
        .describe(
          "chrome-live only; every other adapter ignores this. The real Chrome profile directory " +
            "(e.g. 'Default', 'Profile 1') a configured cookie source should trace injected cookies " +
            "back to. Has no effect unless the running daemon configured chrome-live with a cookie source."
        ),
      domains: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "chrome-live only; every other adapter ignores this. Narrows which domains' cookies a " +
            "configured cookie source injects into the dedicated Chrome — never a widening beyond " +
            "what the source already grants. Has no effect unless a cookie source is configured."
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
          chromeProfile: input.chromeProfile,
          domains: input.domains,
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
            const sid = pendingId.current
            if (sid) liveInstances.delete(sid)
            await stopInstance()
            if (sid) await notifyBrowserDetach({ sessionId: sid, reason: "stop" })
          },
          label: input.label,
        })
        pendingId.current = desc.id
        setLiveBrowserInstance(desc.id, instance)
        await notifyBrowserAttach({
          sessionId: desc.id,
          provider: desc.browserAdapterId ?? instance.id,
          instanceId: instance.id,
          ...(instance.screenshot && instance.evaluate
            ? { capture: browserCaptureHandle(instance) }
            : {}),
        })
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

  // ── fetch_page ───────────────────────────────────────────────────────────────
  server.tool(
    "fetch_page",
    "Read a URL over plain HTTP — no browser, instant. Returns clean text: " +
      "{ title, text (markdown, boilerplate stripped), url (after redirects), blocked }. " +
      "`blocked: true` means the response looks anti-bot-gated (403/429/503, or a " +
      "known challenge page from Cloudflare/Akamai/PerimeterX/Datadome/Incapsula) — " +
      "`text` is omitted in that case; escalate to `start_browser` + `browser_navigate` " +
      "+ `browser_extract_text` (or `browser_click`/`browser_fill`/`browser_scroll` if the " +
      "page needs interaction first) instead of retrying the same fetch. Try this FIRST for " +
      "any public page — instant, no browser — and only reach for the browser tools when " +
      "`blocked: true` or the content needs JS/interaction to appear.",
    {
      url: z.string().min(1).describe("URL to fetch."),
      timeoutMs: z.number().int().positive().max(60_000).optional().describe("Default 15000."),
    },
    async input => {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), input.timeoutMs ?? 15_000)
      try {
        const res = await fetch(input.url, { signal: ac.signal, redirect: "follow" })
        const html = await res.text()
        if (looksBlocked(res.status, html)) {
          return okResult({ url: res.url, blocked: true, status: res.status })
        }
        if (!res.ok) return errResult(`fetch_page: HTTP ${res.status} fetching ${input.url}`)
        const { title, text } = await extractPageText(html, res.url)
        return okResult({ title, text, url: res.url, blocked: false })
      } catch (err) {
        return errResult(`fetch_page: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        clearTimeout(timer)
      }
    }
  )

  // ── browser_navigate ─────────────────────────────────────────────────────────
  server.tool(
    "browser_navigate",
    "chrome-live only. Navigate to `url` on an agent-OWNED tab — reuses the " +
      "existing owned tab (any one, or the one named by `tabId`) if there is " +
      "one, else opens a fresh one. Never addresses a tab the agent did not " +
      "open. Returns { targetId, url } (the url after redirects, best-effort). Follow with " +
      "`browser_extract_text`/`browser_get_dom` to read the page, " +
      "`browser_click`/`browser_fill`/`browser_scroll` to interact, or " +
      "`browser_screenshot` to see it.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      url: z.string().min(1).describe("URL to navigate to."),
      tabId: z
        .string()
        .optional()
        .describe("Provider-owned target id to navigate (default: any existing owned tab, else a new one)."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_navigate: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_navigate: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_navigate: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.navigate)
        return errResult("browser_navigate: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        return okResult(await liveInstance.navigate(input.url, input.tabId))
      } catch (err) {
        return errResult(`browser_navigate: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_extract_text ─────────────────────────────────────────────────────
  server.tool(
    "browser_extract_text",
    "chrome-live only. Read the agent-OWNED tab's current page as clean text: " +
      "strips boilerplate (nav/ads/scripts) and returns { title, text (markdown), url }. " +
      "Call `browser_navigate` first — this never opens a tab itself, same " +
      "ownership rule as `browser_screenshot`. Prefer this over `browser_get_dom` unless " +
      "you specifically need raw HTML (e.g. to find a CSS selector for `browser_click`/`browser_fill`).",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      tabId: z
        .string()
        .optional()
        .describe("Provider-owned target id to read (default: the first active agent tab)."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_extract_text: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_extract_text: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_extract_text: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.getDom)
        return errResult("browser_extract_text: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        const { url, html } = await liveInstance.getDom(input.tabId)
        const { title, text } = await extractPageText(html, url)
        return okResult({ title, text, url })
      } catch (err) {
        return errResult(`browser_extract_text: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_get_dom ───────────────────────────────────────────────────────────
  server.tool(
    "browser_get_dom",
    "chrome-live only. Read the agent-OWNED tab's current page as RAW serialized DOM " +
      "(outerHTML) — returns { targetId, url, html }. Use `browser_extract_text` instead " +
      "for reading content; reach for this when you need exact markup (e.g. to find a " +
      "CSS selector for `browser_click`/`browser_fill`). Same ownership rule as " +
      "`browser_screenshot` — call `browser_navigate` first.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      tabId: z
        .string()
        .optional()
        .describe("Provider-owned target id to read (default: the first active agent tab)."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_get_dom: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_get_dom: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_get_dom: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.getDom)
        return errResult("browser_get_dom: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        return okResult(await liveInstance.getDom(input.tabId))
      } catch (err) {
        return errResult(`browser_get_dom: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_click ──────────────────────────────────────────────────────────────
  server.tool(
    "browser_click",
    "chrome-live only. Click a CSS selector on the agent-OWNED tab — dispatches trusted " +
      "CDP mouse events at the element's center, scrolling it into view first. Same " +
      "ownership rule as `browser_screenshot` — call `browser_navigate` first. Find a " +
      "selector with `browser_get_dom` if you don't already know one.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      tabId: z.string().optional().describe("Provider-owned target id (default: the first active agent tab)."),
      selector: z.string().min(1).describe("CSS selector of the element to click."),
      button: z.enum(["left", "middle", "right"]).optional().describe("Default left."),
      clickCount: z.number().int().min(1).max(3).optional().describe("Default 1 (2 for a double-click)."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_click: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_click: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_click: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.click)
        return errResult("browser_click: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        await liveInstance.click(
          { selector: input.selector, ...(input.button ? { button: input.button } : {}), ...(input.clickCount ? { clickCount: input.clickCount } : {}) },
          input.tabId
        )
        return okResult({ ok: true, selector: input.selector })
      } catch (err) {
        return errResult(`browser_click: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_fill ───────────────────────────────────────────────────────────────
  server.tool(
    "browser_fill",
    "chrome-live only. Fill a CSS selector on the agent-OWNED tab — focuses the element " +
      "and types `value` via trusted CDP input (clearing the existing value first by " +
      "default). Same ownership rule as `browser_screenshot` — call `browser_navigate` first.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      tabId: z.string().optional().describe("Provider-owned target id (default: the first active agent tab)."),
      selector: z.string().min(1).describe("CSS selector of the input/textarea element."),
      value: z.string().describe("Text to type."),
      clear: z.boolean().optional().describe("Clear the existing value first. Default true."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_fill: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_fill: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_fill: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.fill)
        return errResult("browser_fill: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        await liveInstance.fill(
          { selector: input.selector, value: input.value, ...(input.clear !== undefined ? { clear: input.clear } : {}) },
          input.tabId
        )
        return okResult({ ok: true, selector: input.selector })
      } catch (err) {
        return errResult(`browser_fill: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_evaluate ───────────────────────────────────────────────────────────
  server.tool(
    "browser_evaluate",
    "chrome-live only. Run a JavaScript expression on the agent-OWNED tab and return its " +
      "value (JSON-serialized; `truncated: true` if it exceeded `maxResultBytes`). Same " +
      "ownership rule as `browser_screenshot` — call `browser_navigate` first.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      tabId: z.string().optional().describe("Provider-owned target id (default: the first active agent tab)."),
      expression: z.string().min(1).describe("JavaScript expression to evaluate."),
      awaitPromise: z.boolean().optional().describe("Await the expression if it returns a promise. Default true."),
      returnByValue: z.boolean().optional().describe("Serialize the result by value. Default true."),
      maxResultBytes: z.number().int().positive().optional().describe("Cap on the serialized result size. Default 64000."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_evaluate: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_evaluate: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_evaluate: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.evaluate)
        return errResult("browser_evaluate: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        return okResult(
          await liveInstance.evaluate({
            expression: input.expression,
            ...(input.awaitPromise !== undefined ? { awaitPromise: input.awaitPromise } : {}),
            ...(input.returnByValue !== undefined ? { returnByValue: input.returnByValue } : {}),
            ...(input.maxResultBytes !== undefined ? { maxResultBytes: input.maxResultBytes } : {}),
          }, input.tabId)
        )
      } catch (err) {
        return errResult(`browser_evaluate: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_scroll ─────────────────────────────────────────────────────────────
  server.tool(
    "browser_scroll",
    "chrome-live only. Scroll the agent-OWNED tab — pass `selector` to scroll that element " +
      "into view (centered), or `x`/`y` to scroll the window to an absolute position. Same " +
      "ownership rule as `browser_screenshot` — call `browser_navigate` first.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      tabId: z.string().optional().describe("Provider-owned target id (default: the first active agent tab)."),
      selector: z.string().optional().describe("CSS selector to scroll into view. Takes precedence over x/y."),
      x: z.number().optional().describe("Absolute horizontal scroll position in CSS px. Default 0. Ignored if `selector` is set."),
      y: z.number().optional().describe("Absolute vertical scroll position in CSS px. Default 0. Ignored if `selector` is set."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_scroll: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_scroll: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_scroll: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.scroll)
        return errResult("browser_scroll: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        return okResult(
          await liveInstance.scroll(
            {
              ...(input.selector !== undefined ? { selector: input.selector } : {}),
              ...(input.x !== undefined ? { x: input.x } : {}),
              ...(input.y !== undefined ? { y: input.y } : {}),
            },
            input.tabId
          )
        )
      } catch (err) {
        return errResult(`browser_scroll: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_press_key ──────────────────────────────────────────────────────────
  server.tool(
    "browser_press_key",
    "chrome-live only. Press one key on the agent-OWNED tab via trusted CDP input — " +
      "Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, " +
      "PageUp/PageDown, Space, or a single printable character. Optionally focus a " +
      "`selector` first, repeat with `count`, and hold `modifiers`. Same ownership " +
      "rule as `browser_screenshot` — call `browser_navigate` first.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      tabId: z.string().optional().describe("Provider-owned target id (default: the first active agent tab)."),
      key: z.string().min(1).describe("Key name (Enter, Tab, Escape, ArrowDown, …) or one printable character."),
      selector: z.string().optional().describe("CSS selector to focus before pressing. Default: whatever has focus."),
      count: z.number().int().min(1).max(100).optional().describe("How many times to press. Default 1."),
      modifiers: z
        .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
        .optional()
        .describe("Modifier keys held for this press."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_press_key: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_press_key: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_press_key: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.pressKey)
        return errResult("browser_press_key: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        return okResult(
          await liveInstance.pressKey(
            {
              key: input.key,
              ...(input.selector !== undefined ? { selector: input.selector } : {}),
              ...(input.count !== undefined ? { count: input.count } : {}),
              ...(input.modifiers !== undefined ? { modifiers: input.modifiers } : {}),
            },
            input.tabId
          )
        )
      } catch (err) {
        return errResult(`browser_press_key: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_select ─────────────────────────────────────────────────────────────
  server.tool(
    "browser_select",
    "chrome-live only. Choose an option in a `<select>` on the agent-OWNED tab by " +
      "`value`, visible `label`, or zero-based `index` (exactly one). Sets the value " +
      "and dispatches input/change so framework-bound forms update. Same ownership " +
      "rule as `browser_screenshot` — call `browser_navigate` first.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      tabId: z.string().optional().describe("Provider-owned target id (default: the first active agent tab)."),
      selector: z.string().min(1).describe("CSS selector of the `<select>` element."),
      value: z.string().optional().describe("Option value to select."),
      label: z.string().optional().describe("Option visible label/text to select."),
      index: z.number().int().min(0).optional().describe("Zero-based option index to select."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_select: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_select: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_select: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const given = [input.value !== undefined, input.label !== undefined, input.index !== undefined].filter(Boolean).length
      if (given !== 1) return errResult("browser_select: pass exactly one of value, label or index.")
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.selectOption)
        return errResult("browser_select: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        return okResult(
          await liveInstance.selectOption(
            {
              selector: input.selector,
              ...(input.value !== undefined ? { value: input.value } : {}),
              ...(input.label !== undefined ? { label: input.label } : {}),
              ...(input.index !== undefined ? { index: input.index } : {}),
            },
            input.tabId
          )
        )
      } catch (err) {
        return errResult(`browser_select: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_wait_for ───────────────────────────────────────────────────────────
  server.tool(
    "browser_wait_for",
    "chrome-live only. Wait on the agent-OWNED tab until an element is attached, " +
      "visible or enabled, or until text appears (element text when `selector` is set, " +
      "otherwise page text). Polls and returns { targetId, state, matched, elapsedMs }; " +
      "times out with a clear error. Same ownership rule as `browser_screenshot` — " +
      "call `browser_navigate` first.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      tabId: z.string().optional().describe("Provider-owned target id (default: the first active agent tab)."),
      selector: z.string().optional().describe("CSS selector to wait for. Required unless state is 'text'."),
      state: z
        .enum(["attached", "visible", "enabled", "text"])
        .optional()
        .describe("Condition to wait for. Default 'visible' (or 'text' when `text` is given)."),
      text: z.string().optional().describe("Text that must be present. Required for state 'text'."),
      timeoutMs: z.number().int().min(0).optional().describe("Give up after this many ms. Default 10000."),
      pollMs: z.number().int().min(1).optional().describe("Poll interval in ms. Default 100."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_wait_for: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_wait_for: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_wait_for: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.waitFor)
        return errResult("browser_wait_for: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        return okResult(
          await liveInstance.waitFor(
            {
              ...(input.selector !== undefined ? { selector: input.selector } : {}),
              ...(input.state !== undefined ? { state: input.state } : {}),
              ...(input.text !== undefined ? { text: input.text } : {}),
              ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
              ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
            },
            input.tabId
          )
        )
      } catch (err) {
        return errResult(`browser_wait_for: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_upload_file ─────────────────────────────────────────────────────
  server.tool(
    "browser_upload_file",
    "chrome-live only. Attach local files to one `<input type=file>` on the agent-OWNED tab " +
      "(CDP DOM.setFileInputFiles; the same mechanism devtools uses — never a write into them). " +
      "Every path must be ABSOLUTE, exist, and live inside an upload-allowlisted directory " +
      "(default: the agent's workspace and `~/.pygmalion/data`; extend with " +
      "AGENTPROTO_BROWSER_UPLOAD_ALLOW_DIRS, `:`-separated absolute dirs) — anything else is refused. Find the " +
      "selector with `browser_get_dom`. Same ownership rule as `browser_screenshot` — call `browser_navigate` first.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      tabId: z.string().optional().describe("Provider-owned target id (default: the first active agent tab)."),
      selector: z.string().min(1).describe("CSS selector of the `<input type=file>` element."),
      paths: z
        .array(z.string().min(1))
        .min(1)
        .describe("ABSOLUTE local paths (on this machine) of the files to attach, in order."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_upload_file: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_upload_file: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_upload_file: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.uploadFileOntoFileInput)
        return errResult("browser_upload_file: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        const files = await checkUploadPaths(input.paths, [
          ...new Set([...defaultBrowserUploadAllowDirs(), ...(opts.uploadAllowDirs ?? [])]),
        ])
        return okResult(await liveInstance.uploadFileOntoFileInput({ selector: input.selector, paths: files }, input.tabId))
      } catch (err) {
        return errResult(`browser_upload_file: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_new_tab ─────────────────────────────────────────────────────────
  server.tool(
    "browser_new_tab",
    "chrome-live only. Open a FRESH tab — always a new one, in the agent's own window " +
      "(never reusing an existing owned tab, never the user's other windows) — and navigate " +
      "it to `url`. Returns { targetId, url }; pass that `tabId` to the other browser tools " +
      "to work on it, or `browser_list_tabs` to see them all.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
      url: z.string().optional().describe("URL to open the new tab at (default about:blank)."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_new_tab: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_new_tab: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_new_tab: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.openNewTab)
        return errResult("browser_new_tab: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        return okResult(await liveInstance.openNewTab(input.url))
      } catch (err) {
        return errResult(`browser_new_tab: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  // ── browser_list_tabs ───────────────────────────────────────────────────────
  server.tool(
    "browser_list_tabs",
    "chrome-live only. List the tabs the agent itself opened (" +
      "{ targetId, url, windowId }[] — never the user's own tabs): the ids every other " +
      "browser tool accepts as `tabId`.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Browser session id returned by `start_browser` (adapter `chrome-live`)."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) return errResult(`browser_list_tabs: session "${input.sessionId}" not found.`)
      if (desc.kind !== "browser")
        return errResult(`browser_list_tabs: session "${input.sessionId}" is not a browser session (kind=${desc.kind}).`)
      const adapterId = desc.browserAdapterId ?? ""
      if (adapterId !== "chrome-live")
        return errResult(`browser_list_tabs: adapter "${adapterId}" is not supported; only chrome-live does.`)
      const liveInstance = liveInstances.get(desc.id)
      if (!liveInstance?.listOwnedTabs)
        return errResult("browser_list_tabs: chrome-live provider instance is unavailable; start the browser again to reconnect")
      try {
        return okResult({ tabs: await liveInstance.listOwnedTabs() })
      } catch (err) {
        return errResult(`browser_list_tabs: ${err instanceof Error ? err.message : String(err)}`)
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
