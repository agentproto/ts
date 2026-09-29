/**
 * The session descriptor model: a saveable, named description of a browser
 * session and EXACTLY which cookies to inject (by domain, never the whole jar).
 *
 * Wire compatibility is the contract: descriptors already on disk (written by
 * the earlier studio code) load unchanged. The schemas below validate shape but
 * never rewrite it; {@link parseSessionDescriptor} returns the parsed JSON as
 * written, so a load followed by a save is byte-stable.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { SessionDescriptorInvalidError } from "./errors.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Built-in strategy kinds. Any other kind is a registered {@link SessionSource}. */
export const BUILTIN_STRATEGY_KINDS = ["chrome-cookie", "stored-credential", "authed-storageState"] as const
export type BuiltinStrategyKind = (typeof BUILTIN_STRATEGY_KINDS)[number]

/** Built-in `inject.from` tags. Any other tag is a registered {@link SessionSource}. */
export const BUILTIN_INJECT_FROM = ["chrome-profile", "file", "camofox-native"] as const
export type BuiltinInjectFrom = (typeof BUILTIN_INJECT_FROM)[number]

export interface ChromeProfileInject {
  from: "chrome-profile"
  domains: string[]
  /** Required: with several profiles on one site, "first match" would pick at random. */
  profile: string
  /** Sub-account selector for multi-account profiles; needs an `accountSwitcher` hook. */
  account?: { platform: string; userId: string }
}

export interface FileInject {
  from: "file"
  domains: string[]
  path: string
}

/** The session owns its login (camofox storageState under the descriptor id); nothing is injected. */
export interface CamofoxNativeInject {
  from: "camofox-native"
}

/**
 * Cookies materialised at resolve time by a registered {@link SessionSource}.
 * The descriptor carries only the `sessionRef` and `domains`, never cookies.
 * `from` is the source kind (the studio's private store registers `"guilde"`).
 */
export interface SourceInject {
  from: string
  domains: string[]
  sessionRef: string
}

export type SessionInject = ChromeProfileInject | FileInject | CamofoxNativeInject | SourceInject

export type SessionInjectFrom = SessionInject["from"]

export interface ChromeCookieStrategy {
  kind: "chrome-cookie"
  domains: string[]
  /** Chrome profile dir ("Default", "Profile 1"). */
  profile: string
  profileName?: string
  profileEmail?: string
  account?: { platform: string; userId: string }
}

/** A re-login CAPABILITY: only the credential reference, never the secret. Not a resolve source. */
export interface StoredCredentialStrategy {
  kind: "stored-credential"
  platform: string
  account: string
}

export interface OwnedStorageStateStrategy {
  kind: "authed-storageState"
  storageStatePath: string
  capturedAt?: string
}

/** A registered-source strategy: `kind` is the source kind. */
export interface SourceStrategy {
  kind: string
  domains: string[]
  sessionRef: string
}

export type Strategy = ChromeCookieStrategy | StoredCredentialStrategy | OwnedStorageStateStrategy | SourceStrategy

export function isBuiltinStrategyKind(kind: string): kind is BuiltinStrategyKind {
  return (BUILTIN_STRATEGY_KINDS as readonly string[]).includes(kind)
}

export const isChromeCookieStrategy = (s: Strategy): s is ChromeCookieStrategy => s.kind === "chrome-cookie"
export const isStoredCredentialStrategy = (s: Strategy): s is StoredCredentialStrategy => s.kind === "stored-credential"
export const isOwnedStorageStateStrategy = (s: Strategy): s is OwnedStorageStateStrategy =>
  s.kind === "authed-storageState"
export const isSourceStrategy = (s: Strategy): s is SourceStrategy => !isBuiltinStrategyKind(s.kind)

export const isChromeProfileInject = (i: SessionInject): i is ChromeProfileInject => i.from === "chrome-profile"
export const isFileInject = (i: SessionInject): i is FileInject => i.from === "file"
export const isCamofoxNativeInject = (i: SessionInject): i is CamofoxNativeInject => i.from === "camofox-native"
export const isSourceInject = (i: SessionInject): i is SourceInject =>
  !(BUILTIN_INJECT_FROM as readonly string[]).includes(i.from)

