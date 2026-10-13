/**
 * `sandbox_exec.envProfiles` — put an auth profile's credential into the
 * command's env WITHOUT the caller ever holding the value.
 *
 * Security rule (same as the `agent_start({sandbox})` keychain fallback in
 * `sandbox-secret-resolver.ts`): the caller names an auth PROFILE ID, which is
 * operator-configured and daemon-owned. The keychain ref always comes from the
 * profile record — a caller-supplied ref is not accepted anywhere, since it
 * would read any keychain slot. The daemon-env broker is deliberately NOT
 * layered in (`base` resolves to null): an env NAME the caller picks must never
 * select a daemon env var to exfiltrate.
 *
 * Returned values are for the provider's exec env and the redactor ONLY — they
 * are never logged, echoed in a result, or placed in argv.
 */

import {
  KeychainStore,
  getAuthProfile as defaultGetAuthProfile,
  type AuthProfile,
  type CredentialStore,
} from "@agentproto/auth"
import { autoCredentialRefOf, buildSandboxSecretResolver } from "./sandbox-secret-resolver.js"
import { resolveProfileSubaccount, type ResolvedProfileSubaccount } from "./subaccount-resolution.js"

export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

export interface EnvProfilesDeps {
  getAuthProfile?: (id: string) => Promise<AuthProfile | undefined>
  /** Keychain backend; defaults to the OS keychain. Injectable for tests. */
  secretStore?: Pick<CredentialStore, "read">
  resolveSubaccount?: (
    profile: AuthProfile,
    ctx: { credential?: string },
  ) => Promise<ResolvedProfileSubaccount | undefined>
}

export type ResolveEnvProfilesResult =
  | { ok: true; env: Record<string, string>; secretValues: string[] }
  | { ok: false; code: "invalid_input" | "profile_error"; message: string }

/** Validate the shape of an `envProfiles` map against the literal `env` (no
 *  I/O). Returns an error message, or undefined when the input is acceptable. */
export function validateEnvProfiles(
  envProfiles: Record<string, string>,
  literalEnv: Record<string, string> | undefined,
): string | undefined {
  for (const [name, profileId] of Object.entries(envProfiles)) {
    if (!ENV_NAME_RE.test(name)) {
      return `envProfiles: "${name}" is not a valid env var name (must match ${ENV_NAME_RE.source}).`
    }
    if (typeof profileId !== "string" || profileId.length === 0) {
      return `envProfiles: "${name}" must name an auth profile id (see \`auth_profile_list\`).`
    }
    if (literalEnv !== undefined && Object.hasOwn(literalEnv, name)) {
      return (
        `envProfiles: "${name}" is also set in \`env\` — pass it once, either as a literal ` +
        "value or from a profile, not both."
      )
    }
  }
  return undefined
}

