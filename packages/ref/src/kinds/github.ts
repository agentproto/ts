import { z } from "zod"
import type { KindDefinition } from "../types.js"
import { InvalidRefBody } from "../types.js"

export interface GithubRef {
  kind: "github"
  owner: string
  repo: string
  ref?: string
  path?: string
}

const slugRe = /^[A-Za-z0-9._-]+$/

export const githubSchema: z.ZodType<GithubRef> = z.object({
  kind: z.literal("github"),
  owner: z.string().regex(slugRe),
  repo: z.string().regex(slugRe),
  ref: z.string().min(1).optional(),
  path: z.string().optional(),
})

/**
 * Compact body: `<owner>/<repo>[@<ref>][:<path>]`
 */
export const githubKind: KindDefinition<GithubRef> = {
  kind: "github",
  collections: ["file"],
  schema: githubSchema,
  parse: body => {
    const slashIdx = body.indexOf("/")
    if (slashIdx < 0) {
      throw new InvalidRefBody(
        "github",
        body,
        "missing '<owner>/<repo>' segment"
      )
    }
    const owner = body.slice(0, slashIdx)
    let rest = body.slice(slashIdx + 1)

    let ref: string | undefined
    let path: string | undefined

    const colonIdx = rest.indexOf(":")
    if (colonIdx >= 0) {
      path = rest.slice(colonIdx + 1)
      rest = rest.slice(0, colonIdx)
    }

    const atIdx = rest.indexOf("@")
    let repo: string
    if (atIdx >= 0) {
      repo = rest.slice(0, atIdx)
      ref = rest.slice(atIdx + 1)
    } else {
      repo = rest
    }

    if (!slugRe.test(owner)) {
      throw new InvalidRefBody("github", body, `invalid owner '${owner}'`)
    }
    if (!slugRe.test(repo)) {
      throw new InvalidRefBody("github", body, `invalid repo '${repo}'`)
    }

    return {
      kind: "github",
      owner,
      repo,
      ...(ref ? { ref } : {}),
      ...(path ? { path } : {}),
    }
  },
  serialize: v =>
    `${v.owner}/${v.repo}${v.ref ? `@${v.ref}` : ""}${v.path ? `:${v.path}` : ""}`,
}
