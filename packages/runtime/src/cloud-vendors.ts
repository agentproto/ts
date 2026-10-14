/**
 * AIP-66 managed cloud agents — the vendor registry and the pure spawn
 * resolver. A `cloud` spawn names a vendor slug; the vendor owns the
 * machine and the harness, and the host relays through the vendor's
 * adapter (`cloud:<vendor>` → adapter). This module is the single source
 * of that binding: adding a second vendor (codex) is one registry entry.
 *
 * `resolveCloudSpawn` is PURE and refuses BEFORE any side effect
 * (AIP-66 §2/§4): an unknown vendor never falls back to a default, and
 * every field the vendor can never apply (`sandbox`, `worktree`,
 * `commandSandbox`, `mcpServers`, `daemonMount`, `bundles`, `browser`,
 * `appServe`, `inference`) is refused by name rather than silently
 * dropped. Session identity (`meta.cloud = { vendor, sessionId, url }`,
 * AIP-66 §5) is persisted through the helpers at the bottom: the relay
 * reports the vendor session id by writing a meta file inside the
 * session's isolated config dir (path handed to the adapter via
 * `CLOUD_SESSION_META_FILE_ENV`), and the runtime re-attaches by passing
 * that vendor id back through the ordinary ACP `session/load` resume
 * path. The vendor's OAuth credential NEVER enters this file, `meta`,
 * logs or events (AIP-66 §8).
 */

import { join } from "node:path"
import { readFile } from "node:fs/promises"

/** One managed cloud vendor: the harnesses it runs and the adapter that
 *  relays to it (AIP-66 §2 `CloudVendor`). */
export interface CloudVendor {
  /** Vendor slug as spelled in `agent_start.cloud` (e.g. "anthropic"). */
  readonly slug: string
  /** Harnesses the vendor runs; a spawn `adapter`/`harness` must name one
   *  of these (or the relay adapter itself) or the spawn is refused. */
  readonly harnesses: readonly string[]
  /** First-party adapter slug that relays to the vendor's sessions. */
  readonly adapter: string
}

/**
 * The vendor registry. Adding codex later is ONE entry here — nothing
 * else in this module or the spawn path needs to change.
 */
export const CLOUD_VENDORS: Readonly<Record<string, CloudVendor>> = {
  anthropic: {
    slug: "anthropic",
    harnesses: ["claude-code"],
    adapter: "claude-code-cloud",
  },
}

/** Typed refusal from {@link resolveCloudSpawn}. `field` names the spawn
 *  field that caused it (absent for vendor/adapter-level refusals). */
export class CloudSpawnError extends Error {
  readonly code = "cloud_spawn_refused" as const
  readonly field?: string
  constructor(message: string, field?: string) {
    super(message)
    this.name = "CloudSpawnError"
    this.field = field
  }
}

/** The spawn fields a `cloud` target refuses (AIP-66 §4). Mirrors the
 *  adapter's exported `CLOUD_REFUSED_SPAWN_FIELDS`. */
export const CLOUD_REFUSED_SPAWN_FIELDS = [
  "sandbox",
  "worktree",
  "commandSandbox",
  "mcpServers",
  "daemonMount",
  "bundles",
  "browser",
  "appServe",
  "inference",
] as const

export type CloudRefusedSpawnField = (typeof CLOUD_REFUSED_SPAWN_FIELDS)[number]

/** The subset of `agent_start` input {@link resolveCloudSpawn} inspects —
 *  structural so every spawn surface can pass its parsed input through. */
export interface CloudSpawnInput {
  cloud: string
  adapter?: string
  harness?: string
  sandbox?: unknown
  worktree?: unknown
  commandSandbox?: string
  mcpServers?: readonly unknown[]
  daemonMount?: boolean
  bundles?: readonly unknown[]
  browser?: string | false
  appServe?: unknown
  inference?: unknown
}

export interface ResolvedCloudSpawn {
  /** The registry entry the slug resolved to. */
  readonly vendor: CloudVendor
  /** The adapter slug to spawn locally (the vendor's relay adapter). */
  readonly adapter: string
  /** The canonical harness name for the descriptor — the requested
   *  `harness`/`adapter` when it names one of the vendor's harnesses,
   *  else the vendor's relay adapter slug. */
  readonly harness: string
}

