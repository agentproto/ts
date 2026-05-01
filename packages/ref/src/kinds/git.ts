import { z } from "zod"
import type { KindDefinition } from "../types.js"
import { InvalidRefBody } from "../types.js"

export interface GitRef {
  kind: "git"
  url: string
  ref: string
  path?: string
}

export const gitSchema: z.ZodType<GitRef> = z.object({
  kind: z.literal("git"),
  url: z.string().min(1),
  ref: z.string().min(1),
  path: z.string().optional(),
})

/**
 * Compact body: `<pct-encoded-url>@<ref>[:<path>]`
 *
 * URL is percent-encoded so `@` and `:` inside it don't break parsing.
 * `ref` cannot contain `:`. `path` is everything after the first `:` after
 * the last `@`.
 */
export const gitKind: KindDefinition<GitRef> = {
  kind: "git",
  collections: ["file"],
  schema: gitSchema,
  parse: body => {
    const atIdx = body.lastIndexOf("@")
    if (atIdx < 0) {
      throw new InvalidRefBody("git", body, "missing '@<ref>' segment")
    }
    const encodedUrl = body.slice(0, atIdx)
    const tail = body.slice(atIdx + 1)
    const colonIdx = tail.indexOf(":")
    const ref = colonIdx < 0 ? tail : tail.slice(0, colonIdx)
    const path = colonIdx < 0 ? undefined : tail.slice(colonIdx + 1)
    if (!encodedUrl) throw new InvalidRefBody("git", body, "empty url")
    if (!ref) throw new InvalidRefBody("git", body, "empty ref")
    return {
      kind: "git",
      url: decodeURIComponent(encodedUrl),
      ref,
      ...(path ? { path } : {}),
    }
  },
  serialize: v =>
    `${encodeURIComponent(v.url)}@${v.ref}${v.path ? `:${v.path}` : ""}`,
}
