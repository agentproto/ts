/**
 * Signed, single-use MRTR replay state tokens (`requestState`) for MCP 2026-07-28.
 *
 * Durability is explicit per surface:
 * - Durable surfaces (`approval`, `run-input`) persist consumed nonces on disk
 *   under `~/.agentproto/mcp-mrtr/` (mode 0600) so tokens survive restarts.
 * - In-memory surfaces (`permission`, `question`) bind each token to the current
 *   daemon `bootId`; a token replayed after a restart fails deterministically
 *   with `input_unavailable` rather than pretending the parked entity still exists.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type MrtrEntityKind = "permission" | "approval" | "question" | "run-input"

/** Every kind a token may carry; a signed token naming another kind is refused by the store. */
export const KNOWN_MRTR_KINDS: ReadonlySet<MrtrEntityKind> = new Set(["permission", "approval", "question", "run-input"])

export const DURABLE_MRTR_KINDS: ReadonlySet<MrtrEntityKind> = new Set(["approval", "run-input"])
export const DEFAULT_MRTR_TTL_MS = 10 * 60 * 1000 // 10 minutes
export const MAX_CONSUMED_NONCES = 4096

export interface MrtrState {
  v: 1
  kind: MrtrEntityKind
  entityId: string
  /** Optional key inside `inputRequests` that corresponds to this state. */
  requestKey?: string
  /** Resolved caller session id (absent for the operator). */
  callerSessionId?: string
  /** Original MCP tool name (for `tools/call`) or method. */
  tool: string
  /** Canonical SHA-256 of the original request arguments (excluding `_meta`, `requestState`, `inputResponses`). */
  argsHash: string
  issuedAt: string
  expiresAt: string
  /** Single-use random hex nonce (128 bits), consumed atomically on replay. */
  nonce: string
  /** Daemon boot id for volatile (in-memory) surfaces. */
  bootId?: string
}

interface HmacKeyEntry {
  kid: string
  key: string // base64 32 bytes
  createdAt: string
}

interface HmacKeyFile {
  v: 1
  current: HmacKeyEntry
  previous?: HmacKeyEntry
}

interface ConsumedNonceRecord {
  expiresAt: number
}

interface NonceLedgerFile {
  v: 1
  consumed: Record<string, ConsumedNonceRecord>
}

export type MrtrVerifyFailureReason =
  | "malformed"
  | "invalid_signature"
  | "expired"
  | "replayed"
  | "mismatch"
  | "input_unavailable"
  | "unsupported_kind"

export type MrtrVerifyResult =
  | { ok: true; state: MrtrState }
  | { ok: false; reason: MrtrVerifyFailureReason; message: string }

export interface MrtrMintInput {
  kind: MrtrEntityKind
  entityId: string
  requestKey?: string
  callerSessionId?: string
  tool: string
  argsHash: string
  ttlMs?: number
}

export interface MrtrVerifyExpected {
  tool: string
  argsHash: string
  callerSessionId?: string
}

export interface MrtrStateStore {
  readonly bootId: string
  mint(input: MrtrMintInput): string
  verifyAndConsume(token: string, expected: MrtrVerifyExpected): MrtrVerifyResult
  rotateKey(): void
}

export interface MrtrStateStoreOptions {
  /** Directory storing `hmac-key.json` and `nonces.json` (mode 0600). Defaults to `~/.agentproto/mcp-mrtr`. */
  dir?: string
  /** Override boot id (tests simulate restarts by creating a second store on the same `dir`). */
  bootId?: string
  /** Injectable clock for deterministic TTL tests. */
  now?: () => number
  /** Default TTL for newly minted tokens (ms). */
  defaultTtlMs?: number
}

export function defaultMrtrStateDir(): string {
  return join(homedir(), ".agentproto", "mcp-mrtr")
}

/** Deterministic sorted-key JSON serialization for canonical argument hashing. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

/** Canonical SHA-256 over the original tool call arguments (excluding MRTR and handshake metadata). */
export function canonicalArgsHash(params: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (k === "_meta" || k === "requestState" || k === "inputResponses") continue
    cleaned[k] = v
  }
  return createHash("sha256").update(canonicalJson(cleaned), "utf8").digest("hex")
}

