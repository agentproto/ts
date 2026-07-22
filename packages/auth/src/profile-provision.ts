/**
 * Auth-profile provisioning — the create/delete flow the store CRUD
 * (`profile-store.ts`) deliberately leaves out.
 *
 * `profile-store.ts` writes only profile *metadata* (`credentialRef`, a
 * pointer). Provisioning is the two-sided operation nobody else owned: write
 * the *secret* to the credential store at a derived slot, THEN record the
 * metadata pointing at it — and, on delete, tear both down together. This is
 * the single place that knows the `agentproto.auth.<vendor>[.<qualifier>]`
 * keychain-slot convention (matching the entries seeded by hand in
 * `~/.agentproto/auth-profiles.json`).
 *
 * The secret is INPUT-only. It is written to the `CredentialStore` and never
 * echoed back: `createAuthProfile` returns non-secret metadata plus a
 * one-way `fingerprint` (same "fingerprint, don't echo" discipline as
 * `broker.ts` / `KeychainStore`), so a caller can confirm *which* credential
 * landed without ever seeing it.
 *
 * Dependency-injected (`ProfileProvisionDeps`) so it's unit-testable against
 * a `MemoryStore` + an in-memory profile map, with no keychain or filesystem.
 */

import { createHash } from "node:crypto"
import type { AuthMethod, AuthProfile } from "./profile-types.js"
import type { CredentialStore } from "./store/types.js"

/** Input to {@link createAuthProfile}. `credential` is the raw secret — it is
 *  written to the store and NEVER returned. Exactly one of `credential` /
 *  `source` must be given for an `oauth-bearer` profile; `api-key` always
 *  requires `credential` (a source-backed profile only makes sense for a
 *  self-refreshing subscription bearer). */
export interface CreateAuthProfileInput {
  /** Stable id, unique across all profiles. */
  id: string
  /** Billing endpoint / vendor this credential authenticates against
   *  (`anthropic`, `openrouter`, `moonshot`, …). */
  endpoint: string
  /** How this profile authenticates. */
  method: AuthMethod
  /** The raw secret (a subscription OAuth bearer, an API key). INPUT-ONLY.
   *  Mutually exclusive with `source`. */
  credential?: string
  /** Self-refreshing credential source (`oauth-bearer` only, e.g.
   *  `"claude-code-oauth"`) — the profile stores no secret; the credential is
   *  resolved fresh at spawn time instead. Mutually exclusive with
   *  `credential`. */
  source?: string
  /** Optional human-readable name. */
  label?: string
  /** Optional explicit credential-store slot. Omitted ⇒ derived from
   *  `endpoint` + `method` (see {@link deriveCredentialRef}). Ignored for a
   *  source-backed profile (nothing is written to the credential store). */
  credentialRef?: string
}

/** The non-secret result of a create — safe to log, return over the wire, or
 *  render in a UI. Carries a fingerprint, never the credential. */
export interface CreatedAuthProfile {
  id: string
  endpoint: string
  method: AuthMethod
  /** Set for a credential-backed profile; absent for a source-backed one. */
  credentialRef?: string
  /** Set for a source-backed profile; absent for a credential-backed one. */
  source?: string
  label?: string
  /** One-way fingerprint of the stored credential (sha256, truncated) — lets
   *  a caller confirm *which* secret was stored without exposing it. Absent
   *  for a source-backed profile — there is no stored secret to fingerprint. */
  fingerprint?: string
}

/** The result of a delete. `deleted` is false when no profile had that id
 *  (idempotent — the desired end state already held). */
export interface DeletedAuthProfile {
  deleted: boolean
  id: string
  /** The slot the credential lived at, when a profile was actually removed. */
  credentialRef?: string
}

/** Injectable persistence surface — production wires these to
 *  `profile-store.ts` + a `KeychainStore`; tests pass in-memory doubles. */
export interface ProfileProvisionDeps {
  /** Where secrets live (a `KeychainStore` in production). */
  store: CredentialStore
  getProfile: (id: string) => Promise<AuthProfile | undefined>
  listProfiles: () => Promise<AuthProfile[]>
  addProfile: (profile: AuthProfile) => Promise<void>
  removeProfile: (id: string) => Promise<boolean>
}

