import { z } from "zod"
import type { KindDefinition } from "../types.js"
import { InvalidRefBody } from "../types.js"

export interface IpfsRef {
  kind: "ipfs"
  cid: string
  path?: string
}

const cidRe = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58,})$/

export const ipfsSchema: z.ZodType<IpfsRef> = z.object({
  kind: z.literal("ipfs"),
  cid: z.string().regex(cidRe),
  path: z.string().optional(),
})

export const ipfsKind: KindDefinition<IpfsRef> = {
  kind: "ipfs",
  collections: ["file"],
  schema: ipfsSchema,
  parse: body => {
    const colonIdx = body.indexOf(":")
    const cid = colonIdx < 0 ? body : body.slice(0, colonIdx)
    const path = colonIdx < 0 ? undefined : body.slice(colonIdx + 1)
    if (!cidRe.test(cid)) {
      throw new InvalidRefBody("ipfs", body, `invalid CID '${cid}'`)
    }
    return { kind: "ipfs", cid, ...(path ? { path } : {}) }
  },
  serialize: v => `${v.cid}${v.path ? `:${v.path}` : ""}`,
}