/** Placeholder `adapter` value the spawn surfaces pass when `cloud` is set
 *  and no adapter/harness/preset supplied one (their input types require a
 *  string). `resolveCloudSpawn` treats it — like an unset adapter — as
 *  "use the vendor's relay adapter". Parenthesized so it cannot collide
 *  with a real adapter slug. */
export const CLOUD_ADAPTER_PLACEHOLDER = "(cloud)"

function refuseField(field: CloudRefusedSpawnField, vendor: string): never {
  throw new CloudSpawnError(
    `agent_start: \`cloud: "${vendor}"\` cannot be combined with \`${field}\` — a ` +
      "managed cloud agent runs on the vendor's own machine and harness " +
      "(AIP-66 §4), so that field could never take effect. Drop it, or drop " +
      "`cloud`.",
    field,
  )
}

/**
 * Resolve `agent_start.cloud` against the vendor registry. Returns the
 * adapter slug to spawn locally, or throws {@link CloudSpawnError} —
 * always BEFORE any spawn side effect (the caller invokes this at the
 * very top of the spawn, before worktree/sandbox/auth/profile
 * resolution):
 *
 * - unknown vendor → refuse (never mapped to a default);
 * - `cloud` + `sandbox` → refuse (mutually exclusive, AIP-66 §1);
 * - `cloud` + any §4 field (`worktree`, `commandSandbox` other than
 *   "off"/unset, non-empty `mcpServers`, `daemonMount`, non-empty
 *   `bundles`, `browser` other than false/unset, `appServe`,
 *   `inference`) → refuse, naming the field;
 * - adapter/harness unset (or the {@link CLOUD_ADAPTER_PLACEHOLDER} the
 *   spawn surfaces pass when their input types demand a string) → the
 *   vendor's adapter; adapter in the
 *   vendor's `harnesses`, or equal to the vendor's adapter → the
 *   vendor's adapter; anything else → refuse with an error naming the
 *   vendor and its allowed harnesses.
 */
export function resolveCloudSpawn(input: CloudSpawnInput): ResolvedCloudSpawn {
  const vendor = CLOUD_VENDORS[input.cloud]
  if (!vendor) {
    const known = Object.keys(CLOUD_VENDORS).join(", ")
    throw new CloudSpawnError(
      `agent_start: unknown cloud vendor "${input.cloud}" — this host knows: ${known}. ` +
        "Refusing to fall back to a default vendor (AIP-66 §2).",
    )
  }

  if (input.sandbox !== undefined) {
    throw new CloudSpawnError(
      `agent_start: \`cloud: "${vendor.slug}"\` and \`sandbox\` are mutually exclusive ` +
        "(AIP-66 §1) — a managed cloud agent is vendor-hosted, a sandbox is a " +
        "host-booted box. Set exactly one.",
      "sandbox",
    )
  }

  if (input.worktree !== undefined && input.worktree !== false) {
    refuseField("worktree", vendor.slug)
  }
  if (input.commandSandbox !== undefined && input.commandSandbox !== "off") {
    refuseField("commandSandbox", vendor.slug)
  }
  if (input.mcpServers !== undefined && input.mcpServers.length > 0) {
    refuseField("mcpServers", vendor.slug)
  }
  if (input.daemonMount === true) {
    refuseField("daemonMount", vendor.slug)
  }
  if (input.bundles !== undefined && input.bundles.length > 0) {
    refuseField("bundles", vendor.slug)
  }
  if (input.browser !== undefined && input.browser !== false) {
    refuseField("browser", vendor.slug)
  }
  if (input.appServe !== undefined) {
    refuseField("appServe", vendor.slug)
  }
  if (input.inference !== undefined) {
    refuseField("inference", vendor.slug)
  }

  const requestedRaw = input.harness ?? input.adapter
  // The spawn surfaces' input types require an `adapter` string even when
  // `cloud` is set and nothing chose an adapter — they pass
  // CLOUD_ADAPTER_PLACEHOLDER in that case. Treat it, exactly like an unset
  // adapter, as "use the vendor's relay adapter".
  const requested =
    requestedRaw === undefined || requestedRaw === CLOUD_ADAPTER_PLACEHOLDER
      ? undefined
      : requestedRaw
  if (requested === undefined) {
    return { vendor, adapter: vendor.adapter, harness: vendor.adapter }
  }
  if (requested === vendor.adapter || vendor.harnesses.includes(requested)) {
    return {
      vendor,
      adapter: vendor.adapter,
      harness: vendor.harnesses.includes(requested) ? requested : vendor.adapter,
    }
  }
  throw new CloudSpawnError(
    `agent_start: adapter/harness "${requested}" does not run on cloud vendor ` +
      `"${vendor.slug}" — allowed harnesses: ${vendor.harnesses.join(", ")} ` +
      `(or the vendor's relay adapter "${vendor.adapter}") (AIP-66 §2).`,
  )
}

