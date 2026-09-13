/**
 * `web.search` — the first multi-candidate AIP-30 registration in the
 * daemon runtime: ONE abstract tool contract, TWO HTTP driver candidates
 * (Brave Search API, Serper API) resolved by the 6-phase resolver
 * (cost rank + schema narrowing). Brave (free tier, cost 0) wins by
 * default when its key is configured; `freshness` is Brave-only and the
 * resolver's Phase-1 schema-narrowing rejects serper when it is used.
 *
 * Registration is key-gated: with NEITHER provider key present, nothing
 * is registered (no broken tool advertised). Keys are read from the
 * injectable `env` (`BRAVE_SEARCH_API_KEY`, `SERPER_API_KEY`) and passed
 * to the drivers as resolved secrets — the daemon never logs them.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  catchErrors,
  defineTool,
  ToolError,
  type ToolContext,
  type ToolTransformer,
} from "@agentproto/tool"
import type { DriverHandle, ExecuteFn } from "@agentproto/driver"
import {
  defineHttpDriver,
  type HttpParseResult,
} from "@agentproto/driver-http"
import { toMcpTool } from "@agentproto/mcp-server"

// ── Contract (AIP-14 TOOL) ────────────────────────────────────────────────────

export const webSearchInputSchema = z.object({
  query: z.string().min(1).describe("The web search query."),
  count: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(10)
    .describe("Number of results to return (1–20, default 10)."),
  country: z
    .string()
    .length(2)
    .optional()
    .describe("ISO-3166 country code, e.g. 'fr'."),
  language: z
    .string()
    .min(2)
    .optional()
    .describe("Search language, e.g. 'fr'."),
  freshness: z
    .enum(["pd", "pw", "pm", "py"])
    .optional()
    .describe(
      "Brave-only freshness filter: pd=day, pw=week, pm=month, py=year. " +
        "Rejected (input_unsupported:freshness) when only the Serper provider is configured."
    ),
  safesearch: z
    .enum(["off", "moderate", "strict"])
    .optional()
    .describe("Safe-search level."),
})
export type WebSearchInput = z.infer<typeof webSearchInputSchema>

export const webSearchOutputSchema = z.object({
  provider: z.enum(["brave", "serper"]),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string().optional(),
      position: z.number().int(),
    })
  ),
})
export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>
export type WebSearchResult = WebSearchOutput["results"][number]

export const webSearchTool = defineTool<WebSearchInput, WebSearchOutput, ToolContext>({
  id: "web.search",
  description:
    "Web search via Brave Search API or Serper (Google). Returns normalized " +
    "results {provider, results[{title, url, snippet, position}]}. The resolver " +
    "picks the provider: Brave (free tier) by default when its key is " +
    "configured; `freshness` is Brave-only.",
  inputSchema: webSearchInputSchema,
  outputSchema: webSearchOutputSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

// ── Brave Search driver (AIP-30 HTTP provider) ────────────────────────────────

interface BraveWebResult {
  title?: string
  url?: string
  description?: string
}

export function defineBraveSearchHttpDriver(): DriverHandle {
  return defineHttpDriver({
    id: "brave-search-http",
    name: "Brave Search",
    description:
      "Brave Search API (https://api.search.brave.com) — free-tier web search " +
      "serving the web.search contract.",
    version: "0.1.0",
    baseUrl: "https://api.search.brave.com",
    defaultMethod: "GET",
    implements: [
      {
        tool: "web.search",
        version: "*",
        costOverride: { costUnitsPerCall: 0 },
      },
    ],
    buildRequest: ({ input, driverCtx }) => {
      const q = input as WebSearchInput
      const url = new URL("https://api.search.brave.com/res/v1/web/search")
      url.searchParams.set("q", q.query)
      url.searchParams.set("count", String(q.count ?? 10))
      if (q.country) url.searchParams.set("country", q.country)
      if (q.language) url.searchParams.set("search_lang", q.language)
      if (q.freshness) url.searchParams.set("freshness", q.freshness)
      if (q.safesearch) url.searchParams.set("safesearch", q.safesearch)
      return {
        url: url.toString(),
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": driverCtx.secrets.BRAVE_SEARCH_API_KEY ?? "",
        },
      }
    },
    parseResponse: ({ status, body }): HttpParseResult => {
      if (status === 401 || status === 403) {
        return {
          ok: false,
          error: {
            code: "auth_required",
            message: `brave-search-http: Brave Search rejected the API key (HTTP ${status}).`,
          },
        }
      }
      if (status === 429) {
        return {
          ok: false,
          error: { code: "rate_limited", message: "brave-search-http: Brave Search rate limit hit (HTTP 429).", retryable: true },
        }
      }
      if (status >= 400) {
        return {
          ok: false,
          error: { code: "upstream_error", message: `brave-search-http: HTTP ${status}`, retryable: status >= 500 },
        }
      }
      const results =
        (body as { web?: { results?: BraveWebResult[] } }).web?.results ?? []
      return {
        ok: true,
        value: {
          provider: "brave",
          results: results.map((r, i) => ({
            title: r.title ?? "",
            url: r.url as string,
            ...(r.description !== undefined ? { snippet: r.description } : {}),
            position: i + 1,
          })),
        },
      }
    },
  })
}

// ── Serper driver (AIP-30 HTTP provider) ──────────────────────────────────────

interface SerperOrganicResult {
  title?: string
  link?: string
  snippet?: string
}

export function defineSerperHttpDriver(): DriverHandle {
  return defineHttpDriver({
    id: "serper-http",
    name: "Serper (Google)",
    description:
      "Serper API (https://google.serper.dev) — Google web search serving " +
      "the web.search contract. Does not support `freshness`.",
    version: "0.1.0",
    baseUrl: "https://google.serper.dev",
    defaultMethod: "POST",
    implements: [
      {
        tool: "web.search",
        version: "*",
        costOverride: { costUnitsPerCall: 30 },
        schemaNarrowing: { dropInputs: ["freshness"] },
      },
    ],
    buildRequest: ({ input, driverCtx }) => {
      const q = input as WebSearchInput
      const body: Record<string, unknown> = { q: q.query, num: q.count ?? 10 }
      if (q.country) body.gl = q.country
      if (q.language) body.hl = q.language
      if (q.safesearch) body.safesearch = q.safesearch
      return {
        url: "https://google.serper.dev/search",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-KEY": driverCtx.secrets.SERPER_API_KEY ?? "",
        },
        body,
      }
    },
    parseResponse: ({ status, body }): HttpParseResult => {
      if (status === 401 || status === 403) {
        return {
          ok: false,
          error: {
            code: "auth_required",
            message: `serper-http: Serper rejected the API key (HTTP ${status}).`,
          },
        }
      }
      if (status === 429) {
        return {
          ok: false,
          error: { code: "rate_limited", message: "serper-http: Serper rate limit hit (HTTP 429).", retryable: true },
        }
      }
      if (status >= 400) {
        return {
          ok: false,
          error: { code: "upstream_error", message: `serper-http: HTTP ${status}`, retryable: status >= 500 },
        }
      }
      const organic =
        (body as { organic?: SerperOrganicResult[] }).organic ?? []
      return {
        ok: true,
        value: {
          provider: "serper",
          results: organic.map((r, i) => ({
            title: r.title ?? "",
            url: r.link as string,
            ...(r.snippet !== undefined ? { snippet: r.snippet } : {}),
            position: i + 1,
          })),
        },
      }
    },
  })
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * The HTTP runtime's executeFn uses global `fetch` directly; when an
 * injectable fetch is supplied (tests / e2e), wrap each execute body so it
 * runs with that implementation installed as the global for the call's
 * duration, restoring the previous value afterwards.
 */
