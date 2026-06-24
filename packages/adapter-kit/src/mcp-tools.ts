/**
 * MCP tool factories (§4). Two separate factories per OQ-4 — not every
 * family needs a setup tool (browser has none), so bundling them would
 * hurt discoverability.
 *
 * Both return `void` and register directly on the passed `McpServer`,
 * mirroring `registerBrowserTools` in the runtime package.
 *
 * `makeSetupTool` has two forms:
 *   1. Single-value (backward compat) — a single `value` string param.
 *      The `TCreds` generic lets `onSetup` receive any type (the tool
 *      always sends a string; casting is the caller's responsibility).
 *   2. Multi-field — when `fields` is provided, the tool accepts one
 *      zod-string param per declared field. `onSetup` receives a
 *      `Record<string, string>` keyed by field name.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { AdapterLister } from "./types.js"

// ── list tool ────────────────────────────────────────────────────────────

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

// ── setup tool ───────────────────────────────────────────────────────────

/** Declared field for the multi-field `makeSetupTool` variant. */
export interface SetupField {
  /** Field name — becomes the zod-param name (kebab-case ok). */
  name: string
  /** Human-readable description shown to the client. */
  description: string
  /** When true (or absent), the client MUST provide a non-empty value. */
  required?: boolean
  /**
   * When true, the value is marked SENSITIVE in its `.describe()`
   * annotation and the tool result NEVER echoes it (same guarantee
   * as the single-`value` param). Default false.
   */
  sensitive?: boolean
}

export interface MakeSetupToolOpts<TCreds> {
  server: McpServer
  /** e.g. "setup_tunnel_provider", "setup_agent_cli". */
  toolName: string
  description: string
  /** Slugs for which setup is accepted (drawn from the catalog). */
  validSlugs: readonly string[]
  /**
   * Multi-field declarations. When provided, the generated tool accepts
   * one zod-string param per field and `onSetup` receives a
   * `Record<string, string>` instead of a single `value`. Sensitive
   * fields are marked in their `.describe()` and values are NEVER
   * echoed in tool results.
   *
   * When absent (or empty), the tool uses the single-`value` form
   * (backward-compatible with existing families).
   */
  fields?: readonly SetupField[]
  /**
   * Called after slug validation. For the single-value form, receives
   * the `value` string as `TCreds`. For the multi-field form (when
   * `fields` is provided), receives a `Record<string, string>` keyed
   * by field name.
   */
  onSetup: (slug: string, creds: TCreds) => Promise<{ ok: boolean; hint?: string }>
}

/**
 * Overload: multi-field form. When `fields` is provided, `onSetup`
 * receives a `Record<string, string>` and each field becomes its own
 * zod-param on the MCP tool.
 */
export function makeSetupTool(
  opts: Omit<MakeSetupToolOpts<Record<string, string>>, "fields"> & {
    fields: readonly SetupField[]
  }
): void

/**
 * Overload: single-value form (backward compat). When `fields` is
 * absent or empty, the tool exposes a single `value` param and
 * `onSetup` receives `TCreds` (defaults to `string`).
 */
export function makeSetupTool<TCreds = string>(
  opts: MakeSetupToolOpts<TCreds>
): void

// ── implementation ───────────────────────────────────────────────────────

export function makeSetupTool<TCreds = string>(
  opts: MakeSetupToolOpts<TCreds> & { fields?: readonly SetupField[] }
): void {
  const { server, toolName, description, validSlugs, onSetup, fields } = opts
  const valid = new Set(validSlugs)

  // ── multi-field path ──────────────────────────────────────────────

  if (fields && fields.length > 0) {
    const shape: Record<string, z.ZodString> = {
      slug: z.string().describe("Adapter slug to configure"),
    }
    const sensitiveNames = new Set<string>()

    for (const f of fields) {
      let desc = f.description
      if (f.sensitive) {
        sensitiveNames.add(f.name)
        desc = `${desc} SENSITIVE — never logged and never echoed back in tool results.`
      }
      shape[f.name] = (f.required !== false
        ? z.string().min(1, `${f.name} is required`)
        : z.string()
      ).describe(desc)
    }

    server.tool(
      toolName,
      description,
      shape,
      async (args: Record<string, string>) => {
        const slug = args.slug ?? ""
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

        // Collect field values into a record — NEVER echo any field value.
        const fieldValues: Record<string, string> = {}
        for (const f of fields) {
          fieldValues[f.name] = args[f.name] ?? ""
        }

        const setupFn = onSetup as (
          slug: string,
          fields: Record<string, string>,
        ) => Promise<{ ok: boolean; hint?: string }>

        const result = await setupFn(slug, fieldValues)
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: result.ok,
                  slug,
                  ...(result.hint ? { hint: result.hint } : {}),
                },
                null,
                2,
              ),
            },
          ],
          isError: !result.ok,
        }
      },
    )
    return
  }

  // ── single-value path (backward compat) ────────────────────────────

  server.tool(
    toolName,
    description,
    {
      slug: z.string().describe("Adapter slug to configure"),
      value: z
        .string()
        .describe(
          "Credential value (API key, token, …). SENSITIVE — never logged " +
            "and never echoed back in tool results.",
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
      const result = await onSetup(
        slug,
        value as unknown as TCreds,
      )
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: result.ok,
                slug,
                ...(result.hint ? { hint: result.hint } : {}),
              },
              null,
              2,
            ),
          },
        ],
        isError: !result.ok,
      }
    },
  )
}
