/**
 * Resolve a recipe method's source to plaintext.
 *
 * A source is a single `CredentialSourceSpec` or an ordered fallback chain
 * (array) — the first that resolves wins, so one recipe spans platforms
 * (macOS Keychain → file). Bridges onto `resolveCredential` (file / env), the
 * macOS `security` Keychain, and an injected prompt impl (interactive, e.g. a
 * website password for a remote browser). The prompt impl is INJECTED — no
 * hard TTY dependency at import, same discipline as `fetchImpl` on
 * `httpTarget`. The result is sensitive: seal it immediately, never print it.
 */

import { resolveCredential, extractJsonPath } from "../index.js"
import type { CredentialSourceSpec } from "./types.js"

export interface ResolveSourceOptions {
  /** Asked for a `{ prompt }` source. Receives the prompt text, returns the
   *  entered value. Required only when a method uses a prompt source. */
  promptImpl?: (prompt: string) => Promise<string>
}

export async function resolveSourceSpec(
  source: CredentialSourceSpec | CredentialSourceSpec[],
  opts: ResolveSourceOptions = {},
): Promise<string> {
  const chain = Array.isArray(source) ? source : [source]
  const errors: string[] = []
  for (const spec of chain) {
    try {
      return await resolveOne(spec, opts)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(`no credential source resolved (${errors.join("; ")})`)
}

async function resolveOne(
  source: CredentialSourceSpec,
  opts: ResolveSourceOptions,
): Promise<string> {
  if ("env" in source) {
    return resolveCredential({ fromEnv: source.env })
  }
  if ("file" in source) {
    return resolveCredential({
      fromFile: source.file,
      ...(source.jsonPath ? { jsonPath: source.jsonPath } : {}),
    })
  }
  if ("keychain" in source) {
    return resolveKeychain(source)
  }
  // prompt
  if (!opts.promptImpl) {
    throw new Error(
      `credential source needs an interactive prompt but no promptImpl was provided`,
    )
  }
  const value = await opts.promptImpl(source.prompt)
  if (!value) throw new Error("prompt returned an empty credential")
  return value
}

async function resolveKeychain(source: {
  keychain: string
  account?: string
  jsonPath?: string
}): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("keychain source is macOS-only")
  }
  const { execFileSync } = await import("node:child_process")
  const args = ["find-generic-password", "-w", "-s", source.keychain]
  if (source.account) args.push("-a", source.account)
  let raw: string
  try {
    raw = execFileSync("security", args, { encoding: "utf8" }).trim()
  } catch {
    throw new Error(`keychain item '${source.keychain}' not found`)
  }
  if (!raw) throw new Error(`keychain item '${source.keychain}' is empty`)
  return source.jsonPath ? extractJsonPath(raw, source.jsonPath) : raw
}
