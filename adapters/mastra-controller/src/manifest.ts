/**
 * `mastra.agent-controller/v1`: the manifest this adapter reads to build a
 * Mastra `AgentController` (`@mastra/core/agent-controller`).
 *
 * The id is vendor-namespaced on purpose. `harness/v1` is the id of AIP-45's
 * own AGENT-CLI document; this manifest describes ONE Mastra controller, not
 * an agent CLI, so it gets its own id.
 *
 * ## Portable vs host-resolved
 *
 * PORTABLE fields carry plain data that any host can hand to the controller
 * as is. They map 1:1 onto `AgentControllerConfig` / `AgentControllerMode` /
 * `AgentControllerSubagent` fields of the same name:
 *
 *   - `id`, `name`, `version`, `description`
 *   - `modes[]`: `id`, `name`, `description`, `default`, `transitionsTo`,
 *     `defaultModelId`, `instructions`, `availableTools`, `metadata`
 *   - `subagents[]`: `id`, `name`, `description`, `instructions`,
 *     `defaultModelId`, `maxSteps`, `forked`, `allowedControllerTools`,
 *     `allowedWorkspaceTools`
 *   - `omConfig` (Observational Memory defaults)
 *   - `models.allowed`
 *   - `permissions` (`PermissionRules`: per-category and per-tool policy)
 *
 * HOST-RESOLVED fields name a live object (a storage backend, a backing
 * agent, a memory, a workspace, a tool bundle, a model resolver) that only
 * the host can build. They are kept as an opaque `{ $resolver: string, ... }`
 * reference: this schema checks the shape and keeps every other key
 * untouched, and the host resolves it later
 * (`createAgentControllerHost({ resolvers })`, `./host.ts`). They are:
 *
 *   - top level: `storage`, `memory`, `workspace`, `agent`, `tools`,
 *     `models.resolver`
 *   - per mode: `agent`, `model`, `tools`
 *   - per subagent: `agent`, `model`, `tools`
 *
 * Every object is loose: keys this schema does not name (host profile
 * fields such as Guilde's `builtins`, `color`, `prompt`) pass through
 * unvalidated so a host profile can layer on top without a fork.
 *
 * `spec` is optional. Besides `mastra.agent-controller/v1` it accepts
 * `harness/v1`, the id agentik-studio's manifests carry today, so those
 * files parse unchanged.
 */

import matter from "gray-matter"
import { z } from "zod"

export const CONTROLLER_MANIFEST_ID = "mastra.agent-controller/v1"

/** Legacy id written by agentik-studio's `.harness/*.md` files. */
export const LEGACY_HARNESS_MANIFEST_ID = "harness/v1"

/** Opaque host reference. Only `$resolver` is checked; the rest is the host's. */
export const ResolverRefSchema = z
  .object({
    $resolver: z.string().min(1),
    input: z.unknown().optional(),
  })
  .loose()
export type ResolverRef = z.infer<typeof ResolverRefSchema>

export const PermissionPolicySchema = z.enum(["allow", "ask", "deny"])

export const PermissionRulesSchema = z
  .object({
    categories: z
      .partialRecord(z.enum(["read", "edit", "execute", "mcp", "other"]), PermissionPolicySchema)
      .optional(),
    tools: z.record(z.string(), PermissionPolicySchema).optional(),
  })
  .loose()
export type PermissionRules = z.infer<typeof PermissionRulesSchema>

export const ControllerModeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    default: z.boolean().optional(),
    /** Mode to switch to once a `submit_plan` from this mode is approved. */
    transitionsTo: z.string().min(1).optional(),
    defaultModelId: z.string().min(1).optional(),
    /** Layered above the backing agent's own instructions while in this mode. */
    instructions: z.string().optional(),
    /** Tool visibility allowlist (exposed tool names). `[]` hides every tool. */
    availableTools: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    agent: ResolverRefSchema.optional(),
    model: ResolverRefSchema.optional(),
    tools: ResolverRefSchema.optional(),
  })
  .loose()
export type ControllerMode = z.infer<typeof ControllerModeSchema>

export const ControllerSubagentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    instructions: z.string().optional(),
    defaultModelId: z.string().min(1).optional(),
    maxSteps: z.number().int().positive().optional(),
    forked: z.boolean().optional(),
    allowedControllerTools: z.array(z.string()).optional(),
    allowedWorkspaceTools: z.array(z.string()).optional(),
    agent: ResolverRefSchema.optional(),
    model: ResolverRefSchema.optional(),
    tools: ResolverRefSchema.optional(),
  })
  .loose()
