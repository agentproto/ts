import { z } from "zod"
import type { KindDefinition } from "../types.js"
import { InvalidRefBody } from "../types.js"

export interface EmailRef {
  kind: "email"
  address: string
}

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const emailSchema: z.ZodType<EmailRef> = z.object({
  kind: z.literal("email"),
  address: z.string().regex(emailRe),
})

export const emailKind: KindDefinition<EmailRef> = {
  kind: "email",
  collections: ["identity"],
  schema: emailSchema,
  parse: body => {
    if (!emailRe.test(body)) {
      throw new InvalidRefBody("email", body, "not a valid email address")
    }
    return { kind: "email", address: body }
  },
  serialize: v => v.address,
}
