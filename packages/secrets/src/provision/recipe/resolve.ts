/**
 * Resolve a recipe's `CredentialSourceSpec` to plaintext.
 *
 * Bridges the recipe's discriminated source onto `resolveCredential` (file /
 * env) and an injected prompt impl (interactive, e.g. a website password for a
 * remote browser). The prompt impl is INJECTED — no hard TTY dependency at
 * import, same discipline as `fetchImpl` on `httpTarget`. The result is
 * sensitive: seal it immediately, never print it.
 */

import { resolveCredential } from "../index.js"
import type { CredentialSourceSpec } from "./types.js"

export interface ResolveSourceOptions {
  /** Asked for a `{ prompt }` source. Receives the prompt text, returns the
   *  entered value. Required only when a method uses a prompt source. */
  promptImpl?: (prompt: string) => Promise<string>
}

export async function resolveSourceSpec(
  source: CredentialSourceSpec,
  opts: ResolveSourceOptions = {},
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
