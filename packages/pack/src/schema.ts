/**
 * PACK.md frontmatter zod schema (AIP-64, pack/v1).
 *
 * Imported by both `define-pack.ts` (TS path validation) and
 * `manifest/index.ts` (.md path validation) so every field-level
 * constraint runs in both authoring paths from a single source of truth.
 *
 * The schema is strict (AIP-64 §File location): an unknown key at the top
 * level or inside any object is a parse error. That is also what keeps
 * instances out of a pack: there is no `operators`, `companies` or
 * `offices` member, so a manifest carrying one fails like any unknown key.
 *
 * Cross-field rules that need no I/O (catalog member paths) run here in a
 * superRefine; plugin-must-be-resolvable and pricing.bundle > 0 live in
 * `define-pack.ts`'s `validate(def)`.
 */

import { z } from "zod"

export const CATALOG_MEMBER_KINDS = ["roles", "personas", "policies"] as const
export type CatalogMemberKind = (typeof CATALOG_MEMBER_KINDS)[number]

/** The filename each owning AIP makes normative for a catalog member. */
export const CATALOG_MEMBER_FILENAME: Readonly<Record<CatalogMemberKind, string>> = {
  roles: "ROLE.md",
  personas: "PERSONA.md",
  policies: "POLICY.md",
}

const catalogMemberSchema = z.object({ path: z.string().min(1) }).strict()

export const packFrontmatterSchema = z
  .object({
    schema: z.literal("pack/v1"),
    name: z
      .string()
      .regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$"))
      .min(2)
      .max(80),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    version: z.string().min(1),
    plugin: z
      .object({
        inline: z.boolean().optional(),
        includes: z.array(z.string()).optional(),
      })
      .strict(),
    apps: z
      .array(
        z
          .object({
            id: z.string().min(1),
            path: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    roles: z.array(catalogMemberSchema).optional(),
    personas: z.array(catalogMemberSchema).optional(),
    policies: z.array(catalogMemberSchema).optional(),
    knowledge: z
      .object({
        workspace: z.string().min(1),
        anyOf: z.array(z.string()).optional(),
        allOf: z.array(z.string()).optional(),
        kinds: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    playbook: z
      .object({
        title: z.string().min(1),
        root: z.string().optional(),
        targetChapters: z.number().int().gte(1).optional(),
      })
      .strict()
      .optional(),
    pricing: z
      .object({
        ebook: z.number().gte(0).optional(),
        bundle: z.number().gte(0),
        step: z.number().gte(0).optional(),
      })
      .strict()
      .optional(),
    blockers: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((fm, ctx) => {
    const seen = new Set<string>()
    const claim = (path: string, at: (string | number)[]) => {
      if (seen.has(path)) {
        ctx.addIssue({
          code: "custom",
          path: at,
          message: `path '${path}' is declared twice (each path is a digest label)`,
        })
      }
      seen.add(path)
    }
    for (const [i, app] of (fm.apps ?? []).entries()) claim(app.path, ["apps", i, "path"])
    for (const kind of CATALOG_MEMBER_KINDS) {
      const filename = CATALOG_MEMBER_FILENAME[kind]
      for (const [i, member] of (fm[kind] ?? []).entries()) {
        const at: (string | number)[] = [kind, i, "path"]
        const p = member.path
        const segments = p.split(/[\\/]/)
        if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) {
          ctx.addIssue({ code: "custom", path: at, message: `path '${p}' must not be absolute` })
        }
        if (segments.includes("..")) {
          ctx.addIssue({ code: "custom", path: at, message: `path '${p}' must not contain a '..' segment` })
        }
        if (segments.at(-1) !== filename) {
          ctx.addIssue({ code: "custom", path: at, message: `path '${p}' must end with ${filename}` })
        }
        claim(p, at)
      }
    }
  })

export type PackFrontmatter = z.infer<typeof packFrontmatterSchema>
