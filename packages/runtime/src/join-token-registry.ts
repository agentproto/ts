/**
 * Daemon-side JOIN TOKEN registry (SANDBOX-VISIBILITY-JOIN, stacked on
 * DEVICES-PLAN PR-C's `host-registry.ts`).
 *
 * `host-registry.ts`'s `add()` requires a HUMAN to relay a host-scoped offer
 * URL from the box to this daemon (`agentproto pair offer --host` on the box,
 * `agentproto devices add <url>` here) — fine for a laptop, impossible for an
 * unattended CI sandbox with no one watching its logs to copy a one-time,
 * 10-minute-TTL secret. A join token flips who initiates: this daemon mints a
 * long-lived, revocable, reusable credential ahead of time (stored as a
 * GitHub secret, say); a box started with `AGENTPROTO_JOIN=<token>` dials
 * in — over the SAME rendezvous/pair-v2 primitives, no protocol change — and
 * this daemon adds it as a host automatically.
 *
 * ## Why this isn't just a long-lived `host-registry.ts` offer
 *
 * pair/v2 deliberately gives a CLIENT no persistent identity key (see
 * `pairing-registry.ts`'s "Reconnect authentication" doc) — only the
 * DAEMON/offerer side has stable keys a peer can pin and re-dial later.
 * `HostRegistry.forwardHttp` needs exactly those stable keys to reach a host
 * on demand, so the box MUST end up as the offerer of its own host-scoped
 * offer (a normal, single-use `pair offer --host`) with THIS daemon
 * `add()`-ing it — `host-registry.ts` is not touched by this module at all.
 *
 * What the join token replaces is only the relay step: this daemon parks a
 * STANDING accept loop (`side=daemon`, exactly like a `pair offer`'s park,
 * except never single-use) on a route deterministically derived from the
 * token's own secret. A box holding the token dials that route as the
 * CLIENT — the role a browser/CLI plays consuming a normal offer — and its
 * sealed hello's `clientName` carries a small JSON envelope: the box's own
 * self-minted host-scoped offer URL (freshly created, in-process, via its
 * own `PairingRegistry.createOffer({scope:"host"})` — see
 * `packages/cli/src/commands/serve.ts`'s `AGENTPROTO_JOIN` boot wiring) plus
 * a self-reported name/provider/sandboxId/labels. On receipt, this daemon
 * just calls `HostRegistry.add(offerUrl, name, meta)` — the exact call a
 * human would type — closes the bootstrap channel, and re-parks for the next
 * box. No new wire messages, no new crypto: two ordinary pair/v2 handshakes
 * back to back, the first only ever used to carry one string.
 *
 * ## Reuse and revocation
 *
 * Unlike an `OfferEntry` (`pairing-registry.ts`), a join token's
 * `{route, auth}` never rotates and is never "spent" — `useCount`/`maxUses`/
 * `expiresAt`/`revokedAt` (all checked inside `verifyAuthToken`, which may be
 * async) gate reuse instead. This is the same trust shape as an existing
 * epoch reconnect token (valid, unrotated, for its whole day) stretched over
 * a longer, explicit, revocable window — not a new security primitive.
 *
 * ## A known limitation
 *
 * One token parks on exactly one fixed route, so exactly one box can be
 * mid-handshake on it at a time; a second box dialing in the same instant
 * either waits for the loop to re-park (typical: the ceremony is a single
 * short-TTL round trip) or, in the worst case, times out and retries with
 * backoff. Fine for the sequential-CI-review case this exists for; a fleet
 * of concurrently-joining boxes would want multiple parked slots per token,
 * deferred (see PR body).
 *
 * Persisted to `~/.agentproto/join-tokens.json`, same atomic-write + lazy-
 * load discipline as `hosts.json`/`pairings.json`. The raw `secret` — not a
 * hash — is stored, exactly like `pairings.json` stores `pairRoot` in the
 * clear: it is crypto material this daemon must re-derive `{route, auth}`
 * from on every boot, not a password to be hashed.
 */

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, basename } from "node:path"
import { daemonHandshakeOverSink, type FrameSink, type E2eFrameSink } from "@agentproto/acp/tunnel"
import {
  decodePairingHello,
  encodePairingMessage,
  respondToHandshake,
  deriveOfferTokens,
  encodeOfferUrl,
  HOSTED_RENDEZVOUS_URL,
  OFFER_VERSION,
  type PairingSession,
} from "@agentproto/secrets/pairing"
import { identityFingerprint, type DaemonIdentity } from "@agentproto/secrets/identity"
import type { HostJoinMeta } from "./host-registry.js"