/** Raised when create/delete input fails validation. Distinct type so a host
 *  (HTTP route, MCP tool) can map it to a 400 rather than a 500. */
export class AuthProfileValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuthProfileValidationError"
  }
}

const AUTH_METHODS: readonly AuthMethod[] = ["oauth-bearer", "api-key"]

/** ids and endpoints become keychain-slot / filename fragments, so keep them
 *  to a conservative, injection-safe charset. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Normalized, validated create input — every field trimmed and checked.
 *  Exactly one of `credential` / `source` is present. */
export interface ValidatedCreateInput {
  id: string
  endpoint: string
  method: AuthMethod
  credential?: string
  source?: string
  label?: string
  credentialRef?: string
}

/**
 * Validate + normalize raw create input. Pure — no I/O. Throws
 * {@link AuthProfileValidationError} with a specific message on the first
 * problem it finds, so the surface layer can surface a clear 400.
 */
export function validateCreateInput(input: CreateAuthProfileInput): ValidatedCreateInput {
  const id = (input.id ?? "").trim()
  if (!id) throw new AuthProfileValidationError("id is required")
  if (!SLUG_RE.test(id)) {
    throw new AuthProfileValidationError(
      `id "${id}" is invalid — use letters, digits, ".", "_" or "-", ` +
        `starting with a letter or digit`,
    )
  }

  const endpoint = (input.endpoint ?? "").trim()
  if (!endpoint) throw new AuthProfileValidationError("endpoint is required")
  if (!SLUG_RE.test(endpoint)) {
    throw new AuthProfileValidationError(
      `endpoint "${endpoint}" is invalid — use letters, digits, ".", "_" or "-"`,
    )
  }

  const method = input.method
  if (!AUTH_METHODS.includes(method)) {
    throw new AuthProfileValidationError(
      `method must be one of ${AUTH_METHODS.join(" | ")} (got "${String(method)}")`,
    )
  }

  // Trim surrounding whitespace only — a pasted token can carry a stray
  // trailing newline, but must not be blank once trimmed.
  const credential = input.credential !== undefined ? input.credential.trim() : undefined
  const source = input.source?.trim()

  if (method === "api-key") {
    if (source) {
      throw new AuthProfileValidationError(
        "source is only supported for oauth-bearer profiles — api-key profiles require a credential",
      )
    }
    if (!credential) throw new AuthProfileValidationError("credential is required")
  } else {
    if (credential && source) {
      throw new AuthProfileValidationError(
        "give either credential or source, not both — a source-backed profile stores no secret",
      )
    }
    if (!credential && !source) {
      throw new AuthProfileValidationError("credential or source is required")
    }
  }

  const label = input.label?.trim()
  const credentialRef = input.credentialRef?.trim()
  if (credentialRef !== undefined && credentialRef !== "" && !SLUG_RE.test(credentialRef)) {
    throw new AuthProfileValidationError(
      `credentialRef "${credentialRef}" is invalid — use letters, digits, ".", "_" or "-"`,
    )
  }

  return {
    id,
    endpoint,
    method,
    ...(credential ? { credential } : {}),
    ...(source ? { source } : {}),
    ...(label ? { label } : {}),
    ...(credentialRef ? { credentialRef } : {}),
  }
}

/**
 * Derive the credential-store slot for a profile. Matches the convention of
 * the hand-seeded entries: `agentproto.auth.<endpoint>` for an api-key,
 * `agentproto.auth.<endpoint>.sub` for a subscription (oauth-bearer), plus an
 * optional `<qualifier>` to disambiguate a second profile on the same
 * endpoint+method. Pure.
 */
export function deriveCredentialRef(input: {
  endpoint: string
  method: AuthMethod
  qualifier?: string
}): string {
  const parts = ["agentproto", "auth", input.endpoint]
  if (input.method === "oauth-bearer") parts.push("sub")
  if (input.qualifier) parts.push(input.qualifier)
  return parts.join(".")
}