// ── session identity (AIP-66 §5) ────────────────────────────────────────────

/** `meta.cloud` on a session descriptor: the vendor binding plus the
 *  vendor-returned session id / URL once known. NEVER carries a credential
 *  (AIP-66 §8). Persisted as a JSON-encoded STRING under `meta.cloud`
 *  because `SessionDescriptor.meta` is `Record<string, string>` — always
 *  go through {@link encodeCloudSessionMeta} /
 *  {@link decodeCloudSessionMeta} / {@link cloudMetaOf}; never hand-parse. */
export interface CloudSessionMeta {
  vendor: string
  sessionId?: string
  url?: string
}

/** JSON-encode a cloud mapping for `SessionDescriptor.meta.cloud`. */
export function encodeCloudSessionMeta(meta: CloudSessionMeta): string {
  return JSON.stringify(meta)
}

/** Decode a stored `meta.cloud` value (a JSON string, or — defensively —
 *  an already-parsed object). Returns undefined for absent/garbage/empty
 *  mappings; never throws. */
export function decodeCloudSessionMeta(value: unknown): CloudSessionMeta | undefined {
  let parsed: unknown = value
  if (typeof parsed === "string") {
    if (parsed.length === 0) return undefined
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return undefined
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const p = parsed as Record<string, unknown>
  const vendor = p["vendor"]
  if (typeof vendor !== "string" || vendor.length === 0) return undefined
  const sessionId = p["sessionId"]
  const url = p["url"]
  return {
    vendor,
    ...(typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}),
    ...(typeof url === "string" && url.length > 0 ? { url } : {}),
  }
}

/** Read `meta.cloud` off a descriptor-shaped object, if it decodes to a
 *  well-formed cloud mapping. */
export function cloudMetaOf(desc: {
  meta?: Record<string, unknown>
} | undefined): CloudSessionMeta | undefined {
  return decodeCloudSessionMeta(desc?.meta?.["cloud"])
}

/** Read `meta.cloud` off a descriptor-shaped object, if it is a well-formed
 *  cloud mapping with a learned vendor session id. */
export function cloudSessionIdOf(
  desc: { meta?: Record<string, unknown> } | undefined,
): string | undefined {
  return cloudMetaOf(desc)?.sessionId
}

/** Env var carrying the path of the file the relay writes the learned
 *  `meta.cloud` mapping into (inside the session's isolated config dir).
 *  The adapter has no other way to learn that path. */
export const CLOUD_SESSION_META_FILE_ENV = "AGENTPROTO_CLOUD_SESSION_META_FILE"

/** The meta file name inside the session's isolated config dir. */
export const CLOUD_SESSION_META_FILE = "cloud-session.json"

/** Absolute path of the relay's cloud-session meta file for a config dir. */
export function cloudSessionMetaFilePath(configDir: string): string {
  return join(configDir, CLOUD_SESSION_META_FILE)
}

/** Read + validate the relay's meta file. Returns null when absent,
 *  unparseable, or missing a usable `sessionId` — never throws (a broken
 *  side file must not sink the spawn/resume that consulted it). */