export type ControllerSubagent = z.infer<typeof ControllerSubagentSchema>

export const ControllerOMConfigSchema = z
  .object({
    defaultObserverModelId: z.string().optional(),
    defaultReflectorModelId: z.string().optional(),
    defaultObservationThreshold: z.number().optional(),
    defaultReflectionThreshold: z.number().optional(),
  })
  .loose()
export type ControllerOMConfig = z.infer<typeof ControllerOMConfigSchema>

export const ControllerModelsSchema = z
  .object({
    allowed: z.array(z.string().min(1)).optional(),
    resolver: ResolverRefSchema.optional(),
  })
  .loose()
export type ControllerModels = z.infer<typeof ControllerModelsSchema>

export const ControllerManifestSchema = z
  .object({
    spec: z.enum([CONTROLLER_MANIFEST_ID, LEGACY_HARNESS_MANIFEST_ID]).optional(),
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    modes: z.array(ControllerModeSchema).min(1),
    subagents: z.array(ControllerSubagentSchema).optional(),
    omConfig: ControllerOMConfigSchema.optional(),
    models: ControllerModelsSchema.optional(),
    permissions: PermissionRulesSchema.optional(),
    storage: ResolverRefSchema.optional(),
    memory: ResolverRefSchema.optional(),
    workspace: ResolverRefSchema.optional(),
    agent: ResolverRefSchema.optional(),
    tools: ResolverRefSchema.optional(),
  })
  .loose()
  .superRefine((m, ctx) => {
    const ids = new Set<string>()
    m.modes.forEach((mode, i) => {
      if (ids.has(mode.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["modes", i, "id"],
          message: `duplicate mode id '${mode.id}'`,
        })
      }
      ids.add(mode.id)
    })
    const defaults = m.modes.flatMap((mode, i) => (mode.default === true ? [i] : []))
    for (const i of defaults.slice(1)) {
      ctx.addIssue({
        code: "custom",
        path: ["modes", i, "default"],
        message: `only one mode may be the default (mode '${m.modes[defaults[0]!]!.id}' already is)`,
      })
    }
    m.modes.forEach((mode, i) => {
      if (mode.transitionsTo !== undefined && !ids.has(mode.transitionsTo)) {
        ctx.addIssue({
          code: "custom",
          path: ["modes", i, "transitionsTo"],
          message: `transitionsTo names unknown mode '${mode.transitionsTo}'`,
        })
      }
    })
    const subIds = new Set<string>()
    m.subagents?.forEach((sub, i) => {
      if (subIds.has(sub.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["subagents", i, "id"],
          message: `duplicate subagent id '${sub.id}'`,
        })
      }
      subIds.add(sub.id)
    })
  })
export type ControllerManifest = z.infer<typeof ControllerManifestSchema>

export interface ControllerManifestIssue {
  /** Dotted field path, e.g. `modes.1.transitionsTo`; `(root)` for the document. */
  path: string
  message: string
}

export class ControllerManifestError extends Error {
  readonly issues: ControllerManifestIssue[]

  constructor(issues: ControllerManifestIssue[]) {
    super(
      `invalid ${CONTROLLER_MANIFEST_ID} manifest:\n` +
        issues.map(i => `  - ${i.path}: ${i.message}`).join("\n"),
    )
    this.name = "ControllerManifestError"
    this.issues = issues
  }
}

/**
 * Parse a `mastra.agent-controller/v1` manifest given either as markdown with
 * YAML frontmatter (the `.harness/*.md` form; the body is ignored) or as an
 * already-decoded object. Throws {@link ControllerManifestError} naming the
 * path of every invalid field.
 */
export function parseControllerManifest(input: string | unknown): ControllerManifest {
  let data: unknown = input
  if (typeof input === "string") {
    if (!matter.test(input)) {
      throw new ControllerManifestError([
        { path: "(root)", message: "markdown input has no YAML frontmatter block" },
      ])
    }
    try {
      // A fresh options object bypasses gray-matter's per-string cache, which
      // would otherwise hand back the same mutable `data` on repeated calls.
      data = matter(input, {}).data
    } catch (err) {
      throw new ControllerManifestError([
        { path: "(root)", message: `frontmatter is not valid YAML: ${(err as Error).message}` },
      ])
    }
  }
  const result = ControllerManifestSchema.safeParse(data)
  if (!result.success) {
    throw new ControllerManifestError(
      result.error.issues.map(issue => ({
        path: issue.path.length ? issue.path.map(String).join(".") : "(root)",
        message: issue.message,
      })),
    )
  }
  return result.data
}
