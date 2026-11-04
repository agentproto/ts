/**
 * CREDENTIAL RELAY: a session running INSIDE a box (E2B / computer) that
 * orchestrates children on the same box bills a profile the HOST owns,
 * without the host keychain ever being copied into the box.
 *
 * The problem: a box daemon holds no auth profiles (no `config.json`, no
 * keychain), so a box-side supervisor's `agent_start { access: { profileRef } }`
 * failed with `no auth profile "<id>" found.` even though the HOST resolved
 * that same profile to give the supervisor its own credential.
 *
 * The mechanism rides the existing parent-relay grant (`parent-relay.ts`):
 *
 *  1. HOST, at box spawn: the same short-lived, single-session-scoped token
 *     that authenticates `message_parent` is also minted for an orchestrating
 *     box session even when it has no host parent session, and carries an
 *     ALLOWLIST of profile ids (names only): the session's own profile, the
 *     operator's `defaults.spawn.sharedProfiles`, and an explicit
 *     `access.delegateProfileRefs`, all snapshotted at the host spawn.
 *  2. BOX, at a nested `agent_start`: when the local lookup finds no such
 *     profile, the box daemon POSTs `{ adapter, profileRef(s), model, route }`
 *     to the host (never a secret, never the recipient session id).
 *  3. HOST: authenticates the token, refuses any profile outside the grant's
 *     allowlist, resolves the profile with the ordinary
 *     `resolveAccessProfileAuth` (eligibility, model curation, fresh source
 *     credentials) and answers with the resolved spec for THIS ONE spawn.
 *  4. BOX: threads the spec into the nested child's launch exactly like a
 *     local resolution. The credential lives in memory and in the child's
 *     env only; descriptors carry the non-secret echo, nothing is written to
 *     the box's disk.
 *
 * The response carries a secret, so the box only talks to an `https` relay or
 * a loopback `http` one; anything else is refused before a byte is sent.
 */

import type {
  AccessProfileAuthError,
  AccessProfileAuthResult,
  resolveAccessProfileAuth,
} from "./session-spawn.js"
import type { RouteSpec } from "./session-config.js"
import type { AdapterAuthDescriptor } from "./spawn-defaults.js"
import {
  PARENT_RELAY_TOKEN_HEADER,
  resolveParentRelayGrant,
  slideParentRelayGrant,
  type CredentialRelay,
} from "./parent-relay.js"

/** The host's credential-relay route. */
export const CREDENTIAL_RELAY_PATH = "/relay/credentials"

/** Timeout for the box → host credential POST. */
export const CREDENTIAL_RELAY_TIMEOUT_MS = 15_000

/** What a box-side nested spawn asks the host to resolve. */
export interface CredentialRelayRequest {
  adapter: string
  profileRef?: string
  profileRefs?: string[]
  model?: string
  route?: RouteSpec
}

/** Narrow an untrusted JSON body to a request, or `undefined` when malformed. */
export function parseCredentialRelayRequest(body: unknown): CredentialRelayRequest | undefined {
  if (!body || typeof body !== "object") return undefined
  const b = body as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)
  const adapter = str(b.adapter)
  if (!adapter) return undefined
  if (b.profileRefs !== undefined && !(Array.isArray(b.profileRefs) && b.profileRefs.every(r => typeof r === "string"))) {
    return undefined
  }
  const route = b.route && typeof b.route === "object" ? (b.route as RouteSpec) : undefined
  const profileRef = str(b.profileRef)
  const model = str(b.model)
  return {
    adapter,
    ...(profileRef ? { profileRef } : {}),
    ...(Array.isArray(b.profileRefs) ? { profileRefs: b.profileRefs as string[] } : {}),
    ...(model ? { model } : {}),
    ...(route ? { route } : {}),
  }
}

/** The fix every refusal names, so a caller is never left guessing. */
export const CREDENTIAL_RELAY_FIX_HINT =
  'Spawn the credentialed executor from the HOST with `agent_start { sandbox: { reuse: "<boxId>" }, ' +
  'access: { profileRef } }` (the host resolves the profile and forwards only that credential into the ' +
  "same box), or give the box supervisor access at its own host spawn with `access.delegateProfileRefs`."

