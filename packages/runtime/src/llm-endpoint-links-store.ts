/**
 * `~/.agentproto/llm-endpoint-links.json` — the per-upstream credential-link
 * store (mode 0600). Maps each canonical llm-endpoint upstream (`anthropic`,
 * `openrouter`, …) to a named {@link AuthProfile} id, so the daemon can spawn
 * the proxy child with `LLM_ENDPOINT_PROFILE_<P>=<profileId>` and that upstream
 * authenticates from the profile instead of a bare per-provider env key.
 *
 * This is a POINTER store, like `auth-profiles.json` (profile metadata) and
 * unlike `providers.json` / `FileStore` (secrets): it holds only profile ids,
 * never a credential, so it needs no encryption. It reuses the EXACT
 * persistence primitives `providers-store` established (a versioned JSON file
 * under `~/.agentproto/`, `node:fs/promises`, mode 0600, whole-file write) —
 * see `packages/providers-store/src/index.ts:88-151`.
 *
 * `provider` is validated against {@link CANONICAL_UPSTREAMS} on write — the 8
 * upstream ids are re-declared here (not imported) because `@agentproto/runtime`
 * deliberately has ZERO dependency on `@agentproto/llm-endpoint` (the proxy is
 * spawned as a child bin, never imported — same stance as cloudflared). The
 * list mirrors llm-endpoint's `ProviderKeys` / `CANONICAL_UPSTREAMS`
 * (`packages/llm-endpoint/src/index.ts:210-620`); keep the two in lock-step.
 *
 * `profileId` is NOT validated to reference an existing profile here — a
 * dangling link resolves to a hard 401 at proxy request time exactly as today
 * (`resolveUpstreamCredential` logs "profile missing/disabled; request will
 * 401"). Eligibility (and thus the UI's profile picker) is the guard against
 * setting a nonsensical link; the store stays a dumb, decoupled key→value map.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { AuthProfile } from "@agentproto/auth"

/**
 * The 8 canonical llm-endpoint upstreams, in `ProviderKeys` order. Re-declared
 * (not imported) to keep runtime's zero-dependency-on-llm-endpoint stance — see
 * the module doc. A `Record<Upstream, true>` would need the type first; a plain
 * frozen tuple + a `Set` narrower is enough and cannot drift silently because
 * the injection/eligibility tests pin the exact list.
 */
export const CANONICAL_UPSTREAMS = [
  "anthropic",
  "moonshot",
  "openrouter",
  "requesty",
  "zai",
  "groq",
  "xai",
  "openai",
] as const

export type CanonicalUpstream = (typeof CANONICAL_UPSTREAMS)[number]

const CANONICAL_UPSTREAM_SET: ReadonlySet<string> = new Set(CANONICAL_UPSTREAMS)

/** Narrow an arbitrary provider string to one of the 8 canonical upstreams. */
export function isCanonicalUpstream(provider: string): provider is CanonicalUpstream {
  return CANONICAL_UPSTREAM_SET.has(provider)
}

/** Thrown when a link operation names a provider outside {@link CANONICAL_UPSTREAMS}. */
export class UnknownUpstreamError extends Error {
  constructor(provider: string) {
    super(
      `Unknown upstream "${provider}". Known upstreams: ${CANONICAL_UPSTREAMS.join(", ")}.`,
    )
    this.name = "UnknownUpstreamError"
  }
}

/** On-disk shape — a versioned envelope, mirroring `ProvidersFile`. */
export interface LlmEndpointLinksFile {
  version: 1
  /** provider → auth-profile id. Only SET links are present; absent ⇒ unlinked. */
  links: Record<string, string>
}

/** Fresh empty file each call — never share the `links` object, or a later
 *  mutation leaks into every other load in-process (same defense
 *  `providers-store`'s `emptyFile()` establishes). */
function emptyFile(): LlmEndpointLinksFile {
  return { version: 1, links: {} }
}

export function llmEndpointLinksPath(): string {
  return resolve(homedir(), ".agentproto", "llm-endpoint-links.json")
}

export async function loadLlmEndpointLinks(): Promise<LlmEndpointLinksFile> {
  try {
    const raw = await readFile(llmEndpointLinksPath(), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("links" in parsed) ||
      typeof (parsed as Record<string, unknown>).links !== "object" ||
      (parsed as Record<string, unknown>).links === null
    ) {
      return emptyFile()
    }
    // Keep only string→string entries for canonical upstreams — defends against
    // a hand-edited file carrying junk (never trust the disk blindly).
    const rawLinks = (parsed as { links: Record<string, unknown> }).links
    const links: Record<string, string> = {}
    for (const [provider, profileId] of Object.entries(rawLinks)) {
      if (isCanonicalUpstream(provider) && typeof profileId === "string" && profileId) {
        links[provider] = profileId
      }
    }
    return { version: 1, links }
  } catch {
    return emptyFile() // ENOENT / malformed → empty
  }
}

