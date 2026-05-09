/**
 * AIP-45 AGENT-CLI.md frontmatter zod schema.
 *
 * Mirrors `resources/aip-45/draft/AGENT-CLI.schema.json`. AIP-45 is a
 * sibling of AIP-29 (CLI.md, tool CLIs) covering interactive
 * agent-as-process binaries. The `protocol` discriminator (acp / mcp
 * / proprietary) selects the wire arm; cross-field rules ensure the
 * matching arm-specific block is present.
 *
 * Both authoring paths (`define-agent-cli.ts` and
 * `manifest/index.ts`) validate against this schema, so every
 * field-level constraint runs in both paths from a single source of
 * truth.
 */

import { z } from "zod"

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SEMVER_RANGE_PATTERN = /^[><=^~ \d.\-+\w*xX|, ]+$/
const ADAPTER_PATTERN = /^@?[a-z0-9][a-z0-9-./]*$/
const BIN_PATTERN = /^[A-Za-z0-9._\-/]+$/

// AIP-29 install methods, mirrored locally to avoid a runtime cross-package import.
// Schema-level $ref to AIP-29 is preserved on the JSON Schema side
// (resources/aip-45/draft/AGENT-CLI.schema.json); this zod copy is the
// TS-side mirror used by `defineAgentCli`. When AIP-29 grows new
// install methods, both sides update together via scaffold-aip.

const installMethodSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("brew"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("apt"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("dnf"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("pacman"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("choco"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("scoop"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("npm"), package: z.string(), global: z.boolean().optional(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("pip"), package: z.string(), user: z.boolean().optional(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("cargo"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("go"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({
    method: z.literal("curl"),
    url: z.string().url(),
    verify_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    experimental: z.boolean().optional(),
  }).strict(),
  z.object({
    method: z.literal("download"),
    url: z.string().url(),
    extract_bin: z.string(),
    verify_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    experimental: z.boolean().optional(),
  }).strict(),
  z.object({ method: z.literal("vendored"), path: z.string(), experimental: z.boolean().optional() }).strict(),
])

const versionCheckSchema = z.object({
  cmd: z.string(),
  parse: z.string().describe("ECMAScript regex with at least one capture group."),
  range: z.string().regex(SEMVER_RANGE_PATTERN).describe("npm-style semver range."),
  timeout_ms: z.number().int().min(100).default(5000),
}).strict()

const authSchema = z.object({
  ref: z.string().optional(),
  state: z.object({
    paths: z.array(z.string()).optional(),
    env: z.array(z.string()).optional(),
  }).strict().optional(),
  login: z.object({
    cmd: z.string(),
    interactive: z.boolean().optional(),
    requires_callback_url: z.boolean().optional(),
  }).strict().optional(),
  refresh: z.object({
    cmd: z.string(),
    interval_s: z.number().int().positive().optional(),
  }).strict().optional(),
  expiry: z.object({
    parse: z.string().optional(),
    grace_s: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict()

const sessionSchema = z.object({
  mode: z.enum(["ephemeral", "persistent", "resumable"]).default("ephemeral"),
  idle_timeout_ms: z.number().int().min(1000).default(600_000),
  max_turns: z.number().int().positive().optional(),
  context_carryover: z.boolean().default(true),
}).strict()

const modelsSchema = z.object({
  default: z.string().optional(),
  allowed: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict()

const capabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  tool_calls: z.boolean().optional(),
  sub_agents: z.boolean().optional(),
  file_io: z.boolean().optional(),
  multimodal: z.boolean().optional(),
  resumable: z.boolean().optional(),
  bidirectional: z.boolean().optional(),
}).strict()

const mcpBlockSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  transport: z.enum(["stdio", "http", "sse"]),
  url: z.string().url().optional(),
}).strict()

export const agentCliFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(80),
    id: z.string().regex(ID_PATTERN),
    description: z.string().min(1).max(2000),
    version: z.string().regex(SEMVER_PATTERN),
    bin: z.string().regex(BIN_PATTERN),
    bin_args: z.array(z.string()).optional(),
    install: z.array(installMethodSchema).min(1),
    version_check: versionCheckSchema,
    auth: authSchema.optional(),
    sandbox: z.union([z.string(), z.record(z.string(), z.unknown())]),
    runner: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    protocol: z.enum(["acp", "mcp", "proprietary"]),
    acp: z.string().optional(),
    mcp: mcpBlockSchema.optional(),
    adapter: z.string().regex(ADAPTER_PATTERN).optional(),
    session: sessionSchema.optional(),
    models: modelsSchema.optional(),
    capabilities: capabilitiesSchema.optional(),
    requires: z.object({
      os: z.array(z.enum(["darwin", "linux", "windows"])).optional(),
      arch: z.array(z.enum(["x64", "arm64", "x86", "arm"])).optional(),
      min_disk_mb: z.number().int().nonnegative().optional(),
      min_memory_mb: z.number().int().nonnegative().optional(),
    }).strict().optional(),
    examples: z.array(z.object({
      goal: z.string(),
      prompt: z.string(),
      note: z.string().optional(),
    }).strict()).optional(),
    tags: z.array(z.string().regex(TAG_PATTERN)).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .describe(
    "Validates the YAML frontmatter portion of an AIP-45 AGENT-CLI.md manifest.",
  )

export type AgentCliFrontmatter = z.infer<typeof agentCliFrontmatterSchema>