/** One-way fingerprint of a secret — sha256, first 12 hex chars. Enough to
 *  distinguish credentials by eye; not reversible. */
export function fingerprintCredential(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 12)
}

/** The `StoredCredential.kind` a method maps to (mirrors `profile-types.ts`:
 *  `pat` → `api-key`, `oat` → `oauth-bearer`). */
function credentialKind(method: AuthMethod): "pat" | "oat" {
  return method === "oauth-bearer" ? "oat" : "pat"
}

/**
 * Create a profile end-to-end: validate, derive the credential slot (avoiding
 * collision with an existing profile's slot), write the secret to the store,
 * then record the metadata. Rejects a duplicate id rather than silently
 * overwriting. Returns non-secret metadata + a fingerprint; the credential is
 * never echoed back.
 */
export async function createAuthProfile(
  input: CreateAuthProfileInput,
  deps: ProfileProvisionDeps,
): Promise<CreatedAuthProfile> {
  const v = validateCreateInput(input)

  if (await deps.getProfile(v.id)) {
    throw new AuthProfileValidationError(
      `a profile with id "${v.id}" already exists — delete it first or pick another id`,
    )
  }

  // Source-backed: no secret, nothing written to the credential store.
  if (v.source !== undefined) {
    const profile: AuthProfile = {
      id: v.id,
      endpoint: v.endpoint,
      method: v.method,
      source: v.source,
      ...(v.label ? { label: v.label } : {}),
    }
    await deps.addProfile(profile)
    return {
      id: profile.id,
      endpoint: profile.endpoint,
      method: profile.method,
      source: v.source,
      ...(profile.label ? { label: profile.label } : {}),
    }
  }

  const credential = v.credential!

  const existing = await deps.listProfiles()
  const takenRefs = new Set(existing.map(p => p.credentialRef))

  let credentialRef = v.credentialRef ?? deriveCredentialRef(v)
  // If the derived slot already holds another profile's secret, qualify it
  // with the id so two profiles on the same endpoint+method don't clobber
  // each other's keychain entry.
  if (!v.credentialRef && takenRefs.has(credentialRef)) {
    credentialRef = deriveCredentialRef({ ...v, qualifier: v.id })
  }

  await deps.store.write(
    { path: credentialRef },
    { value: credential, kind: credentialKind(v.method) },
  )

  const profile: AuthProfile = {
    id: v.id,
    endpoint: v.endpoint,
    method: v.method,
    credentialRef,
    ...(v.label ? { label: v.label } : {}),
  }
  await deps.addProfile(profile)

  return {
    id: profile.id,
    endpoint: profile.endpoint,
    method: profile.method,
    credentialRef,
    ...(profile.label ? { label: profile.label } : {}),
    fingerprint: fingerprintCredential(credential),
  }
}

/**
 * Delete a profile and its credential. Idempotent: a missing id returns
 * `{ deleted: false }` rather than throwing. The keychain entry is removed
 * only when no OTHER profile still references the same slot — two profiles
 * can legitimately share a `credentialRef`, and dropping one must not strand
 * the other.
 */
export async function deleteAuthProfile(
  id: string,
  deps: ProfileProvisionDeps,
): Promise<DeletedAuthProfile> {
  const trimmed = (id ?? "").trim()
  if (!trimmed) throw new AuthProfileValidationError("id is required")

  const profile = await deps.getProfile(trimmed)
  if (!profile) return { deleted: false, id: trimmed }

  await deps.removeProfile(trimmed)

  // Source-backed profiles store no secret — nothing to tear down.
  if (profile.credentialRef === undefined) {
    return { deleted: true, id: trimmed }
  }

  const stillReferenced = (await deps.listProfiles()).some(
    p => p.credentialRef === profile.credentialRef,
  )
  if (!stillReferenced && deps.store.delete) {
    await deps.store.delete({ path: profile.credentialRef })
  }

  return { deleted: true, id: trimmed, credentialRef: profile.credentialRef }
}