function atomicWriteJson0600(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  renameSync(tmp, filePath)
}

function generateKeyEntry(nowMs: number): HmacKeyEntry {
  return {
    kid: randomBytes(6).toString("hex"),
    key: randomBytes(32).toString("base64"),
    createdAt: new Date(nowMs).toISOString(),
  }
}

function loadOrCreateKeys(keyPath: string, nowMs: number): HmacKeyFile {
  if (existsSync(keyPath)) {
    try {
      const parsed = JSON.parse(readFileSync(keyPath, "utf8")) as Partial<HmacKeyFile>
      if (parsed.v === 1 && parsed.current?.kid && parsed.current?.key) {
        return {
          v: 1,
          current: parsed.current,
          ...(parsed.previous?.kid && parsed.previous?.key ? { previous: parsed.previous } : {}),
        }
      }
    } catch {
      // Fall through and regenerate a fresh key file.
    }
  }
  const fresh: HmacKeyFile = { v: 1, current: generateKeyEntry(nowMs) }
  atomicWriteJson0600(keyPath, fresh)
  return fresh
}

function loadNonces(noncePath: string, nowMs: number): Map<string, number> {
  const map = new Map<string, number>()
  if (!existsSync(noncePath)) return map
  try {
    const parsed = JSON.parse(readFileSync(noncePath, "utf8")) as Partial<NonceLedgerFile>
    if (parsed.v === 1 && parsed.consumed && typeof parsed.consumed === "object") {
      for (const [nonce, rec] of Object.entries(parsed.consumed)) {
        if (rec && typeof rec.expiresAt === "number" && rec.expiresAt > nowMs) {
          map.set(nonce, rec.expiresAt)
        }
      }
    }
  } catch {
    // Ignore corrupted nonce ledger; start clean.
  }
  return map
}

function signPayload(kid: string, encodedPayload: string, keyBase64: string): string {
  const keyBuf = Buffer.from(keyBase64, "base64")
  return createHmac("sha256", keyBuf).update(`v1.${kid}.${encodedPayload}`, "utf8").digest("base64url")
}

