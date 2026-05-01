import { z } from "zod"
import type { KindDefinition } from "../types.js"
import { InvalidRefBody } from "../types.js"

const idRe = /^[A-Za-z0-9_-]+$/

export interface UserRef {
  kind: "user"
  id: string
  workspace?: string
}

export const userSchema: z.ZodType<UserRef> = z.object({
  kind: z.literal("user"),
  id: z.string().regex(idRe),
  workspace: z.string().min(1).optional(),
})

export const userKind: KindDefinition<UserRef> = {
  kind: "user",
  collections: ["identity"],
  schema: userSchema,
  parse: body => {
    const atIdx = body.indexOf("@")
    const id = atIdx < 0 ? body : body.slice(0, atIdx)
    const workspace = atIdx < 0 ? undefined : body.slice(atIdx + 1)
    if (!idRe.test(id)) {
      throw new InvalidRefBody("user", body, `invalid id '${id}'`)
    }
    return { kind: "user", id, ...(workspace ? { workspace } : {}) }
  },
  serialize: v => `${v.id}${v.workspace ? `@${v.workspace}` : ""}`,
}
