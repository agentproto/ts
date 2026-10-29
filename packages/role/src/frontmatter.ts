/**
 * The ROLE.md frontmatter schema as this package validates it: the generated
 * `schema.ts` plus AIP-47 `slots`, which the vendored ROLE.schema.json does not
 * carry yet. Kept out of the generated file so a re-scaffold cannot drop it.
 */

import { z } from "zod"
import { roleFrontmatterSchema as generated } from "./schema.js"
import { roleSlotsSchema } from "./slots.js"

export const roleFrontmatterSchema = generated.extend({
  slots: roleSlotsSchema.optional(),
})

export type RoleFrontmatter = z.infer<typeof roleFrontmatterSchema>