function withFetchOverride(handle: DriverHandle, fetchImpl: typeof fetch): DriverHandle {
  const execute: Record<string, ExecuteFn> = {}
  for (const [toolId, fn] of Object.entries(handle.execute)) {
    execute[toolId] = async args => {
      const g = globalThis as { fetch?: typeof fetch }
      const prev = g.fetch
      g.fetch = fetchImpl
      try {
        return await fn(args)
      } finally {
        g.fetch = prev as typeof fetch
      }
    }
  }
  return { ...handle, execute }
}

/**
 * Surface the resolver's Phase-1 rejection reasons (e.g.
 * `input_unsupported:freshness`) in the error text — the resolver only
 * reports them in `cause`, which `catchErrors()` would otherwise drop.
 */
function enrichResolverRejections(): ToolTransformer {
  return {
    name: "enrichResolverRejections",
    wrapHandler: handler => async input => {
      try {
        return await handler(input)
      } catch (err) {
        if (err instanceof ToolError && Array.isArray(err.cause)) {
          const reasons = (err.cause as Array<{ providerId: string; reason: string }>)
            .map(r => `${r.providerId}: ${r.reason}`)
            .join(", ")
          throw new ToolError({
            code: err.code,
            message: `${err.message} (${reasons})`,
            cause: err.cause,
          })
        }
        throw err
      }
    },
  }
}

export interface RegisterWebSearchToolsOptions {
  /** Injectable env (tests); default `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Injectable fetch (tests / live e2e); default `globalThis.fetch`. */
  fetch?: typeof fetch
}

/**
 * Register the `web.search` MCP tool (`web_search`) when at least one
 * provider key is configured. With NEITHER key present, nothing is
 * registered — no broken tool is advertised, silently.
 */
export function registerWebSearchTools(
  server: McpServer,
  opts: RegisterWebSearchToolsOptions = {},
): void {
  const env = opts.env ?? process.env
  const secrets: Record<string, string> = {}
  if (env.BRAVE_SEARCH_API_KEY) secrets.BRAVE_SEARCH_API_KEY = env.BRAVE_SEARCH_API_KEY
  if (env.SERPER_API_KEY) secrets.SERPER_API_KEY = env.SERPER_API_KEY

  const candidates: DriverHandle[] = []
  if (secrets.BRAVE_SEARCH_API_KEY) candidates.push(defineBraveSearchHttpDriver())
  if (secrets.SERPER_API_KEY) candidates.push(defineSerperHttpDriver())
  if (candidates.length === 0) return

  const fetchImpl = opts.fetch
  toMcpTool(server, {
    tool: webSearchTool,
    candidates: fetchImpl
      ? candidates.map(c => withFetchOverride(c, fetchImpl))
      : candidates,
    secrets,
    transformers: [catchErrors(), enrichResolverRejections()],
  })
}
