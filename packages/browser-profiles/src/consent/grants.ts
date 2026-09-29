/** The grant model of AIP-63 (`$defs/grant`) and where grants are kept. Grants hold no cookie values. */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { GRANT_DOMAIN_PATTERN } from "./domains.js"
import { GrantStoreInvalidError } from "./errors.js"

export type GrantSink = { kind: "local" } | { kind: "remote"; providerId: string; ackSeq: number }

export type GrantSourceKind = "chrome" | "firefox" | "file" | "native-login"

export interface Grant {
  id: string
  sessionId: string
  /** Paired device (AIP-59) this grant is scoped to. Absent: usable by any device the host serves (C12). */
  deviceId?: string
  source: { kind: GrantSourceKind; profile: string }
  /** Explicit registrable domains. Exactly one of `domains` and `fullProfile`. */
  domains?: string[]
  /** The recorded full-profile grant (C3). Not a wildcard domain. */
  fullProfile?: true
  sinks: GrantSink[]
  grantedAt: string
  grantedVia: "interactive" | "flag"
  expiresAt?: string
  cookieCount: number
  revokedAt?: string
}

const grantSinkSchema = z.union([
  z.object({ kind: z.literal("local") }).strict(),
  z.object({ kind: z.literal("remote"), providerId: z.string(), ackSeq: z.number().int().min(0) }).strict(),
])

export const grantSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    deviceId: z.string().min(1).optional(),
    source: z.object({ kind: z.enum(["chrome", "firefox", "file", "native-login"]), profile: z.string().min(1) }).strict(),
    domains: z.array(z.string().max(253).regex(GRANT_DOMAIN_PATTERN)).min(1).optional(),
    fullProfile: z.literal(true).optional(),
    sinks: z.array(grantSinkSchema).min(1),
    grantedAt: z.iso.datetime({ offset: true }),
    grantedVia: z.enum(["interactive", "flag"]),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    cookieCount: z.number().int().min(0),
    revokedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    if ((g.domains === undefined) === (g.fullProfile === undefined)) {
      ctx.addIssue({ code: "custom", message: "a grant has exactly one of domains or fullProfile", path: ["domains"] })
    }
    if (g.fullProfile && g.sinks.some(s => s.kind !== "local")) {
      ctx.addIssue({ code: "custom", message: "a full-profile grant cannot include a remote sink (C3)", path: ["sinks"] })
    }
  })

/** True while the grant is not revoked and not past `expiresAt`. */
export function isGrantActive(grant: Grant, now: Date = new Date()): boolean {
  if (grant.revokedAt !== undefined) return false
  return grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now.getTime()
}

/** True when a call from `deviceId` may use the grant (C12): unscoped grants serve any device. */
export function grantServesDevice(grant: Grant, deviceId: string | undefined): boolean {
  return grant.deviceId === undefined || grant.deviceId === deviceId
}

/** Where grants live. Synchronous on purpose: a launch asks "is this grant still active" inline. */
export interface GrantStore {
  list(): Grant[]
  get(id: string): Grant | undefined
  put(grant: Grant): void
}

export function memoryGrantStore(initial: readonly Grant[] = []): GrantStore {
  const map = new Map(initial.map(g => [g.id, structuredClone(g)]))
  return {
    list: () => [...map.values()].map(g => structuredClone(g)),
    get: id => {
      const g = map.get(id)
      return g ? structuredClone(g) : undefined
    },
    put: grant => void map.set(grant.id, structuredClone(grant)),
  }
}

/** `~/.agentproto/bureau/grants.json`. Resolved on call, never at import. */
export function defaultGrantStorePath(home: string = homedir()): string {
  return join(home, ".agentproto", "bureau", "grants.json")
}

const isPosix = process.platform !== "win32"

/** One JSON file, dir 0700, file 0600, replaced atomically on every write. */
export function fileGrantStore(path: string = defaultGrantStorePath()): GrantStore {
  const load = (): Grant[] => {
    if (!existsSync(path)) return []
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      throw new GrantStoreInvalidError(`grants file ${path} is not valid JSON`)
    }
    const parsed = z.object({ version: z.literal(1), grants: z.array(grantSchema) }).safeParse(raw)
    if (!parsed.success) throw new GrantStoreInvalidError(`grants file ${path} does not hold a grant list`)
    return parsed.data.grants
  }
  return {
    list: load,
    get: id => load().find(g => g.id === id),
    put(grant) {
      const checked = grantSchema.parse(grant)
      const all = load().filter(g => g.id !== checked.id)
      all.push(checked)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, grants: all }, null, 2), { mode: 0o600 })
      renameSync(tmp, path)
      if (isPosix && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
    },
  }
}