async function writeLlmEndpointLinks(file: LlmEndpointLinksFile): Promise<void> {
  const dir = join(homedir(), ".agentproto")
  await mkdir(dir, { recursive: true })
  // mode 0600 to match the sibling stores (providers.json / auth-profiles.json)
  // even though this file holds no secret — same-user-only is the house style.
  await writeFile(llmEndpointLinksPath(), JSON.stringify(file, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
}

/** The full provider→profileId map (only SET links). A copy, safe to mutate. */
export async function listLlmEndpointLinks(): Promise<Record<string, string>> {
  const file = await loadLlmEndpointLinks()
  return { ...file.links }
}

/** The linked profile id for `provider`, or undefined when unlinked. */
export async function getLlmEndpointLink(provider: string): Promise<string | undefined> {
  const file = await loadLlmEndpointLinks()
  return file.links[provider]
}

/**
 * Set (or replace) the link for `provider`. Rejects an unknown upstream. Does
 * NOT validate that `profileId` exists — a dangling link 401s at request time,
 * matching today's behavior (see the module doc).
 */
export async function setLlmEndpointLink(
  provider: string,
  profileId: string,
): Promise<void> {
  if (!isCanonicalUpstream(provider)) throw new UnknownUpstreamError(provider)
  const file = await loadLlmEndpointLinks()
  file.links[provider] = profileId
  await writeLlmEndpointLinks(file)
}

/** Remove `provider`'s link (unlink → env-key path). Returns true if one
 *  existed. Rejects an unknown upstream so a typo can't silently no-op. */
export async function removeLlmEndpointLink(provider: string): Promise<boolean> {
  if (!isCanonicalUpstream(provider)) throw new UnknownUpstreamError(provider)
  const file = await loadLlmEndpointLinks()
  if (!(provider in file.links)) return false
  delete file.links[provider]
  await writeLlmEndpointLinks(file)
  return true
}

/**
 * Inject the stored links into `env` as `LLM_ENDPOINT_PROFILE_<P>=<profileId>`
 * — the seam {@link assembleLlmEndpointEnv} calls after the provider keys and
 * before the explicit-env merge, so an explicit `LLM_ENDPOINT_PROFILE_*`
 * override still wins. Returns the providers whose link was injected (for a
 * boot log that names providers, never the profile ids' secrets — profile ids
 * aren't secret, but the return shape mirrors `injectProviderKeysIntoEnv`).
 *
 * Explicit env wins per var: a `LLM_ENDPOINT_PROFILE_ANTHROPIC` already present
 * in `env` is never overwritten (matching `injectProviderKeysIntoEnv`).
 */
export async function injectLlmEndpointLinksIntoEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const links = await listLlmEndpointLinks()
  const injected: string[] = []
  for (const [provider, profileId] of Object.entries(links)) {
    if (!profileId) continue
    const name = upstreamProfileEnvVar(provider)
    if (env[name]) continue // explicit env wins
    env[name] = profileId
    injected.push(provider)
  }
  return injected
}

/**
 * The env-var name a link maps to — `LLM_ENDPOINT_PROFILE_<PROVIDER_UPPER>`.
 * MUST match llm-endpoint's `upstreamProfileEnvVar`
 * (`packages/llm-endpoint/src/index.ts:453`) exactly, or the proxy won't read
 * the injected value. Re-declared (not imported) per the zero-dep stance.
 */
export function upstreamProfileEnvVar(provider: string): string {
  return `LLM_ENDPOINT_PROFILE_${provider.toUpperCase()}`
}

/**
 * Eligibility predicate (frozen plan item 5): a profile is linkable to upstream
 * `provider` iff
 *   • `profile.endpoint === provider` (the billing endpoint IS the upstream id —
 *     the mapping is a clean 1:1 identity; see the PR's STEP 0 finding), AND
 *   • the method is compatible — `api-key` for every upstream; `oauth-bearer`
 *     ONLY for `anthropic`, matching `buildUpstreamAuthHeaders`' fail-closed
 *     rule (an oauth bearer is never forwarded to a non-anthropic host), AND
 *   • the profile is not whole-disabled.
 */
export function isProfileEligibleForUpstream(
  profile: AuthProfile,
  provider: string,
): boolean {
  if (profile.disabled) return false
  if (profile.endpoint !== provider) return false
  if (profile.method === "oauth-bearer") return provider === "anthropic"
  return true // api-key is compatible with every upstream
}

/** All profiles eligible for `provider`, filtered by {@link isProfileEligibleForUpstream}. */
export function eligibleProfilesForUpstream(
  profiles: readonly AuthProfile[],
  provider: string,
): AuthProfile[] {
  return profiles.filter(p => isProfileEligibleForUpstream(p, provider))
}