export function createMrtrStateStore(opts: MrtrStateStoreOptions = {}): MrtrStateStore {
  const dir = opts.dir ?? defaultMrtrStateDir()
  const now = opts.now ?? (() => Date.now())
  const defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_MRTR_TTL_MS
  const bootId = opts.bootId ?? randomBytes(12).toString("hex")

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const keyPath = join(dir, "hmac-key.json")
  const noncePath = join(dir, "nonces.json")

  let keys = loadOrCreateKeys(keyPath, now())
  const durableConsumed = loadNonces(noncePath, now())
  const volatileConsumed = new Map<string, number>()

  const pruneMap = (map: Map<string, number>, nowMs: number): void => {
    for (const [nonce, exp] of map) {
      if (exp <= nowMs) map.delete(nonce)
    }
    while (map.size > MAX_CONSUMED_NONCES) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  const persistDurableNonces = (): void => {
    const consumed: Record<string, ConsumedNonceRecord> = {}
    for (const [nonce, expiresAt] of durableConsumed) {
      consumed[nonce] = { expiresAt }
    }
    atomicWriteJson0600(noncePath, { v: 1, consumed } satisfies NonceLedgerFile)
  }

  return {
    bootId,

    rotateKey(): void {
      const nowMs = now()
      keys = {
        v: 1,
        current: generateKeyEntry(nowMs),
        previous: keys.current,
      }
      atomicWriteJson0600(keyPath, keys)
    },

    mint(input: MrtrMintInput): string {
      const nowMs = now()
      const ttlMs = Math.max(1000, input.ttlMs ?? defaultTtlMs)
      const state: MrtrState = {
        v: 1,
        kind: input.kind,
        entityId: input.entityId,
        ...(input.requestKey !== undefined ? { requestKey: input.requestKey } : {}),
        ...(input.callerSessionId !== undefined ? { callerSessionId: input.callerSessionId } : {}),
        tool: input.tool,
        argsHash: input.argsHash,
        issuedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
        nonce: randomBytes(16).toString("hex"),
        ...(!DURABLE_MRTR_KINDS.has(input.kind) ? { bootId } : {}),
      }
      const encodedPayload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url")
      const sig = signPayload(keys.current.kid, encodedPayload, keys.current.key)
      return `v1.${keys.current.kid}.${encodedPayload}.${sig}`
    },

    verifyAndConsume(token: string, expected: MrtrVerifyExpected): MrtrVerifyResult {
      if (typeof token !== "string" || token.length === 0 || token.length > 8192) {
        return { ok: false, reason: "malformed", message: "Invalid requestState token" }
      }
      const parts = token.split(".")
      if (parts.length !== 4 || parts[0] !== "v1") {
        return { ok: false, reason: "malformed", message: "Invalid requestState token format" }
      }
      const [, kid, encodedPayload, presentedSig] = parts
      if (!kid || !encodedPayload || !presentedSig) {
        return { ok: false, reason: "malformed", message: "Invalid requestState token segments" }
      }

      const keyEntry =
        keys.current.kid === kid ? keys.current : keys.previous?.kid === kid ? keys.previous : undefined
      if (!keyEntry) {
        return { ok: false, reason: "invalid_signature", message: "Unrecognized requestState key" }
      }
      const expectedSig = signPayload(kid, encodedPayload, keyEntry.key)
      const gotBuf = Buffer.from(presentedSig, "utf8")
      const wantBuf = Buffer.from(expectedSig, "utf8")
      if (gotBuf.length !== wantBuf.length || !timingSafeEqual(gotBuf, wantBuf)) {
        return { ok: false, reason: "invalid_signature", message: "Invalid requestState signature" }
      }

      let state: MrtrState
      try {
        const parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<MrtrState>
        if (
          parsed.v !== 1 ||
          typeof parsed.kind !== "string" ||
          typeof parsed.entityId !== "string" ||
          typeof parsed.tool !== "string" ||
          typeof parsed.argsHash !== "string" ||
          typeof parsed.expiresAt !== "string" ||
          typeof parsed.nonce !== "string"
        ) {
          return { ok: false, reason: "malformed", message: "Malformed requestState payload" }
        }
        state = parsed as MrtrState
      } catch {
        return { ok: false, reason: "malformed", message: "Unparsable requestState payload" }
      }
      // Defence in depth: the gate refuses an unknown kind too, but the store must not hand one out.
      if (!KNOWN_MRTR_KINDS.has(state.kind)) {
        return { ok: false, reason: "unsupported_kind", message: "requestState names an unsupported kind" }
      }

      const nowMs = now()
      const expiresMs = Date.parse(state.expiresAt)
      if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
        return { ok: false, reason: "expired", message: "requestState token has expired" }
      }

      // Bind caller identity, tool, and arguments before revealing anything about the entity.
      if (
        state.tool !== expected.tool ||
        state.argsHash !== expected.argsHash ||
        state.callerSessionId !== expected.callerSessionId
      ) {
        return { ok: false, reason: "mismatch", message: "requestState does not match this request" }
      }

      // Volatile surfaces (permission/question) cannot resume across a daemon restart.
      if (!DURABLE_MRTR_KINDS.has(state.kind) && state.bootId !== bootId) {
        return {
          ok: false,
          reason: "input_unavailable",
          message: "Input state is no longer available after host restart",
        }
      }

      // Atomic synchronous single-use nonce consumption.
      const store = DURABLE_MRTR_KINDS.has(state.kind) ? durableConsumed : volatileConsumed
      pruneMap(store, nowMs)
      if (store.has(state.nonce)) {
        return { ok: false, reason: "replayed", message: "requestState token has already been used" }
      }
      store.set(state.nonce, expiresMs)
      if (DURABLE_MRTR_KINDS.has(state.kind)) {
        persistDurableNonces()
      }

      return { ok: true, state }
    },
  }
}
