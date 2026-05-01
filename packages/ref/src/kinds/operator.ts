import { z } from "zod"
import type { KindDefinition } from "../types.js"
import { InvalidRefBody } from "../types.js"

const slugRe = /^[a-z][a-z0-9_-]*$/

export interface OperatorRef {
  kind: "operator"
  slug: string
  workspace?: string
}

export const operatorSchema: z.ZodType<OperatorRef> = z.object({
  kind: z.literal("operator"),
  slug: z.string().regex(slugRe),
  workspace: z.string().min(1).optional(),
})

export const operatorKind: KindDefinition<OperatorRef> = {
  kind: "operator",
  collections: ["identity"],
  schema: operatorSchema,
  parse: body => {
    const atIdx = body.indexOf("@")
    const slug = atIdx < 0 ? body : body.slice(0, atIdx)
    const workspace = atIdx < 0 ? undefined : body.slice(atIdx + 1)
    if (!slugRe.test(slug)) {
      throw new InvalidRefBody("operator", body, `invalid slug '${slug}'`)
    }
    return { kind: "operator", slug, ...(workspace ? { workspace } : {}) }
  },
  serialize: v => `${v.slug}${v.workspace ? `@${v.workspace}` : ""}`,
}
