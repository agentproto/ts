import { z } from "zod"
import type { KindDefinition } from "../types.js"
import { InvalidRefBody } from "../types.js"

export interface EthTxRef {
  kind: "eth_tx"
  chainId: number
  txHash: string
}

const txHashRe = /^0x[a-f0-9]{64}$/

export const ethTxSchema: z.ZodType<EthTxRef> = z.object({
  kind: z.literal("eth_tx"),
  chainId: z.number().int().positive(),
  txHash: z.string().regex(txHashRe),
})

export const ethTxKind: KindDefinition<EthTxRef> = {
  kind: "eth_tx",
  collections: ["anchor", "chain"],
  schema: ethTxSchema,
  parse: body => {
    const colonIdx = body.indexOf(":")
    if (colonIdx < 0) {
      throw new InvalidRefBody("eth_tx", body, "expected '<chainId>:<txHash>'")
    }
    const chainIdStr = body.slice(0, colonIdx)
    const txHash = body.slice(colonIdx + 1)
    const chainId = Number(chainIdStr)
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new InvalidRefBody(
        "eth_tx",
        body,
        `invalid chainId '${chainIdStr}'`
      )
    }
    if (!txHashRe.test(txHash)) {
      throw new InvalidRefBody("eth_tx", body, `invalid txHash '${txHash}'`)
    }
    return { kind: "eth_tx", chainId, txHash }
  },
  serialize: v => `${v.chainId}:${v.txHash}`,
}
