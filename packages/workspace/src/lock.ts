/**
 * AIP-34 agentproto.lock — plain YAML (no frontmatter, no body) at the
 * tree root. Mirrors `specs/resources/aip-34/draft/LOCK.schema.json` in
 * agentproto/agentproto (agentproto/agentproto#69, not yet merged — not
 * vendored into this repo's own `specs/resources/` yet).
 */

import { parse, stringify } from "yaml"
import { z } from "zod"

const idPattern = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/

const lockedAppSchema = z
  .object({
    id: z.string().regex(idPattern),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
    source: z.string().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    attach: z.string().regex(idPattern),
    dataDir: z.string(),
  })
  .strict()

const lockedPackSchema = z
  .object({
    name: z.string(),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
    digest: z.string().regex(/^(?:review\.pack-digest\/v1|agentproto-pack-digest\/v1):.+$/),
    attach: z.string().regex(idPattern),
  })
  .strict()

export const agentprotoLockSchema = z
  .object({
    lockfile: z.enum(["workspace.lock/v1", "agentproto-lock/v1"]),
    generated: z.string().datetime({ offset: true }),
    apps: z.array(lockedAppSchema).default([]),
    packs: z.array(lockedPackSchema).default([]),
  })
  .strict()

export type AgentprotoLock = z.infer<typeof agentprotoLockSchema>
export type AgentprotoLockInput = z.input<typeof agentprotoLockSchema>
export type LockedApp = z.infer<typeof lockedAppSchema>
export type LockedPack = z.infer<typeof lockedPackSchema>

export function parseLock(source: string): AgentprotoLock {
  const result = agentprotoLockSchema.safeParse(parse(source))
  if (!result.success) {
    throw new Error(
      `parseLock: invalid agentproto.lock — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return result.data
}

export function writeLock(lock: AgentprotoLockInput): string {
  const parsed = agentprotoLockSchema.parse(lock)
  // Writers keep emitting the legacy tags until the next major. Old readers
  // in the field only know agentproto-lock/v1 and agentproto-pack-digest/v1.
  return stringify({
    ...parsed,
    lockfile: "agentproto-lock/v1",
    packs: parsed.packs.map((pack) => ({
      ...pack,
      digest: pack.digest.replace(/^review\.pack-digest\/v1:/, "agentproto-pack-digest/v1:"),
    })),
  })
}
