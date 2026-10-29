/**
 * AIP-34 TYPES.md — the node-type registry a `workspace/v2` tree reads
 * once, at the root, to know which `type` values are legal and what
 * each one implies (allowed parents, default wall, required sibling
 * files). Mirrors `specs/resources/aip-34/draft/TYPES.schema.json` in
 * agentproto/agentproto (agentproto/agentproto#69, not yet merged — not
 * vendored into this repo's own `specs/resources/` yet).
 */

import matter from "gray-matter"
import { z } from "zod"

const typeEntrySchema = z
  .object({
    parents: z.array(z.string()).optional(),
    extends: z.string().optional(),
    default_wall: z.enum(["shared", "isolated", "sealed", "hard"]).optional(),
    max_per_tree: z.number().int().min(1).optional(),
    requires_files: z.array(z.string()).default([]),
    starter: z
      .object({
        agents: z.array(z.object({ template: z.string() }).strict()).optional(),
        routines: z.array(z.object({ template: z.string() }).strict()).optional(),
      })
      .strict()
      .optional(),
    adds_fields: z.record(z.string(), z.string()).optional(),
  })
  .strict()

export const typesManifestSchema = z
  .object({
    schema: z.enum(["workspace.types/v1", "workspace-types/v1"]),
    types: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), typeEntrySchema),
  })
  .strict()

export type TypesManifestFrontmatter = z.infer<typeof typesManifestSchema>
export type TypesManifestFrontmatterInput = z.input<typeof typesManifestSchema>
export type TypeEntry = z.infer<typeof typeEntrySchema>

export function parseTypesManifest(source: string): TypesManifestFrontmatter {
  const parsed = matter(source)
  const result = typesManifestSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseTypesManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return result.data
}

// Accepts the pre-default INPUT shape (e.g. `requires_files` omitted) —
// same input/output split as `types.ts`'s `WorkspaceDefinition`, so an
// author doesn't have to spell out every zod default by hand.
export function writeTypesManifest(def: TypesManifestFrontmatterInput, body = ""): string {
  const parsed = typesManifestSchema.parse(def)
  // Writers emit the canonical tag; readers still accept the legacy
  // workspace-types/v1 alias in the schema enum above.
  return matter.stringify(body, { ...parsed, schema: "workspace.types/v1" })
}

/** `type`'s resolved parent-chain floor, per the type's own `extends` chain. */
export function resolveTypeEntry(
  types: TypesManifestFrontmatter["types"],
  type: string,
): TypeEntry | undefined {
  return resolveEntry(types, type, new Set())
}

// `visiting` makes a cyclic `extends` stop at the repeated type instead of
// recursing forever; `validateTypesRegistry` is what reports the cycle.
function resolveEntry(
  types: TypesManifestFrontmatter["types"],
  type: string,
  visiting: Set<string>,
): TypeEntry | undefined {
  const entry = types[type]
  if (!entry) return undefined
  if (!entry.extends || visiting.has(type)) return entry
  visiting.add(type)
  const base = resolveEntry(types, entry.extends, visiting)
  if (!base) return entry
  return {
    ...base,
    ...entry,
    requires_files: entry.requires_files.length > 0 ? entry.requires_files : base.requires_files,
  }
}

export type TypesRegistryIssue =
  | { kind: "extends-cycle"; type: string; cycle: string[]; message: string }
  | { kind: "unknown-parent"; type: string; extends: string; message: string }

/**
 * Reports the `extends` problems of a TYPES.md registry: a cycle (reported
 * once, on the first type in registry order that sits on it) and an `extends`
 * naming a type the registry does not declare.
 */
export function validateTypesRegistry(types: TypesManifestFrontmatter["types"]): TypesRegistryIssue[] {
  const issues: TypesRegistryIssue[] = []
  const inReportedCycle = new Set<string>()
  for (const name of Object.keys(types)) {
    const entry = types[name]
    if (entry?.extends !== undefined && !Object.hasOwn(types, entry.extends)) {
      issues.push({
        kind: "unknown-parent",
        type: name,
        extends: entry.extends,
        message: `type "${name}" extends "${entry.extends}", which TYPES.md does not declare.`,
      })
    }
    const path: string[] = []
    let cursor: string | undefined = name
    while (cursor !== undefined && Object.hasOwn(types, cursor) && !path.includes(cursor)) {
      path.push(cursor)
      cursor = types[cursor]?.extends
    }
    if (cursor !== undefined && path.includes(cursor)) {
      const cycle = path.slice(path.indexOf(cursor))
      if (!cycle.some((t) => inReportedCycle.has(t))) {
        cycle.forEach((t) => inReportedCycle.add(t))
        issues.push({
          kind: "extends-cycle",
          type: name,
          cycle: [...cycle, cursor],
          message: `type "${name}" has an \`extends\` cycle: ${[...cycle, cursor].join(" -> ")}.`,
        })
      }
    }
  }
  return issues
}