/** `join-tokens.json` format. */
export const JOIN_TOKENS_VERSION = 1 as const

const DEFAULT_TTL_MS = 90 * 86_400_000 // 90 days
const DEFAULT_RECONNECT_MIN_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 30_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 110_000

/** One persisted join token. `secret` is the crypto material a box's
 *  `AGENTPROTO_JOIN` value carries too — never log or echo it once minted. */
export interface JoinTokenRecord {
  /** Short random id (CLI/MCP target), distinct from `secret`. */
  id: string
  /** Human-facing label (e.g. "ci-reviewer"). */
  name: string
  /** One-time-offer-shaped secret (base64url) — re-derives `{route, auth}`
   *  via `deriveOfferTokens`. Never rotates for this token's lifetime. */
  secret: string
  /** Rendezvous endpoint boxes dial through. */
  rendezvousUrl: string
  /** ISO-8601 mint time. */
  createdAt: string
  /** ISO-8601 expiry — always set (`create()` defaults `ttlMs`). */
  expiresAt: string
  /** Reuse ceiling. Absent = unlimited (until `expiresAt`/revoke). */
  maxUses?: number
  /** Successful joins so far. */
  useCount: number
  /** ISO-8601 of the most recent successful join. */
  lastUsedAt?: string
  /** ISO-8601 revoke time. Present ⇒ inactive; kept for `list()` history. */
  revokedAt?: string
  /**
   * A joined box's `useCount` bumps unconditionally (it only reflects that
   * the AUTH TOKEN was valid), but turning that join into a visible device
   * is a SEPARATE, later step — `deps.addHost` dialing back into the box's
   * self-minted offer, a second full pair/v2 round trip. That step can fail
   * (the box's 60s-TTL self-offer expiring before the home daemon gets to
   * it, the box already tearing down, a broker hiccup) without `useCount`
   * ever reflecting it — which is exactly how PR #1536's run 36438398607
   * went unnoticed: `useCount: 2`, one visible device, no error anywhere a
   * human would look. Set on the most recent failed `addHost` call, cleared
   * on the next SUCCESSFUL one, so `join_token_list` always shows whether
   * the box currently backing `useCount` actually made it into `device_list`.
   */
  lastJoinError?: string
  /** ISO-8601 of `lastJoinError`. */
  lastJoinErrorAt?: string
}

interface JoinTokensFile {
  v: typeof JOIN_TOKENS_VERSION
  tokens: JoinTokenRecord[]
}

export interface CreateJoinTokenInput {
  name: string
  /** Time-to-live in ms. Default 90 days. */
  ttlMs?: number
  /** Reuse ceiling. Absent = unlimited. */
  maxUses?: number
  /** Rendezvous URL override; falls back to the configured default. */
  rendezvousUrl?: string
}

export interface CreatedJoinToken {
  id: string
  name: string
  /** The `AGENTPROTO_JOIN` value — an `agentproto://pair?…&scope=host` URL.
   *  Shown ONCE; `list()` never returns it. */
  token: string
  rendezvousUrl: string
  expiresAt: string
}

