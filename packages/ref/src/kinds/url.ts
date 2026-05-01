import { z } from "zod"
import type { KindDefinition } from "../types.js"
import { InvalidRefBody } from "../types.js"
import { splitShaSuffix } from "./local.js"

const sha256Re = /^[a-f0-9]{64}$/

export interface UrlRef {
  kind: "url"
  href: string
  sha256?: string
}

export const urlSchema: z.ZodType<UrlRef> = z.object({
  kind: z.literal("url"),
  href: z.string().refine(s => /^https?:\/\//.test(s), {
    message: "href must use http or https scheme",
  }),
  sha256: z.string().regex(sha256Re).optional(),
})

export const urlKind: KindDefinition<UrlRef> = {
  kind: "url",
  collections: ["file"],
  schema: urlSchema,
  parse: body => {
    const { path: href, sha256 } = splitShaSuffix(body)
    if (!/^https?:\/\//.test(href)) {
      throw new InvalidRefBody(
        "url",
        body,
        "href must use http or https scheme"
      )
    }
    return { kind: "url", href, ...(sha256 ? { sha256 } : {}) }
  },
  serialize: v => `${v.href}${v.sha256 ? `#sha256=${v.sha256}` : ""}`,
  resolve: async (value, ctx) => {
    if (!ctx.fetcher) throw new Error("url resolve requires ctx.fetcher")
    const bytes = await ctx.fetcher(value.href)
    return { bytes }
  },
}