/** Resolve every `envProfiles` entry to its env var value. All-or-nothing. */
export async function resolveEnvProfiles(
  envProfiles: Record<string, string>,
  literalEnv: Record<string, string> | undefined,
  deps: EnvProfilesDeps = {},
): Promise<ResolveEnvProfilesResult> {
  const getProfile = deps.getAuthProfile ?? defaultGetAuthProfile
  const resolveSubaccount = deps.resolveSubaccount ?? resolveProfileSubaccount
  const refs = new Map<string, string>()
  const read = buildSandboxSecretResolver({
    base: async () => null,
    refs,
    store: deps.secretStore ?? new KeychainStore(),
  })

  const env: Record<string, string> = {}
  const secretValues: string[] = []
  const claimed = (name: string): boolean =>
    Object.hasOwn(env, name) || (literalEnv !== undefined && Object.hasOwn(literalEnv, name))
  const fail = (message: string): ResolveEnvProfilesResult => ({
    ok: false,
    code: "profile_error",
    message,
  })

  for (const [name, profileId] of Object.entries(envProfiles)) {
    let profile: AuthProfile | undefined
    try {
      profile = await getProfile(profileId)
    } catch (err) {
      return fail(
        `envProfiles: could not load auth profile "${profileId}" — ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    if (profile === undefined) {
      return fail(`envProfiles: unknown auth profile "${profileId}" (see \`auth_profile_list\`).`)
    }
    if (profile.disabled === true) {
      return fail(`envProfiles: auth profile "${profileId}" is disabled.`)
    }

    if (profile.subaccount !== undefined) {
      // The provider derives the credential (and extra env) for the pinned
      // org/workspace/project. The parent account's stored secret, when there
      // is one, is handed to it as context exactly like the spawn path does.
      let parent: string | undefined
      if (profile.credentialRef !== undefined) {
        refs.set(name, profile.credentialRef)
        parent = (await read(name)) ?? undefined
        refs.delete(name)
        if (parent === undefined) {
          return fail(
            `envProfiles: the stored credential of auth profile "${profileId}" could not be read from the keychain.`,
          )
        }
      }
      let resolved: ResolvedProfileSubaccount | undefined
      try {
        resolved = await resolveSubaccount(profile, parent !== undefined ? { credential: parent } : {})
      } catch (err) {
        return fail(
          `envProfiles: sub-account of auth profile "${profileId}" could not be resolved — ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      if (resolved?.credential === undefined) {
        return fail(`envProfiles: auth profile "${profileId}" resolved to no credential.`)
      }
      env[name] = resolved.credential
      secretValues.push(resolved.credential)
      for (const [extraName, extraValue] of Object.entries(resolved.authInputs.extraEnv ?? {})) {
        if (claimed(extraName)) {
          return {
            ok: false,
            code: "invalid_input",
            message:
              `envProfiles: auth profile "${profileId}" also sets "${extraName}" — it collides with ` +
              "another env var of this call; drop the duplicate.",
          }
        }
        env[extraName] = extraValue
        secretValues.push(...secretishLiteralValues({ [extraName]: extraValue }))
      }
      continue
    }

    const ref = autoCredentialRefOf(profile)
    if (ref === undefined) {
      return fail(
        profile.source !== undefined
          ? `envProfiles: auth profile "${profileId}" is source-backed (${profile.source}) with no stored ` +
              "credential — only profiles with a stored credential or a pinned sub-account are supported."
          : `envProfiles: auth profile "${profileId}" has no stored credential to inject.`,
      )
    }
    refs.set(name, ref)
    const value = await read(name)
    refs.delete(name)
    if (value === null) {
      return fail(
        `envProfiles: the stored credential of auth profile "${profileId}" could not be read from the keychain.`,
      )
    }
    env[name] = value
    secretValues.push(value)
  }
  return { ok: true, env, secretValues }
}

const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i
const MIN_REDACT_LEN = 4
const LITERAL_REDACT_LEN = 16

/** Literal `env` values worth scrubbing from output: anything named like a
 *  secret, or long enough to be one. Short/benign values (`NODE_ENV=production`)
 *  are left alone so ordinary output isn't shredded. */
export function secretishLiteralValues(env: Record<string, string> | undefined): string[] {
  const out: string[] = []
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value.length >= MIN_REDACT_LEN && (SECRET_NAME_RE.test(name) || value.length >= LITERAL_REDACT_LEN)) {
      out.push(value)
    }
  }
  return out
}

/** Build a scrubber that replaces every occurrence of any secret value with
 *  `<redacted>` (longest first, so a value containing another is fully cut). */
export function makeRedactor(secretValues: readonly string[]): (text: string) => string {
  const values = [...new Set(secretValues.filter(v => v.length >= MIN_REDACT_LEN))].sort(
    (a, b) => b.length - a.length,
  )
  if (values.length === 0) return text => text
  return text => {
    let out = text
    for (const v of values) out = out.split(v).join("<redacted>")
    return out
  }
}
