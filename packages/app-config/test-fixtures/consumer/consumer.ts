/**
 * Consumer contract for @agentproto/app-config: a book-shaped data model with
 * NO `id` on items (order entries `{n, slug, tier}` matched by `n`), compiled
 * against THIS package's own zod copy (see tsconfig paths). The kit's public
 * generics are kit-owned structural types (SchemaLike), NOT zod types — so
 * this compiles even when the consumer's zod minor differs from the kit's
 * own devDependency (the TS2741 exactPartial regression test).
 */
import { z } from "zod"
import {
  defineAppConfig,
  type AppKit,
  type GateRule,
  type Resolved,
  type ScopeFn,
  type VerifyFinding,
} from "@agentproto/app-config"

const CollectionSchema = z.object({
  id: z.string(),
  cover: z.object({ accents: z.record(z.string(), z.string()) }).default({ accents: {} }),
  order: z
    .array(z.object({ n: z.number().int(), slug: z.string(), tier: z.string() }))
    .default([]),
})

const BookSchema = z.object({
  n: z.number().int(),
  slug: z.string(),
  vertical: z.string(),
  accent: z.string().optional(),
  lang: z.string().default("en"),
})

export const kit: AppKit<
  z.output<typeof CollectionSchema>,
  z.output<typeof BookSchema>
> = defineAppConfig({
  app: CollectionSchema,
  item: BookSchema,
  itemsKey: "order",
  matchKey: { entry: "n", item: "n" },
  mergeArraysBy: { knowledge: "workspace" },
  project: (merged, ctx) => {
    const accents = ctx.app.cover.accents
    const vertical = typeof merged["vertical"] === "string" ? merged["vertical"] : ""
    const fallback = accents[vertical]
    return {
      ...merged,
      accent:
        merged["accent"] !== undefined ? merged["accent"] : typeof fallback === "string" ? fallback : undefined,
    }
  },
})

/** The kit's resolved type, generically parameterized by the consumer's schemas. */
export type ResolvedBooks = Resolved<z.output<typeof CollectionSchema>, z.output<typeof BookSchema>>

/** AppKit is parameterized by the OUTPUT types of the consumer's own schemas. */
export const annotated: AppKit<
  z.output<typeof CollectionSchema>,
  z.output<typeof BookSchema>
> = kit

export const scopes: Record<string, ScopeFn<ResolvedBooks>> = {
  accents: (resolved) =>
    resolved.order.flatMap((id) => {
      const book = resolved.items.get(id)
      if (book === undefined || book.value.accent !== undefined) return []
      return [
        {
          scope: "accents",
          level: "warn",
          message: `book ${book.value.slug}: no accent`,
          item: id,
          attrs: { book: book.value.slug },
        },
      ]
    }),
}

/** Async scope receiving the kit's ScopeContext (readArtifact) — v0.3 surface. */
export const asyncScopes: Record<string, ScopeFn<ResolvedBooks>> = {
  artifacts: async (resolved, ctx) => {
    const text = await ctx.readArtifact(`output/${resolved.order[0]}/chapter.md`)
    const lines = text
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.length > 100)
    const findings: VerifyFinding[] = lines.map(({ n }) => ({
      scope: "artifacts",
      level: "warn",
      message: `line ${n} too long`,
      attrs: { book: String(resolved.order[0]) },
    }))
    return findings
  },
}

export const rules: GateRule<ResolvedBooks>[] = [
  {
    id: "slugs-lowercase",
    level: "error",
    test: (ctx) =>
      ctx.resolved.order.flatMap((id) => {
        const book = ctx.resolved.items.get(id)
        if (book === undefined) return []
        return /^[a-z0-9-]+$/.test(book.value.slug)
          ? []
          : [{ message: `book ${id}: slug must be kebab-case`, item: id }]
      }),
  },
]
