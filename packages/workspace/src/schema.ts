/**
 * AIP-34 WORKSPACE.md frontmatter zod schema — the canonical `workspace/v2`
 * shape (AIP-34 supersedes the original `workspace/v1` draft outright; see
 * AIP-34 §Migrating from workspace/v1 — there is no v1 schema in this
 * package anymore).
 *
 * Hand-authored to mirror `specs/resources/aip-34/draft/WORKSPACE.schema.json`
 * in agentproto/agentproto (proposed in agentproto/agentproto#69, not yet
 * merged — this package predates `workspace/v2` being wired into
 * scaffold-aip's registry, so there's no generator pass yet; follow-up once
 * that spec PR lands and `scaffold-aip` learns the doctype).
 * Imported by `define-workspace.ts` (TS path) and `manifest/index.ts`
 * (.md path) so every field-level constraint runs in both authoring
 * paths from this ONE source of truth. Cross-field rules (type↔TYPES.md,
 * includes↔exports consent, budget aggregation) don't belong in a
 * per-node frontmatter schema — they need the whole tree and live in
 * `checker/` instead.
 */

import { z } from "zod"

const idPattern = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/

// Path confinement (AIP-34 §Path confinement): tree-relative, no leading
// `/`, no `..` segment anywhere. Schema-level best effort only — hosts
// MUST ALSO realpath-verify containment to catch a symlink escape (see
// `checker/check-tree.ts`'s `resolveSafe`).
const safeRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/") && !/(^|\/)\.\.(\/|$)/.test(p),
    "must be a tree-relative path with no leading '/' and no '..' traversal segment",
  )

const fileRefSchema = z.object({ file: safeRelativePathSchema }).strict()

const agentRefSchema = z
  .object({
    file: safeRelativePathSchema,
    share: z.array(z.string().regex(idPattern)).optional(),
  })
  .strict()

const includeEntrySchema = z
  .object({
    ref: z
      .string()
      .regex(/^ws:\/\/workspaces\/@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*(#.+)?$/)
      .refine((ref) => {
        const fragment = ref.split("#")[1]
        return fragment === undefined || !fragment.includes("..")
      }, "the #<subpath> fragment must not contain '..'")
      .describe("AIP-54 ws:// ref: ws://workspaces/<provider-id>[#<subpath>]"),
    mode: z.enum(["read", "write", "append"]).default("read"),
  })
  .strict()

const exportToSchema = z.union([
  z.literal("children"),
  z.string().regex(idPattern),
  z.array(z.string().regex(idPattern)).min(1),
])

const exportEntrySchema = z
  .object({
    path: safeRelativePathSchema,
    to: exportToSchema,
    mode: z.enum(["read", "write"]).default("read"),
  })
  .strict()

const usesSecretEntrySchema = z
  .object({
    from: z.string().regex(idPattern),
    slug: z.string().min(1),
    mode: z.enum(["bind", "reveal"]).default("bind"),
  })
  .strict()

const appRefSchema = z
  .object({
    id: z.string().regex(idPattern),
    version: z.string().min(1),
    expose: z.array(z.enum(["agents", "tools", "ui", "data"])).default([]),
    attach: z.string().default("self"),
  })
  .strict()

const acceptedAppEntrySchema = z
  .object({
    from: z.string().regex(idPattern),
    app: z.string().regex(idPattern).optional(),
  })
  .strict()

const policyLimitSchema = z
  .object({
    kind: z.string().min(1),
    value: z.number(),
    scope: z.string().optional(),
    per: z.string().optional(),
  })
  .catchall(z.unknown())

const policyRefBlockSchema = z
  .object({ limits: z.array(policyLimitSchema).default([]) })
  .catchall(z.unknown())
  .optional()

/**
 * `status` (AIP-34 §Status — paused/archived nodes): `paused` keeps
 * declarations/data but runs nothing (no agent started, no routine fired at
 * or below it; excluded from budget/heartbeat checks; still writable).
 * `archived` is read-only and excluded. Exported so `effective-status.ts`
 * (whole-tree, ancestor-chain logic — a single node's schema can't see its
 * ancestors) can share the exact literal union instead of re-declaring it.
 */
export const workspaceStatusSchema = z.enum(["active", "paused", "archived"])
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>

export const workspaceFrontmatterSchema = z
  .object({
    schema: z.literal("workspace/v2"),
    id: z.string().regex(idPattern).describe("Globally addressable, flat id `@<owner-slug>/<workspace-slug>`."),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
    name: z.string().min(1).max(80),
    description: z.string().max(2000).optional(),
    type: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .describe("Node kind — MUST resolve in the nearest ancestor TYPES.md."),
    status: workspaceStatusSchema.default("active"),
    owner: z
      .object({
        type: z.enum(["guild", "user", "org"]),
        id: z.string().min(1),
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/),
      })
      .strict(),
    storage: z.any().describe("AIP-35 STORAGE block. Required. Inline / ref / file."),
    sandbox: z.any().optional(),
    code: z.any().optional(),
    work: z
      .any()
      .optional()
      .describe(
        "AIP-20 WORK.md block (inline/ref/file, same union shape as `code`). A project node's status/board lives here — items are AIP-18 ITEM.md records — not in a flat status file.",
      ),
    identity: z.any().optional(),
    wall: z.enum(["shared", "isolated", "sealed", "hard"]).default("isolated"),
    includes: z.array(includeEntrySchema).default([]),
    exports: z.array(exportEntrySchema).default([]),
    agents: z.array(agentRefSchema).default([]),
    routines: z.array(fileRefSchema).default([]),
    secrets: fileRefSchema.optional(),
    uses_secrets: z.array(usesSecretEntrySchema).default([]),
    apps: z.array(appRefSchema).default([]),
    accepted_apps: z.array(acceptedAppEntrySchema).default([]),
    policy: policyRefBlockSchema,
    defaults: z.object({ read_only: z.boolean().optional() }).catchall(z.any()).optional(),
    publish: z
      .object({
        template: z.boolean().default(false),
        registry: z.string().optional(),
        visibility: z.enum(["private", "unlisted", "public"]).default("private"),
      })
      .strict()
      .optional(),
    tags: z.array(z.string()).default([] as never),
    created_at: z.string().datetime({ offset: true }).optional(),
    lock: z.string().default("agentproto.lock"),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict()
  .describe("Validates the YAML frontmatter portion of an AIP-34 WORKSPACE.md manifest — a workspace/v2 tree node.")

export type WorkspaceFrontmatter = z.infer<typeof workspaceFrontmatterSchema>
