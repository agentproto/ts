/**
 * AIP-30 DRIVER.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest`: the .md provides
 * metadata + dispatch declarations (`implements[]`, `install`, `auth`,
 * `network`, …); the TS module supplies the execute bodies. Both inputs
 * end up in `defineDriver` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, error prefix) run uniformly.
 *
 * The frontmatter schema below covers the AIP-30 §"Frontmatter" block
 * loosely — only the universally-required fields are strictly typed
 * (id, name, description, version, kind, implements). Subtype-specific
 * extras (CLI argv, HTTP endpoints, MCP tool names) live under
 * `metadata` or `implements[].metadata` with `unknown`-typed values
 * and are validated by the kind-specific runtime packages, not here.
 */

import matter from "gray-matter"
import { z } from "zod"
import { defineDriver } from "../define-provider.js"
import type { ToolImplementation } from "../implement-tool.js"
import type {
  DriverDefinition,
  DriverHandle,
  ExecuteFn,
} from "../types.js"

const DRIVER_KIND = z.enum(["cli", "http", "mcp", "sdk", "builtin"])

const IMPLEMENTS_ENTRY = z
  .object({
    tool: z.string().min(1),
    version: z.string().min(1),
    schema_narrowing: z
      .object({
        drop_inputs: z.array(z.string()).optional(),
        drop_outputs: z.array(z.string()).optional(),
      })
      .optional(),
    mapping: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.object({ from: z.string(), transform: z.string().optional() }),
        ]),
      )
      .optional(),
    cost_override: z.unknown().optional(),
    timeout_override_ms: z.number().int().positive().optional(),
    retry_override: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()

export const driverManifestFrontmatterSchema = z
  .object({
    schema: z.literal("agentproto/driver/v1").optional(),
    id: z.string().regex(/^[a-z0-9][a-z0-9.\-_]{1,79}$/),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(2000),
    version: z.string().regex(/^\d+\.\d+\.\d+/).optional(),
    kind: DRIVER_KIND,
    implements: z.array(IMPLEMENTS_ENTRY).min(1),

    // Universal lifecycle / policy / sandbox blocks. Kept as `unknown`
    // for block content — the kind-specific runtime packages own the
    // strict shape; AIP-30 only requires presence + array-ness.
    install: z.array(z.unknown()).optional(),
    version_check: z.unknown().optional(),
    auth: z.unknown().optional(),
    network: z
      .object({
        egress: z.array(z.string()).optional(),
        ingress: z.array(z.string()).optional(),
      })
      .optional(),
    region: z.array(z.string()).optional(),
    policy_tags: z.array(z.string()).optional(),
    cost_override: z.unknown().optional(),
    timeout_override_ms: z.number().int().positive().optional(),
    retry_override: z.unknown().optional(),
    health_check: z.unknown().optional(),

    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()

export type DriverManifestFrontmatter = z.infer<
  typeof driverManifestFrontmatterSchema
>

export interface DriverManifest {
  frontmatter: DriverManifestFrontmatter
  body: string
}

/**
 * Parse a DRIVER.md source string into structured frontmatter + body.
 * Throws on missing frontmatter or schema-invalid frontmatter.
 */
export function parseDriverManifest(source: string): DriverManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseDriverManifest: missing or empty frontmatter")
  }
  const result = driverManifestFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseDriverManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

/**
 * Build a {@link DriverHandle} from a parsed `DRIVER.md` manifest +
 * caller-supplied execute bodies. The .md is the source of truth for
 * dispatch metadata (`implements[]`, install, auth, network, …); the
 * TS module supplies the actual function bodies via `execute` (legacy
 * keyed bag) or `implementations` (typed via `implementTool(handle, body)`).
 *
 * Mirrors `toolFromManifest`: same shape, same single source of truth
 * principle. Goes through `defineDriver` so the AIP-30 invariants
 * (`implements[]` ↔ execute consistency, top-level freeze, error
 * prefix) run uniformly with the TS path.
 *
 * @example
 *   const manifest = parseDriverManifest(readFileSync("./gh-cli/DRIVER.md", "utf8"))
 *   const ghCli = driverFromManifest({
 *     manifest,
 *     execute: {
 *       "list-prs": async ({ input }) => { ... },
 *     },
 *   })
 */
export function driverFromManifest(args: {
  manifest: DriverManifest
  execute?: Record<string, ExecuteFn>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  implementations?: readonly ToolImplementation<any, any, any>[]
}): DriverHandle {
  const fm = args.manifest.frontmatter

  const definition: DriverDefinition = {
    id: fm.id,
    name: fm.name,
    description: fm.description,
    version: fm.version,
    kind: fm.kind,
    implements: fm.implements.map((entry) => ({
      tool: entry.tool,
      version: entry.version,
      schemaNarrowing: entry.schema_narrowing
        ? {
            dropInputs: entry.schema_narrowing.drop_inputs,
            dropOutputs: entry.schema_narrowing.drop_outputs,
          }
        : undefined,
      mapping: entry.mapping,
      costOverride: entry.cost_override as DriverDefinition["costOverride"],
      timeoutOverrideMs: entry.timeout_override_ms,
      retryOverride: entry.retry_override as DriverDefinition["retryOverride"],
      metadata: entry.metadata,
    })),
    execute: args.execute,
    implementations: args.implementations,
    network: fm.network,
    region: fm.region,
    policyTags: fm.policy_tags,
    timeoutOverrideMs: fm.timeout_override_ms,
    tags: fm.tags,
    metadata: fm.metadata,
  }

  return defineDriver(definition)
}