function endSentence(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`
}

/** The message a box-side nested spawn sees when no relay can serve it. */
export function withCredentialRelayFix(message: string): string {
  return `${endSentence(message)} ${CREDENTIAL_RELAY_FIX_HINT}`
}

/** The hint for a nested spawn that found no local profile and holds no relay;
 *  it may run on a plain host, so the box case is stated conditionally. */
export function withBoxProfileHint(message: string): string {
  return `${endSentence(message)} If this daemon runs inside a sandbox box (a box holds no auth profiles): ${CREDENTIAL_RELAY_FIX_HINT}`
}

/** A relay URL may carry a credential back, so it must be `https`, or a
 *  loopback `http` (a same-machine box). */
export function isSecureRelayUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  const host = url.hostname.replace(/^\[|\]$/g, "")
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

type RelayResolved = Omit<AccessProfileAuthResult, "ok">

/** BOX side: ask the host to resolve the profile for a nested spawn. */
export async function requestRelayedCredential(
  relay: CredentialRelay,
  request: CredentialRelayRequest,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<AccessProfileAuthResult | AccessProfileAuthError> {
  const fail = (
    code: AccessProfileAuthError["code"],
    message: string,
    details?: Record<string, unknown>,
  ): AccessProfileAuthError => ({
    ok: false,
    code,
    message: withCredentialRelayFix(message),
    ...(details ? { details } : {}),
  })
  if (!isSecureRelayUrl(relay.url)) {
    return fail(
      "auth_source_unresolved",
      "the host relay URL is not https (or loopback), so a credential will not be requested over it.",
    )
  }
  const doFetch = opts?.fetchImpl ?? fetch
  const url = `${relay.url.replace(/\/+$/, "")}${CREDENTIAL_RELAY_PATH}`
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PARENT_RELAY_TOKEN_HEADER]: relay.token,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? CREDENTIAL_RELAY_TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => undefined)) as
      | (Partial<RelayResolved> & { ok?: boolean; error?: string; message?: string })
      | undefined
    if (!res.ok || !body?.ok) {
      const code = relayErrorCode(body?.error)
      return {
        ok: false,
        code,
        message: withCredentialRelayFix(body?.message ?? `the host relay answered ${res.status}.`),
        details: { relay: body?.error ?? `relay_http_${res.status}` },
      }
    }
    if (!body.accessProfileEcho) {
      return fail("auth_source_unresolved", "the host relay answered without a profile echo.")
    }
    return {
      ok: true,
      ...(body.authSpec ? { authSpec: body.authSpec } : {}),
      ...(body.authEcho ? { authEcho: body.authEcho } : {}),
      ...(body.resolvedRouteGateway !== undefined
        ? { resolvedRouteGateway: body.resolvedRouteGateway }
        : {}),
      accessProfileEcho: body.accessProfileEcho,
    }
  } catch (err) {
    return fail(
      "auth_source_unresolved",
      `the host relay is unreachable (${err instanceof Error ? err.message : String(err)}).`,
    )
  }
}

function relayErrorCode(error: string | undefined): AccessProfileAuthError["code"] {
  switch (error) {
    case "relay_profile_forbidden":
      return "auth_profile_denied"
    case "access_profile_not_found":
    case "access_profile_ineligible":
    case "unsupported_auth_mode":
    case "unsupported_auth_source":
    case "auth_source_unresolved":
      return error
    default:
      return "auth_source_unresolved"
  }
}

export type CredentialRelayGrantResult =
  | ({ ok: true } & RelayResolved)
  | { ok: false; status: 400 | 401 | 403 | 404; code: string; message: string }

/** HOST side: authenticate the token, enforce the allowlist and resolve. */
export async function grantRelayedCredential(input: {
  token: string | undefined
  request: CredentialRelayRequest
  resolveAgentAdapter: (
    slug: string,
  ) => Promise<{ authDescriptor?: AdapterAuthDescriptor; defaultModel?: string } | null>
  resolveAccessProfileAuth: typeof resolveAccessProfileAuth
  nowMs?: number
}): Promise<CredentialRelayGrantResult> {
  const grant = resolveParentRelayGrant(input.token, input.nowMs)
  if (!grant) {
    return {
      ok: false,
      status: 401,
      code: "relay_token_unknown",
      message: "the relay token is unknown or expired",
    }
  }
  const requested = [
    ...(input.request.profileRef ? [input.request.profileRef] : []),
    ...(input.request.profileRefs ?? []),
  ].filter(ref => ref !== "")
  if (requested.length === 0 || typeof input.request.adapter !== "string" || input.request.adapter === "") {
    return {
      ok: false,
      status: 400,
      code: "relay_request_invalid",
      message: "a credential request names an adapter and at least one profile",
    }
  }
  const allowed = grant.profileRefs ?? []
  // Fail closed on the WHOLE candidate list: a ladder with one ref outside
  // the grant is refused, never trimmed to the permitted subset.
  const denied = requested.filter(ref => !allowed.includes(ref))
  if (denied.length > 0) {
    return {
      ok: false,
      status: 403,
      code: "relay_profile_forbidden",
      message:
        `this box session may bill ${allowed.length > 0 ? `only [${allowed.join(", ")}]` : "no host profile"}; ` +
        `profile${denied.length > 1 ? "s" : ""} ${denied.map(ref => `"${ref}"`).join(", ")} ` +
        `${denied.length > 1 ? "were" : "was"} not granted when it was spawned.`,
    }
  }
  const resolved = await input.resolveAgentAdapter(input.request.adapter)
  if (!resolved) {
    return {
      ok: false,
      status: 404,
      code: "relay_adapter_unknown",
      message: `adapter "${input.request.adapter}" is not available on the host to resolve a profile for it`,
    }
  }
  const result = await input.resolveAccessProfileAuth({
    adapter: input.request.adapter,
    ...(input.request.profileRef ? { profileRef: input.request.profileRef } : {}),
    ...(input.request.profileRefs?.length ? { profileRefs: input.request.profileRefs } : {}),
    authDescriptor: resolved.authDescriptor,
    ...(input.request.route ? { route: input.request.route } : {}),
    ...(input.request.model ? { model: input.request.model } : {}),
    ...(resolved.defaultModel ? { defaultModel: resolved.defaultModel } : {}),
  })
  if (!result.ok) {
    return { ok: false, status: 400, code: result.code, message: result.message }
  }
  if (result.authSpec?.externalCredential) {
    return {
      ok: false,
      status: 400,
      code: "unsupported_auth_source",
      message:
        `profile "${result.accessProfileEcho.profileRef}" bills a file-based login on the host, ` +
        `which cannot be relayed into a box`,
    }
  }
  slideParentRelayGrant(grant, input.nowMs ?? Date.now())
  console.warn(
    `[credential-relay] box session ${grant.boxSessionId} billed profile "${result.accessProfileEcho.profileRef}" ` +
      `for a nested ${input.request.adapter} spawn`,
  )
  const { ok: _ok, ...rest } = result
  return { ok: true, ...rest }
}
