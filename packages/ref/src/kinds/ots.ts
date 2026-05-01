import { z } from "zod"
import type { KindDefinition } from "../types.js"
import { InvalidRefBody } from "../types.js"
import { parseCompact, serializeCompact } from "../compact.js"
import { getRefKind } from "../registry.js"
import type { LocalRef } from "./local.js"
import type { UrlRef } from "./url.js"

export interface OtsRef {
  kind: "ots"
  proof: LocalRef | UrlRef
}

export const otsSchema: z.ZodType<OtsRef> = z.object({
  kind: z.literal("ots"),
  proof: z.union([
    z.object({
      kind: z.literal("local"),
      path: z.string(),
      sha256: z.string().optional(),
    }),
    z.object({
      kind: z.literal("url"),
      href: z.string(),
      sha256: z.string().optional(),
    }),
  ]) as z.ZodType<LocalRef | UrlRef>,
})

/**
 * Compact body: an inner compact ref whose kind is `local` or `url`.
 * Example: `ots:local:engagements/acme/_chain/anchors/247.ots`
 */
export const otsKind: KindDefinition<OtsRef> = {
  kind: "ots",
  collections: ["anchor"],
  schema: otsSchema,
  parse: body => {
    const inner = parseCompact(body)
    if (inner.kind !== "local" && inner.kind !== "url") {
      throw new InvalidRefBody(
        "ots",
        body,
        `inner ref must be local or url, got '${inner.kind}'`
      )
    }
    return { kind: "ots", proof: inner }
  },
  serialize: v => serializeCompact(v.proof),
  resolve: async (value, ctx) => {
    const innerDef = getRefKind(value.proof.kind)
    if (!innerDef?.resolve) {
      throw new Error(`ots inner kind '${value.proof.kind}' has no resolver`)
    }
    return innerDef.resolve(value.proof, ctx)
  },
}
