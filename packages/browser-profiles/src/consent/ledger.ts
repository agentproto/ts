/**
 * The consent ledger (AIP-63 C10, C11): an append-only JSONL file, one record per
 * grant, refresh, revoke, sink-ack or deny. The record shape is closed on purpose
 * (see `ledgerRecordSchema`): there is no field a cookie value could go in.
 */

import { createHash } from "node:crypto"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { GRANT_DOMAIN_PATTERN } from "./domains.js"
import { LedgerRecordInvalidError } from "./errors.js"

/** `~/.agentproto/bureau/consent.jsonl`. Resolved on call, never at import. */
export function defaultConsentLedgerPath(home: string = homedir()): string {
  return join(home, ".agentproto", "bureau", "consent.jsonl")
}

const domainSchema = z.string().max(253).regex(GRANT_DOMAIN_PATTERN)
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const idSchema = z.string().min(1)

export const ledgerEventSchema = z.enum(["grant", "refresh", "revoke", "sink-ack", "deny"])
export type LedgerEvent = z.infer<typeof ledgerEventSchema>

export const ledgerActorSchema = z
  .object({
    kind: z.enum(["human", "agent", "system"]),
    via: z.string().optional(),
    deviceId: idSchema.optional(),
  })
  .strict()
export type LedgerActor = z.infer<typeof ledgerActorSchema>

export const ledgerRecordSchema = z
  .object({
    seq: z.number().int().min(0),
    at: z.iso.datetime({ offset: true }),
    event: ledgerEventSchema,
    actor: ledgerActorSchema,
    grantId: idSchema.optional(),
    sessionId: idSchema.optional(),
    domains: z.array(domainSchema).optional(),
    fullProfile: z.literal(true).optional(),
    cookieCount: z.number().int().min(0).optional(),
    nameHashes: z.array(sha256Schema).optional(),
    sinkId: z.string().optional(),
    derived: z
      .object({
        local: z.enum(["deleted", "none"]),
        remote: z.enum(["confirmed", "unavailable", "failed", "not-applicable"]),
      })
      .strict()
      .optional(),
    reason: z.string().max(500).optional(),
    prev: sha256Schema.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const need = (field: keyof typeof r): void => {
      if (r[field] === undefined) ctx.addIssue({ code: "custom", message: `${r.event} needs ${field}`, path: [field] })
    }
    if (r.actor.kind === "agent" && (r.event === "grant" || r.event === "sink-ack")) {
      ctx.addIssue({ code: "custom", message: "an agent cannot grant or acknowledge a sink (C7)", path: ["actor", "kind"] })
    }
    if (r.event === "grant") {
      need("grantId")
      need("sessionId")
      need("cookieCount")
      if ((r.domains === undefined) === (r.fullProfile === undefined)) {
        ctx.addIssue({ code: "custom", message: "a grant record has exactly one of domains or fullProfile", path: ["domains"] })
      }
      if (r.domains !== undefined && r.domains.length === 0) {
        ctx.addIssue({ code: "custom", message: "domains must not be empty", path: ["domains"] })
      }
    }
    if (r.event === "refresh") {
      need("grantId")
      need("domains")
      need("cookieCount")
      if (r.domains !== undefined && r.domains.length === 0) {
        ctx.addIssue({ code: "custom", message: "domains must not be empty", path: ["domains"] })
      }
    }
    if (r.event === "revoke") {
      need("grantId")
      need("derived")
    }
    if (r.event === "sink-ack") {
      need("grantId")
      need("sinkId")
      if (r.actor.kind !== "human") ctx.addIssue({ code: "custom", message: "a sink-ack is a human act", path: ["actor", "kind"] })
    }
    if (r.event === "deny") need("reason")
  })

export type LedgerRecord = z.infer<typeof ledgerRecordSchema>

/** A record before the ledger stamps `seq`, `at` and `prev`. */
export type LedgerEntry = Omit<LedgerRecord, "seq" | "at" | "prev">

/** SHA-256 of the grant id, a NUL byte and a cookie name, lowercase hex. Never a value. */
export function cookieNameHash(grantId: string, cookieName: string): string {
  return createHash("sha256").update(grantId).update("\0").update(cookieName).digest("hex")
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

export interface ConsentLedgerOptions {
  /** Ledger file. Default {@link defaultConsentLedgerPath}. */
  path?: string
  now?: () => Date
}

export interface ConsentLedger {
  readonly path: string
  /** Validate, stamp and append one record. One writer process only: concurrent processes can duplicate `seq` and break the chain, which `verifyChain` reports. Throws {@link LedgerRecordInvalidError} and writes nothing on a bad record. */
  append(entry: LedgerEntry): LedgerRecord
  read(): LedgerRecord[]
  /** True when every `prev` matches the SHA-256 of the line before it and `seq` counts up from 0. */
  verifyChain(): boolean
}

const isPosix = process.platform !== "win32"

export function createConsentLedger(opts: ConsentLedgerOptions = {}): ConsentLedger {
  const path = opts.path ?? defaultConsentLedgerPath()
  const now = opts.now ?? ((): Date => new Date())

  const lines = (): string[] => {
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8").split("\n").filter(line => line.length > 0)
  }

  return {
    path,
    append(entry) {
      const existing = lines()
      const last = existing[existing.length - 1]
      const candidate = {
        ...entry,
        seq: existing.length,
        at: now().toISOString(),
        ...(last !== undefined ? { prev: sha256(last) } : {}),
      }
      const parsed = ledgerRecordSchema.safeParse(candidate)
      if (!parsed.success) {
        throw new LedgerRecordInvalidError(parsed.error.issues.map(i => `${i.path.join(".") || "(record)"}: ${i.message}`))
      }
      // JSON.stringify of the input keeps key order stable for the prev hash of the next line.
      const line = JSON.stringify(candidate)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      appendFileSync(path, `${line}\n`, { mode: 0o600 })
      if (isPosix && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
      return parsed.data
    },
    read() {
      return lines().map(line => ledgerRecordSchema.parse(JSON.parse(line)))
    },
    verifyChain() {
      const rows = lines()
      let prevLine: string | undefined
      for (const [i, line] of rows.entries()) {
        const rec = ledgerRecordSchema.safeParse(JSON.parse(line))
        if (!rec.success || rec.data.seq !== i) return false
        if (prevLine !== undefined && rec.data.prev !== sha256(prevLine)) return false
        prevLine = line
      }
      return true
    },
  }
}