export interface JoinTokenRegistryDeps {
  /** Lazily load (create on first use) the daemon identity — same contract
   *  as `PairingRegistryDeps.loadIdentity`. */
  loadIdentity: () => Promise<DaemonIdentity>
  /** Path to `join-tokens.json`. Defaults to `~/.agentproto/join-tokens.json`. */
  joinTokensPath?: string
  /** Configured rendezvous URL default — same three-state contract as
   *  `PairingRegistryDeps.defaultRendezvousUrl` (absent → hosted default;
   *  `""` → explicit opt-out, fails closed without `--rendezvous`). */
  defaultRendezvousUrl?: string
  /** Dial a rendezvous WS and adapt it to a `FrameSink`. Same shape as
   *  `PairingRegistryDeps.dial`/`HostRegistryDeps.dial`. */
  dial: (wsUrl: string, signal: AbortSignal) => Promise<FrameSink>
  /** Called once per successful join, with the box's self-minted host offer
   *  URL and self-reported name/meta — normally `hostRegistry.add`. Errors
   *  are logged and swallowed: a bad/unreachable offer from one join must not
   *  crash the standing accept loop. */
  addHost: (offerUrl: string, name?: string, meta?: HostJoinMeta) => Promise<unknown>
  /** Called when a joined box says goodbye just before it exits (see
   *  `JoinHello.goodbye`), with its daemon fingerprint — normally
   *  `hostRegistry.snapshotNow`, so the box's final session output is captured
   *  while it can still answer. The box waits for this to settle (bounded on
   *  its side), so it should not hang. Errors are logged and swallowed. */
  flushHost?: (fingerprint: string) => Promise<unknown>
  /** Called after the goodbye's final capture (even if it failed), with the
   *  same fingerprint — normally `hostRegistry.markEnded`, so a departed CI
   *  box stops reading as a live host immediately. Errors are logged and
   *  swallowed. */
  endHost?: (fingerprint: string) => Promise<unknown>
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number
  /** Diagnostic log sink. */
  log?: (line: string) => void
  /** Handshake ceiling per attempt. Default 110s (mirrors PairingRegistry's
   *  park timeout, kept just under the broker's own). */
  handshakeTimeoutMs?: number
  /** Reconnect backoff floor / ceiling (ms) after a failed dial. Defaults 1s/30s. */
  reconnectMinMs?: number
  reconnectMaxMs?: number
}

export interface JoinTokenRegistry {
  /** Mint a token and start its standing accept loop. */
  create(input: CreateJoinTokenInput): Promise<CreatedJoinToken>
  /** All persisted tokens (copies), `secret` stripped. Loads on first call. */
  list(): Promise<Omit<JoinTokenRecord, "secret">[]>
  /** Revoke by id or name — stops its accept loop. Returns false if nothing
   *  matched or it was already revoked. */
  revoke(idOrName: string): Promise<boolean>
  /** Start standing accept loops for every active persisted token. Call once
   *  at boot, after the gateway/hostRegistry are wired. */
  startAutoconnect(): Promise<void>
  /** Tear down every accept loop. */
  shutdown(): Promise<void>
}

function defaultJoinTokensPath(): string {
  return join(homedir(), ".agentproto", "join-tokens.json")
}

function b64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function constantTimeEqual(a: string, b: string): boolean {
  const key = randomBytes(32)
  const da = createHmac("sha256", key).update(a, "utf8").digest()
  const db = createHmac("sha256", key).update(b, "utf8").digest()
  return timingSafeEqual(da, db)
}

function dialUrl(rendezvousUrl: string, route: string): string {
  const sep = rendezvousUrl.includes("?") ? "&" : "?"
  return `${rendezvousUrl}${sep}side=daemon&t=${encodeURIComponent(route)}`
}

/** The JSON envelope a joining box's sealed hello carries in `clientName`
 *  (see `packages/cli/src/commands/serve.ts`'s `AGENTPROTO_JOIN` boot code —
 *  the two must agree on this shape). */
interface JoinHello {
  offerUrl?: unknown
  name?: unknown
  provider?: unknown
  sandboxId?: unknown
  labels?: unknown
  /** Set by a box that is about to exit: the join is NOT a new registration
   *  (no `offerUrl`, the use isn't counted) — capture the host named by
   *  `fingerprint` one last time, then close. */
  goodbye?: unknown
  fingerprint?: unknown
}

function parseJoinHello(clientName: string | undefined): JoinHello | null {
  if (!clientName) return null
  try {
    const parsed: unknown = JSON.parse(clientName)
    if (typeof parsed !== "object" || parsed === null) return null
    return parsed as JoinHello
  } catch {
    return null
  }
}

function isPlainStringRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  return Object.values(v).every(x => typeof x === "string")
}

