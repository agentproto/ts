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
    schema: z.literal("workspace-types/v1"),
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
// same input/output split as `types-v2.ts`'s WorkspaceDefinitionV2, so an
// author doesn't have to spell out every zod default by hand.
export function writeTypesManifest(def: TypesManifestFrontmatterInput, body = ""): string {
  const parsed = typesManifestSchema.parse(def)
  return matter.stringify(body, parsed)
}

/** `type`'s resolved parent-chain floor, per the type's own `extends` chain. */
export function resolveTypeEntry(
  types: TypesManifestFrontmatter["types"],
  type: string,
): TypeEntry | undefined {
  const entry = types[type]
  if (!entry) return undefined
  if (!entry.extends) return entry
  const base = resolveTypeEntry(types, entry.extends)
  if (!base) return entry
  return {
    ...base,
    ...entry,
    requires_files: entry.requires_files.length > 0 ? entry.requires_files : base.requires_files,
  }
}