/** The account a session is pinned to: for naming and drift detection. */
export interface SessionIdentity {
  profile?: string
  account?: string
  platform?: string
  profileName?: string
  profileEmail?: string
}

export type AuthStatus = "authenticated" | "auth-wall" | "stale" | "unknown"

export interface SessionDescriptor {
  /** Stable name the agent resolves by. */
  id: string
  /** `camofox`: a stealth browser we inject curated cookies into. `chrome`: the user's own browser over a driver, no injection. */
  backend: "camofox" | "chrome"
  identity?: SessionIdentity
  /** Legacy single-source seam; {@link strategies} is the multi-source model. */
  inject?: SessionInject
  strategies?: Strategy[]
  base?: string
  url?: string
  savedAt?: string
  lastVerifiedAt?: string
  lastAuthStatus?: AuthStatus
  lastCookieRefreshAt?: string
}

// ---------------------------------------------------------------------------
// Schemas (loose: unknown keys survive a round trip)
// ---------------------------------------------------------------------------

const accountSchema = z.object({ platform: z.string(), userId: z.string() }).loose()

const chromeProfileInjectSchema = z
  .object({
    from: z.literal("chrome-profile"),
    domains: z.array(z.string()),
    profile: z.string(),
    account: accountSchema.optional(),
  })
  .loose()
const fileInjectSchema = z.object({ from: z.literal("file"), domains: z.array(z.string()), path: z.string() }).loose()
const camofoxNativeInjectSchema = z.object({ from: z.literal("camofox-native") }).loose()
const sourceInjectSchema = z
  .object({ from: z.string().min(1), domains: z.array(z.string()), sessionRef: z.string() })
  .loose()

export const sessionInjectSchema = z.union([
  chromeProfileInjectSchema,
  fileInjectSchema,
  camofoxNativeInjectSchema,
  sourceInjectSchema,
])

const chromeCookieStrategySchema = z
  .object({
    kind: z.literal("chrome-cookie"),
    domains: z.array(z.string()),
    profile: z.string(),
    profileName: z.string().optional(),
    profileEmail: z.string().optional(),
    account: accountSchema.optional(),
  })
  .loose()
const storedCredentialStrategySchema = z
  .object({ kind: z.literal("stored-credential"), platform: z.string(), account: z.string() })
  .loose()
const ownedStorageStateStrategySchema = z
  .object({ kind: z.literal("authed-storageState"), storageStatePath: z.string(), capturedAt: z.string().optional() })
  .loose()
const sourceStrategySchema = z
  .object({ kind: z.string().min(1), domains: z.array(z.string()), sessionRef: z.string() })
  .loose()

export const strategySchema = z.union([
  chromeCookieStrategySchema,
  storedCredentialStrategySchema,
  ownedStorageStateStrategySchema,
  sourceStrategySchema,
])

export const sessionIdentitySchema = z
  .object({
    profile: z.string().optional(),
    account: z.string().optional(),
    platform: z.string().optional(),
    profileName: z.string().optional(),
    profileEmail: z.string().optional(),
  })
  .loose()

export const authStatusSchema = z.enum(["authenticated", "auth-wall", "stale", "unknown"])

export const sessionDescriptorSchema = z
  .object({
    id: z.string().min(1),
    backend: z.enum(["camofox", "chrome"]),
    identity: sessionIdentitySchema.optional(),
    inject: sessionInjectSchema.optional(),
    strategies: z.array(strategySchema).optional(),
    base: z.string().optional(),
    url: z.string().optional(),
    savedAt: z.string().optional(),
    lastVerifiedAt: z.string().optional(),
    lastAuthStatus: authStatusSchema.optional(),
    lastCookieRefreshAt: z.string().optional(),
  })
  .loose()

/**
 * Validate a parsed JSON document as a {@link SessionDescriptor} and return it AS
 * WRITTEN (not the zod output, which reorders keys), so a load then a save is
 * byte-stable. Throws {@link SessionDescriptorInvalidError} on a bad shape.
 */