interface AcceptLoop {
  abort: AbortController
  done: Promise<void>
}

export function createJoinTokenRegistry(deps: JoinTokenRegistryDeps): JoinTokenRegistry {
  const joinTokensPath = deps.joinTokensPath ?? defaultJoinTokensPath()
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const reconnectMinMs = deps.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS
  const reconnectMaxMs = deps.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS

  /** id → record. Source of truth in memory; disk is the mirror. */
  const tokens = new Map<string, JoinTokenRecord>()
  const loops = new Map<string, AcceptLoop>()

  let loaded = false
  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    loaded = true
    try {
      const raw = await readFile(joinTokensPath, "utf8")
      const parsed: unknown = JSON.parse(raw)
      if (isJoinTokensFile(parsed)) {
        for (const rec of parsed.tokens) tokens.set(rec.id, rec)
      } else {
        log(`[join-tokens] ignoring ${joinTokensPath}: unrecognised format`)
      }
    } catch (err) {
      if (!isEnoent(err)) log(`[join-tokens] could not read ${joinTokensPath}: ${errMsg(err)}`)
    }
  }

  let persistChain: Promise<void> = Promise.resolve()
  function persist(): Promise<void> {
    const run = persistChain.then(doPersist)
    persistChain = run.catch(() => {})
    return run
  }
  async function doPersist(): Promise<void> {
    const file: JoinTokensFile = { v: JOIN_TOKENS_VERSION, tokens: Array.from(tokens.values()) }
    const dir = dirname(joinTokensPath)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${basename(joinTokensPath)}.tmp-${process.pid}`)
    await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, joinTokensPath)
  }

  function findToken(idOrName: string): JoinTokenRecord | undefined {
    const byId = tokens.get(idOrName)
    if (byId) return byId
    for (const rec of tokens.values()) if (rec.name === idOrName) return rec
    return undefined
  }

  /** Active = persisted, not revoked, not past `expiresAt`, under `maxUses`
   *  (if set). Checked fresh on every handshake attempt AND at the top of
   *  every loop iteration (an expired/revoked/exhausted token just stops
   *  re-parking). */
  function isActive(rec: JoinTokenRecord): boolean {
    if (rec.revokedAt) return false
    if (Date.parse(rec.expiresAt) <= now()) return false
    if (rec.maxUses !== undefined && rec.useCount >= rec.maxUses) return false
    return true
  }

  function resolveRendezvousUrl(explicit?: string): string {
    if (explicit) return explicit
    if (deps.defaultRendezvousUrl !== undefined) {
      if (deps.defaultRendezvousUrl === "") {
        throw new Error(
          'rendezvous disabled — pairing.rendezvous is set to "" (explicit opt-out); ' +
            "pass an explicit rendezvousUrl to mint a join token through a specific broker",
        )
      }
      return deps.defaultRendezvousUrl
    }
    return HOSTED_RENDEZVOUS_URL
  }

  async function create(input: CreateJoinTokenInput): Promise<CreatedJoinToken> {
    await ensureLoaded()
    const trimmedName = input.name.trim()
    if (!trimmedName) throw new Error("join token name must not be empty")
    const rendezvousUrl = resolveRendezvousUrl(input.rendezvousUrl)
    const identity = await deps.loadIdentity()
    const secret = b64url(randomBytes(16))
    const id = randomBytes(6).toString("hex")
    const nowIso = new Date(now()).toISOString()
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
    const expiresAt = new Date(now() + ttlMs).toISOString()

    const record: JoinTokenRecord = {
      id,
      name: trimmedName,
      secret,
      rendezvousUrl,
      createdAt: nowIso,
      expiresAt,
      useCount: 0,
      ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
    }
    tokens.set(id, record)
    await persist()
    startAcceptLoop(record)

    const fingerprint = await identityFingerprint(identity.x25519.pub)
    const url = encodeOfferUrl({
      v: OFFER_VERSION,
      rendezvousUrl,
      fingerprint,
      daemonX25519Pub: identity.x25519.pub,
      daemonEd25519Pub: identity.ed25519.pub,
      secret,
      exp: Math.floor(Date.parse(expiresAt) / 1000),
      scope: "host",
    })
    log(`[join-tokens] created "${trimmedName}" (id ${id}, exp ${expiresAt})`)
    return { id, name: trimmedName, token: url, rendezvousUrl, expiresAt }
  }

  async function list(): Promise<Omit<JoinTokenRecord, "secret">[]> {
    await ensureLoaded()
    return Array.from(tokens.values()).map(({ secret: _secret, ...rest }) => ({ ...rest }))
  }

  async function revoke(idOrName: string): Promise<boolean> {
    await ensureLoaded()
    const target = findToken(idOrName)
    if (!target || target.revokedAt) return false
    target.revokedAt = new Date(now()).toISOString()
    await persist()
    await stopLoop(target.id)
    log(`[join-tokens] revoked "${target.name}" (id ${target.id})`)
    return true
  }

  function startAcceptLoop(record: JoinTokenRecord): void {
    if (!isActive(record) || loops.has(record.id)) return
    const abort = new AbortController()
    const done = runAcceptLoop(record, abort.signal).catch(err => {
      log(`[join-tokens] accept loop for "${record.name}" ended: ${errMsg(err)}`)
    })
    loops.set(record.id, { abort, done })
  }

  async function stopLoop(id: string): Promise<void> {
    const loop = loops.get(id)
    if (!loop) return
    loops.delete(id)
    loop.abort.abort()
    await loop.done.catch(() => {})
  }

  async function handleJoined(
    session: PairingSession,
    record: JoinTokenRecord,
    prevLastUsedAt: string | undefined,
  ): Promise<void> {
    const hello = parseJoinHello(session.clientName)
    if (hello?.goodbye === true) {
      // A goodbye is bookkeeping, not a join: give back the use the auth
      // check consumed so it can't exhaust `maxUses` or fake `lastUsedAt`.
      record.useCount = Math.max(0, record.useCount - 1)
      if (prevLastUsedAt === undefined) delete record.lastUsedAt
      else record.lastUsedAt = prevLastUsedAt
      await persist()
      if (typeof hello.fingerprint === "string" && hello.fingerprint && deps.flushHost) {
        try {
          await deps.flushHost(hello.fingerprint)
          log(`[join-tokens] "${record.name}": final snapshot taken for ${hello.fingerprint} (goodbye)`)
        } catch (err) {
          log(`[join-tokens] "${record.name}": final snapshot for ${hello.fingerprint} failed: ${errMsg(err)}`)
        }
      }
      if (typeof hello.fingerprint === "string" && hello.fingerprint && deps.endHost) {
        try {
          await deps.endHost(hello.fingerprint)
        } catch (err) {
          log(`[join-tokens] "${record.name}": marking ${hello.fingerprint} ended failed: ${errMsg(err)}`)
        }
      }
      return
    }
    if (!hello || typeof hello.offerUrl !== "string" || !hello.offerUrl) {
      log(`[join-tokens] "${record.name}": joined box sent no self-offer — nothing added`)
      return
    }
    const meta: HostJoinMeta = {
      joined: true,
      ...(typeof hello.provider === "string" && hello.provider ? { provider: hello.provider } : {}),
      ...(typeof hello.sandboxId === "string" && hello.sandboxId ? { sandboxId: hello.sandboxId } : {}),
      ...(isPlainStringRecord(hello.labels) ? { labels: hello.labels } : {}),
    }
    // A box doesn't know the join token's own name (only this daemon does),
    // so a CI box that doesn't self-report AGENTPROTO_JOIN_NAME (see
    // ci.yml — it deliberately doesn't set one) still ends up as more than
    // a raw fingerprint in `device_list`: "<token name> #<pr>" when the
    // self-reported labels carry a `pr` (the common case this exists for),
    // falling back to just the token name otherwise.
    const name =
      typeof hello.name === "string" && hello.name
        ? hello.name
        : meta.labels?.["pr"]
          ? `${record.name} #${meta.labels["pr"]}`
          : record.name
    try {
      await deps.addHost(hello.offerUrl, name, meta)
      log(`[join-tokens] "${record.name}": added host via join (self-reported name "${name ?? "(none)"}")`)
      if (record.lastJoinError !== undefined || record.lastJoinErrorAt !== undefined) {
        delete record.lastJoinError
        delete record.lastJoinErrorAt
        await persist()
      }
    } catch (err) {
      const message = errMsg(err)
      log(
        `[join-tokens] "${record.name}": ADDING THE JOINED BOX AS A HOST FAILED (useCount bumped, no ` +
          `device recorded — visible via join_token_list until the next successful join): ${message}`,
      )
      record.lastJoinError = message
      record.lastJoinErrorAt = new Date(now()).toISOString()
      await persist()
    }
  }

  async function runAcceptLoop(record: JoinTokenRecord, signal: AbortSignal): Promise<void> {
    const { route, auth } = await deriveOfferTokens(record.secret)
    let backoff = reconnectMinMs
    while (!signal.aborted && isActive(record)) {
      let sink: FrameSink
      try {
        sink = await deps.dial(dialUrl(record.rendezvousUrl, route), signal)
      } catch (err) {
        if (signal.aborted) break
        log(`[join-tokens] "${record.name}": dial failed: ${errMsg(err)}`)
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, reconnectMaxMs)
        continue
      }
      if (!sink.isOpen) {
        if (signal.aborted) break
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, reconnectMaxMs)
        continue
      }
      backoff = reconnectMinMs

      let capturedSession: PairingSession | null = null
      let prevLastUsedAt: string | undefined
      let wrapped: E2eFrameSink
      try {
        const identity = await deps.loadIdentity()
        wrapped = await daemonHandshakeOverSink(
          sink,
          async helloBytes => {
            const hello = decodePairingHello(helloBytes)
            const result = await respondToHandshake(hello, {
              identity,
              verifyAuthToken: async presented => {
                if (!constantTimeEqual(presented, auth)) return false
                // Re-check freshness at the moment of proof, not just at loop
                // start — a token can expire/exhaust/be revoked between
                // iterations. Consume the use here (not after) so a wrong
                // token never counts against maxUses.
                if (!isActive(record)) return false
                prevLastUsedAt = record.lastUsedAt
                record.useCount += 1
                record.lastUsedAt = new Date(now()).toISOString()
                await persist()
                return true
              },
            })
            capturedSession = result.session
            return { reply: encodePairingMessage(result.reply), keys: result.session }
          },
          { timeoutMs: handshakeTimeoutMs },
        )
      } catch (err) {
        if (signal.aborted) break
        log(`[join-tokens] "${record.name}": handshake failed: ${errMsg(err)}`)
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, reconnectMaxMs)
        continue
      }

      if (capturedSession) {
        await handleJoined(capturedSession, record, prevLastUsedAt)
      }
      wrapped.close("join complete")
      // Reusable by design: loop straight back to re-parking for the next box.
    }
  }

  async function startAutoconnect(): Promise<void> {
    await ensureLoaded()
    let started = 0
    for (const record of tokens.values()) {
      if (isActive(record)) {
        startAcceptLoop(record)
        started++
      }
    }
    if (started > 0) log(`[join-tokens] autoconnect: standing accept loop(s) for ${started} token(s)`)
  }

  async function shutdown(): Promise<void> {
    for (const id of Array.from(loops.keys())) await stopLoop(id)
  }

  return { create, list, revoke, startAutoconnect, shutdown }
}

// ── helpers ────────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === "function") timer.unref()
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function isJoinTokensFile(v: unknown): v is JoinTokensFile {
  if (typeof v !== "object" || v === null) return false
  const rec = v as Record<string, unknown>
  if (rec["v"] !== JOIN_TOKENS_VERSION) return false
  if (!Array.isArray(rec["tokens"])) return false
  return rec["tokens"].every(isJoinTokenRecord)
}

function isJoinTokenRecord(v: unknown): v is JoinTokenRecord {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r["id"] === "string" &&
    typeof r["name"] === "string" &&
    typeof r["secret"] === "string" &&
    typeof r["rendezvousUrl"] === "string" &&
    typeof r["createdAt"] === "string" &&
    typeof r["expiresAt"] === "string" &&
    typeof r["useCount"] === "number"
  )
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT"
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
