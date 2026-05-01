import { z } from "zod"
import type { KindDefinition } from "../types.js"
import { InvalidRefBody } from "../types.js"

const idRe = /^[a-z][a-z0-9_-]*$/

export interface PersonaRef {
  kind: "persona"
  id: string
}

export const personaSchema: z.ZodType<PersonaRef> = z.object({
  kind: z.literal("persona"),
  id: z.string().regex(idRe),
})

export const personaKind: KindDefinition<PersonaRef> = {
  kind: "persona",
  collections: ["identity"],
  schema: personaSchema,
  parse: body => {
    if (!idRe.test(body)) {
      throw new InvalidRefBody("persona", body, `invalid id '${body}'`)
    }
    return { kind: "persona", id: body }
  },
  serialize: v => v.id,
}
