/**
 * AIP-44 ACP.md frontmatter zod schema.
 *
 * Mirrors `resources/aip-44/draft/ACP.schema.json` field-for-field.
 * AIP-44 is an agentproto profile of the upstream Agent Client
 * Protocol (agentclientprotocol.com) — the manifest declares an
 * agent or client's role/transport/conformance level, and AIP-44-
 * specific bindings live under `metadata.aip44.*` so plain ACP
 * runtimes preserve them verbatim.
 *
 * Both authoring paths (`define-acp.ts` for TS-authored manifests
 * and `manifest/index.ts` for ACP.md parsing) validate against this
 * schema, so every field-level constraint runs in both paths from a
 * single source of truth.
 *
 * Cross-field rules (tier=sandboxed ⇒ sandbox required) live in
 * `define-acp.ts`'s `validate(def)` body — they're harder to encode
 * in a flat zod schema and want a single error path.
 */

import { z } from "zod"

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const ACP_REV_PATTERN = /^[a-f0-9]{7,40}$/

const transportSchema = z.enum(["stdio", "websocket"])

const capabilitiesSchema = z
  .object({
    client: z
      .object({
        fs: z
          .object({
            readTextFile: z.boolean().optional(),
            writeTextFile: z.boolean().optional(),
          })
          .strict()
          .optional(),
        terminal: z.boolean().optional(),
      })
      .strict()
      .optional(),
    agent: z
      .object({
        loadSession: z.boolean().optional(),
        promptCapabilities: z
          .object({
            image: z.boolean().optional(),
            audio: z.boolean().optional(),
            embeddedContext: z.boolean().optional(),
          })
          .strict()
          .optional(),
        mcpCapabilities: z
          .object({
            http: z.boolean().optional(),
            sse: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe(
    "Mirror of upstream ACP `initialize` capabilities. Omitted keys MUST be treated as unsupported.",
  )

const aip44ExtensionsSchema = z
  .object({
    acp_rev: z
      .string()
      .regex(ACP_REV_PATTERN)
      .describe(
        "Commit SHA of agentclientprotocol/agent-client-protocol this manifest validates against.",
      ),
    tier: z
      .enum(["basic", "governance-aware", "sandboxed"])
      .describe(
        "Capability tier shorthand. basic = session/{new,prompt,update}; governance-aware = + loadSession + tool-call streaming; sandboxed = + mcpCapabilities + sandbox profile.",
      ),
    capabilities: capabilitiesSchema.optional(),
    operator: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Workspace-relative ref to AIP-9 OPERATOR.md. REQUIRED when kind=server (cross-field rule in define-acp).",
      ),
    governance: z.string().min(1).optional(),
    sandbox: z
      .string()
      .min(1)
      .optional()
      .describe("Ref to AIP-36 SANDBOX.md. REQUIRED when tier=sandboxed."),
    audit: z
      .object({
        ref: z.string().optional(),
        kind: z.enum(["governance", "external", "off"]).optional(),
      })
      .strict()
      .optional(),
    mcp_servers: z
      .array(
        z
          .object({
            name: z.string().min(1),
            transport: z.enum(["stdio", "http", "sse"]),
            ref: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .loose()

export const acpFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(80)
      .describe("Kebab id; MUST equal the parent directory name."),
    id: z.string().regex(ID_PATTERN),
    description: z.string().min(1).max(2000),
    version: z.string().regex(SEMVER_PATTERN),
    kind: z.enum(["client", "server", "bridge"]),
    transport: z.union([
      transportSchema,
      z.array(transportSchema).min(1),
    ]),
    metadata: z
      .object({ aip44: aip44ExtensionsSchema })
      .loose()
      .describe(
        "Free-form metadata. metadata.aip44.* hosts AIP-44 extensions; upstream ACP runtimes preserve unknown keys verbatim.",
      ),
    tags: z.array(z.string().regex(TAG_PATTERN)).optional(),
  })
  .loose()
  .describe(
    "Validates the YAML frontmatter portion of an AIP-44 ACP.md manifest.",
  )

export type AcpFrontmatter = z.infer<typeof acpFrontmatterSchema>
export type Aip44Extensions = z.infer<typeof aip44ExtensionsSchema>
export type AcpCapabilities = z.infer<typeof capabilitiesSchema>
export type AcpRole = AcpFrontmatter["kind"]
export type AcpTransport = z.infer<typeof transportSchema>