export async function readCloudSessionMetaFile(
  metaFilePath: string,
): Promise<CloudSessionMeta | null> {
  let raw: string
  try {
    raw = await readFile(metaFilePath, "utf8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const p = parsed as Record<string, unknown>
  const vendor = p["vendor"]
  const sessionId = p["sessionId"]
  const url = p["url"]
  if (typeof vendor !== "string" || vendor.length === 0) return null
  if (typeof sessionId !== "string" || sessionId.length === 0) return null
  return {
    vendor,
    sessionId,
    ...(typeof url === "string" && url.length > 0 ? { url } : {}),
  }
}

/**
 * Resolve the vendor session id to hand an adapter on a cloud resume
 * (AIP-66 §5). Prefers the learned `meta.cloud.sessionId` on the
 * descriptor; when the descriptor never learned one (an idle-spawned
 * session was first prompted after the spawn-time watch was killed by a
 * daemon restart, or the watch simply hasn't fired yet), falls back to
 * reading the relay's meta file inside the row's own isolated config dir —
 * that file outlives any watch. When the fallback finds an id, `merge` is
 * invoked with the full `{ vendor, sessionId, url }` mapping so the caller
 * can stamp it onto the descriptor (`registry.mergeMeta`) and every later
 * resume hits the learned path directly.
 *
 * Never throws and never invents an id: a missing/garbage side file
 * returns undefined and the caller's resume falls back to the ordinary
 * `adapterSessionId`, which fails closed at the vendor.
 */
export async function resolveCloudResumeId(
  desc: { id?: string; meta?: Record<string, unknown>; adapterConfigDir?: string } | undefined,
  merge?: (meta: CloudSessionMeta) => void,
): Promise<string | undefined> {
  const meta = cloudMetaOf(desc)
  if (meta?.sessionId !== undefined) return meta.sessionId
  // Not a cloud row (no `meta.cloud` vendor binding): no side file of ours
  // could exist in its config dir — never probe non-cloud resumes.
  if (meta === undefined || !desc?.adapterConfigDir) return undefined
  const fromFile = await readCloudSessionMetaFile(cloudSessionMetaFilePath(desc.adapterConfigDir))
  if (!fromFile) return undefined
  merge?.(fromFile)
  return fromFile.sessionId
}

/** Bounded poll of the relay's meta file: the vendor session id only
 *  exists AFTER the first prompt reaches the vendor, so a cloud spawn
 *  watches (default: every 2s, timers unref'd) until the relay writes it,
 *  then calls `onLearned` exactly once and stops. The returned function
 *  stops the watch early (session died, learned).
 *  `shouldContinue` is re-checked every tick (e.g. `() =>
 *  registry.get(id)?.status === "alive"`) so a dead session doesn't keep
 *  polling. By default there is NO fixed timeout — the watch lives exactly
 *  as long as the session does: an idle-spawned cloud session may not see
 *  its first prompt (and thus learn the id) for hours, and the resume-side
 *  fallback ({@link resolveCloudResumeId}) only covers watches a daemon
 *  restart killed. An explicit `timeoutMs` still caps a watch (tests).
 *  `setTimeoutFn`/`clearTimeoutFn` are injectable for tests. */
export function watchCloudSessionMeta(opts: {
  metaFilePath: string
  vendor: string
  onLearned: (meta: CloudSessionMeta) => void | Promise<void>
  shouldContinue?: () => boolean
  intervalMs?: number
  timeoutMs?: number
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}): () => void {
  const intervalMs = Math.max(1, opts.intervalMs ?? 2_000)
  const timeoutMs =
    opts.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Math.max(intervalMs, opts.timeoutMs)
  const set = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  const clear = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout))
  const start = Date.now()
  let done = false
  let timer: unknown
  const stop = (): void => {
    if (done) return
    done = true
    if (timer !== undefined) clear(timer)
  }
  const tick = async (): Promise<void> => {
    if (done) return
    if (opts.shouldContinue && !opts.shouldContinue()) {
      stop()
      return
    }
    const meta = await readCloudSessionMetaFile(opts.metaFilePath)
    if (meta && (meta.vendor === opts.vendor || meta.vendor.length > 0)) {
      try {
        await opts.onLearned(meta)
      } finally {
        stop()
      }
      return
    }
    if (Date.now() - start >= timeoutMs) {
      stop()
      return
    }
    timer = set(() => void tick(), intervalMs)
    ;(timer as { unref?: () => void } | undefined)?.unref?.()
  }
  timer = set(() => void tick(), intervalMs)
  ;(timer as { unref?: () => void } | undefined)?.unref?.()
  return stop
}