export function parseSessionDescriptor(json: unknown): SessionDescriptor {
  const result = sessionDescriptorSchema.safeParse(json)
  if (!result.success) {
    throw new SessionDescriptorInvalidError(
      result.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`),
    )
  }
  return json as SessionDescriptor
}

// ---------------------------------------------------------------------------
// Owned storage state path
// ---------------------------------------------------------------------------

/** Persisted storageState of an owned camofox session: `<CAMOFOX_PROFILES_DIR or ~/.agentproto/camofox-profiles>/<id>.json`. */
export function ownedStorageStatePath(id: string): string {
  return join(process.env["CAMOFOX_PROFILES_DIR"] ?? join(homedir(), ".agentproto", "camofox-profiles"), `${id}.json`)
}

// ---------------------------------------------------------------------------
// Normalisation and strategy selection
// ---------------------------------------------------------------------------

/** inject.from to strategy kind: file collapses onto chrome-cookie; a source tag is its own kind. */
export function injectKindOf(from: SessionInjectFrom): Strategy["kind"] {
  if (from === "chrome-profile" || from === "file") return "chrome-cookie"
  if (from === "camofox-native") return "authed-storageState"
  return from
}

/** strategy kind to inject.from; `stored-credential` has no transport. */
export function injectFromOf(kind: Strategy["kind"]): SessionInjectFrom | undefined {
  if (kind === "chrome-cookie") return "chrome-profile"
  if (kind === "authed-storageState") return "camofox-native"
  if (kind === "stored-credential") return undefined
  return kind
}

export function chromeCookieStrategyOf(inject: ChromeProfileInject, identity?: SessionIdentity): ChromeCookieStrategy {
  return {
    kind: "chrome-cookie",
    domains: inject.domains,
    profile: inject.profile,
    ...(identity?.profileName ? { profileName: identity.profileName } : {}),
    ...(identity?.profileEmail ? { profileEmail: identity.profileEmail } : {}),
    ...(inject.account ? { account: inject.account } : {}),
  }
}

export interface NormalizeOptions {
  /** (platform, account) credential index: a match synthesizes a `stored-credential` strategy. Never secrets. */
  credentials?: ReadonlyArray<{ platform: string; account: string }>
}

function deriveStrategies(raw: SessionDescriptor, opts: NormalizeOptions): Strategy[] {
  const out: Strategy[] = []
  const inject = raw.inject
  if (inject) {
    if (isChromeProfileInject(inject)) {
      out.push(chromeCookieStrategyOf(inject, raw.identity))
    } else if (isFileInject(inject)) {
      out.push({
        kind: "chrome-cookie",
        domains: inject.domains,
        profile: raw.identity?.profile ?? "",
        ...(raw.identity?.profileName ? { profileName: raw.identity.profileName } : {}),
        ...(raw.identity?.profileEmail ? { profileEmail: raw.identity.profileEmail } : {}),
      })
    } else if (isCamofoxNativeInject(inject)) {
      out.push({ kind: "authed-storageState", storageStatePath: ownedStorageStatePath(raw.id) })
    } else {
      out.push({ kind: inject.from, domains: inject.domains, sessionRef: inject.sessionRef })
    }
  }
  const platform = raw.identity?.platform
  const account = raw.identity?.account
  if (platform && account && opts.credentials?.some(c => c.platform === platform && c.account === account)) {
    out.push({ kind: "stored-credential", platform, account })
  }
  return out
}

/**
 * The single migration seam: when `strategies` is absent, derive them from the
 * legacy `inject`/`identity` (plus a credential match); when present, return the
 * descriptor unchanged. Never drops or rewrites legacy fields.
 */
export function normalizeDescriptor(raw: SessionDescriptor, opts: NormalizeOptions = {}): SessionDescriptor {
  if (raw.strategies && raw.strategies.length > 0) return raw
  const strategies = deriveStrategies(raw, opts)
  return strategies.length > 0 ? { ...raw, strategies } : raw
}

/**
 * Resolution precedence: `authed-storageState` (unless it last hit an auth wall),
 * then `chrome-cookie`, then any registered-source strategy. `stored-credential`
 * is never selected: it is a recovery capability, not a resolve source.
 */
export function selectResolutionStrategy(desc: SessionDescriptor): Strategy | undefined {
  const strategies = desc.strategies
  if (!strategies || strategies.length === 0) return undefined
  if (desc.lastAuthStatus !== "auth-wall") {
    const owned = strategies.find(isOwnedStorageStateStrategy)
    if (owned) return owned
  }
  const chrome = strategies.find(isChromeCookieStrategy)
  if (chrome) return chrome
  return strategies.find(isSourceStrategy)
}

/** The effective `SessionInject` for resolution (see the studio's `resolveInjectFromStrategies`). */
export function resolveInjectFromStrategies(desc: SessionDescriptor): SessionInject | undefined {
  const sel = selectResolutionStrategy(desc)
  if (!sel) return desc.inject
  if (isOwnedStorageStateStrategy(sel)) return { from: "camofox-native" }
  if (isChromeCookieStrategy(sel)) {
    if (desc.inject && isFileInject(desc.inject)) return desc.inject
    return {
      from: "chrome-profile",
      domains: sel.domains,
      profile: sel.profile,
      ...(sel.account ? { account: sel.account } : {}),
    }
  }
  if (isSourceStrategy(sel)) return { from: sel.kind, domains: sel.domains, sessionRef: sel.sessionRef }
  return desc.inject
}

/** Default staleness TTL for owned cookies (7 days). */
export const COOKIE_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Pure staleness verdict computed at read time with no probe. Chrome-cookie and
 * file sources are always fresh (re-read each resolve); owned and registered
 * sources go by `lastCookieRefreshAt`.
 */
export function cookieFreshness(
  desc: SessionDescriptor,
  now: number,
  ttlMs: number = COOKIE_STALE_TTL_MS,
): "fresh" | "stale" | "unknown" {
  const eff = resolveInjectFromStrategies(desc)
  if (eff && (isChromeProfileInject(eff) || isFileInject(eff))) return "fresh"
  const stamp = desc.lastCookieRefreshAt
  if (!stamp) return "unknown"
  const t = Date.parse(stamp)
  if (Number.isNaN(t)) return "unknown"
  return now - t <= ttlMs ? "fresh" : "stale"
}

export function priorChromeStrategy(prev?: SessionDescriptor): ChromeCookieStrategy | undefined {
  const v2 = prev?.strategies?.find(isChromeCookieStrategy)
  if (v2) return v2
  if (prev?.inject && isChromeProfileInject(prev.inject)) return chromeCookieStrategyOf(prev.inject, prev.identity)
  return undefined
}

export interface BuildOwnedDescriptorInput {
  id: string
  platform: string
  reuseBase: string
  account?: string
  url?: string
  /** ISO timestamp for `savedAt` and the storageState `capturedAt` (injected, not read from the clock). */
  now: string
  /** Prior descriptor whose chrome provenance is preserved (augment, not replace). */
  prev?: SessionDescriptor
}

/** Build the `camofox-native` descriptor for an owned login, preserving any prior chrome provenance. */
export function buildOwnedSessionDescriptor(input: BuildOwnedDescriptorInput): SessionDescriptor {
  const { id, platform, reuseBase, account, url, now, prev } = input
  const chrome = priorChromeStrategy(prev)
  const strategies: Strategy[] = [
    ...(chrome ? [chrome] : []),
    { kind: "authed-storageState", storageStatePath: ownedStorageStatePath(id), capturedAt: now },
    ...(account ? [{ kind: "stored-credential", platform, account } satisfies StoredCredentialStrategy] : []),
  ]
  return {
    id,
    backend: "camofox",
    identity: {
      platform,
      ...(account ? { account } : {}),
      ...(prev?.identity?.profile ? { profile: prev.identity.profile } : {}),
      ...(prev?.identity?.profileName ? { profileName: prev.identity.profileName } : {}),
      ...(prev?.identity?.profileEmail ? { profileEmail: prev.identity.profileEmail } : {}),
    },
    inject: { from: "camofox-native" },
    base: reuseBase,
    savedAt: now,
    strategies,
    ...(url ? { url } : {}),
  }
}
