/**
 * MCP tool factories (§4). Two separate factories per OQ-4 — not every
 * family needs a setup tool (browser has none), so bundling them would
 * hurt discoverability.
 *
 * Both return `void` and register directly on the passed `McpServer`,
 * mirroring `registerBrowserTools` in the runtime package.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { AdapterLister } from "./types.js"

export interface MakeListToolOpts<TInfo> {
  server: McpServer
  /** e.g. "list_adapters", "list_adapter_browsers". */
  toolName: string
  description: string
  lister: AdapterLister<TInfo>
}

/**
 * Register a parameterless MCP tool that returns the family's adapter list
 * as a JSON array of `AdapterEntry<TInfo>` — status included, creds never.
 */
export function makeListTool<TInfo>(opts: MakeListToolOpts<TInfo>): void {
  const { server, toolName, description, lister } = opts
  server.tool(toolName, description, {}, async () => {
    try {
      const entries = await lister()
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(entries, null, 2) },
        ],
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `${toolName} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
        isError: true,
      }
    }
  })
}

export interface MakeSetupToolOpts<TCreds> {
  server: McpServer
  /** e.g. "setup_tunnel_provider", "setup_agent_cli". */
  toolName: string
  description: string
  /** Slugs for which setup is accepted (drawn from the catalog). */
  validSlugs: readonly string[]
  /**
   * Called after slug validation. Implementation owns interpreting `value`
   * (API token, path, JSON blob, …) and writing creds + ledger. The kit
   * never inspects or echoes `value`.
   */
  onSetup: (slug: string, creds: TCreds) => Promise<{ ok: boolean; hint?: string }>
}

/**
 * Register an MCP setup tool. The `value` parameter is flagged sensitive
 * (Appendix B.2): its description marks it, and the tool result NEVER echoes
 * the value back — only `{ ok, slug, hint? }`.
 *
 * `TCreds` is the shape `onSetup` expects; the wire schema always passes a
 * single `value: string`, which `onSetup` is free to parse into `TCreds`.
 */
export function makeSetupTool<TCreds = string>(
  opts: MakeSetupToolOpts<TCreds>
): void {
  const { server, toolName, description, validSlugs, onSetup } = opts
  const valid = new Set(validSlugs)

  server.tool(
    toolName,
    description,
    {
      slug: z.string().describe("Adapter slug to configure"),
      value: z
        .string()
        .describe(
          "Credential value (API key, token, …). SENSITIVE — never logged " +
            "and never echoed back in tool results."
        ),
    },
    async (args: { slug: string; value: string }) => {
      const { slug, value } = args
      if (!valid.has(slug)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${toolName}: unknown slug '${slug}'. Valid: ${[
                ...valid,
              ].join(", ")}`,
            },
          ],
          isError: true,
        }
      }
      // `value` is forwarded verbatim to onSetup as TCreds and is NEVER
      // placed in the response below.
      const result = await onSetup(slug, value as unknown as TCreds)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { ok: result.ok, slug, ...(result.hint ? { hint: result.hint } : {}) },
              null,
              2
            ),
          },
        ],
        isError: !result.ok,
      }
    }
  )
}
