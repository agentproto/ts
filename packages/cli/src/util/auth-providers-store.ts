/**
 * `~/.agentproto/auth-providers.json` — persisted broker auth-provider defs.
 *
 * Distinct from `providers.json` (LLM/model API keys injected into the daemon
 * env) and from `credentials.json` (host-binding OAuth tokens for
 * `serve --connect`). This file holds **broker** provider *definitions* — the
 * shape an `@agentproto/auth` `CredentialBroker` needs to resolve a child-MCP
 * `credentialRef` into an `Authorization` header at spawn time.
 *
 * Crucially it stores NO secret: the token lives in the OS keychain (written by
 * `agentproto auth cred set`), keyed by the provider's audience-prefixed store
 * ref. This file only records the def (id, apiBase, audience, tokenStore) so
 * `serve` can re-register the provider on the module-level registry at every
 * boot — the broker looks providers up by id, and an unregistered id throws.
 *
 * Product-agnostic by design: agentpush, or any other Bearer-gated MCP server,
 * is just a row the user adds via the CLI — nothing about it is hard-coded in
 * agentproto. Only the `pat` flow is supported here (a pasted personal access
 * key); browser-ceremony flows (`service-auth`/`device-code`) go through
 * `auth login`, not this store.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { defineAuthProvider, type AuthProviderHandle } from "@agentproto/auth"

/** A single persisted broker-provider definition. Never holds the secret. */
export interface AuthProviderDefEntry {
  /** Base URL of the provider's API (also the broker's `server` fallback). */
  apiBase: string
  /** Audience the credential is scoped to (folded into the store key). */
  audience: string
  /** Only `pat` (pasted key) is persisted here today. */
  flow: "pat"
  /** Human-readable one-liner; defaults from the id when omitted. */
  description?: string
  /** Where the token lives — `path` is the unprefixed store key. */
  tokenStore: { keychain: string; path: string }
  /** Wall-clock ISO timestamp the def was last written. */
  updatedAt: string
}

export interface AuthProvidersFile {
  version: 1
  providers: Record<string, AuthProviderDefEntry>
}

/** Fresh empty file each call — never share the `providers` object, or a later
 *  mutation leaks into every other in-process load. */
function emptyFile(): AuthProvidersFile {
  return { version: 1, providers: {} }
}

export function authProvidersPath(): string {
  return resolve(homedir(), ".agentproto", "auth-providers.json")
}

/**
 * Reconstruct the `@agentproto/auth` provider handle from a persisted def (or
 * the equivalent CLI args). The SINGLE place a stored def becomes a registrable
 * handle — used by `serve` at boot, by `auth cred set/rm`, and by tests, so the
 * store key the broker reads is derived from the same handle everywhere.
 */
export function buildBrokerProvider(
  id: string,
  entry: Pick<AuthProviderDefEntry, "apiBase" | "audience" | "description" | "tokenStore">,
): AuthProviderHandle {
  return defineAuthProvider({
    id,
    description: entry.description ?? `${id} brokered credential (pat)`,
    apiBase: entry.apiBase,
    audience: entry.audience,
    auth: { flow: "pat", tokenStore: entry.tokenStore },
  })
}

/** Default token-store spec for a CLI-created provider — keychain service
 *  namespaced per provider, unprefixed path === the provider id. */
export function defaultTokenStore(id: string): { keychain: string; path: string } {
  return { keychain: `agentproto-${id}`, path: id }
}

export async function loadAuthProviders(): Promise<AuthProvidersFile> {
  try {
    const raw = await readFile(authProvidersPath(), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("providers" in parsed) ||
      typeof (parsed as Record<string, unknown>).providers !== "object" ||
      (parsed as Record<string, unknown>).providers === null
    ) {
      return emptyFile()
    }
    return {
      version: 1,
      providers: (parsed as AuthProvidersFile).providers,
    }
  } catch {
    return emptyFile() // ENOENT / malformed → empty
  }
}

async function writeAuthProviders(file: AuthProvidersFile): Promise<void> {
  const dir = join(homedir(), ".agentproto")
  await mkdir(dir, { recursive: true })
  // 0600 — same-user-only; this file is metadata but stays private by default.
  await writeFile(authProvidersPath(), JSON.stringify(file, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
}

/** Set (or replace) a broker-provider def. Returns the resolved path. */
export async function setAuthProviderDef(
  id: string,
  entry: Omit<AuthProviderDefEntry, "updatedAt">,
  now: string,
): Promise<string> {
  const file = await loadAuthProviders()
  file.providers[id] = { ...entry, updatedAt: now }
  await writeAuthProviders(file)
  return authProvidersPath()
}

/** Remove a def. Returns true if it existed. */
export async function removeAuthProviderDef(id: string): Promise<boolean> {
  const file = await loadAuthProviders()
  if (!(id in file.providers)) return false
  delete file.providers[id]
  await writeAuthProviders(file)
  return true
}
