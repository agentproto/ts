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
 *
 * `readRecipeLoginJson` is the sibling read that returns the recipe's WHOLE
 * login document (no `jsonPath` extraction) — see its docblock.
 */

import { resolveCredential, extractJsonPath } from "../index.js"
import { resolveRecipeMethod } from "./registry.js"
import type { CredentialSourceSpec, OauthFieldMap } from "./types.js"

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

/**
 * Read the WHOLE login-file JSON a recipe's method points at — the box-login
 * bridge's raw input (`box-login-bridge.ts`), unlike {@link resolveSourceSpec}
 * which extracts ONE credential field via `jsonPath`.
 *
 * Deliberately narrow about sources: only `file` and `keychain` carry a JSON
 * document (an `env`/`prompt` source holds a bare credential, not a login
 * file), so those are skipped and the chain fails when nothing else resolves.
 * The `jsonPath` of each source is IGNORED — the caller wants the document the
 * CLI itself parses, not the one extractable field inside it. The value is
 * sensitive: hand it straight to the bridge, never print it.
 *
 * `methodId` selects a multi-surface recipe's flavor (opencode:
 * `anthropic-oauth` / `openai-oauth`); omitted ⇒ the recipe's default method,
 * matching {@link resolveSourceSpec}'s callers.
 */
export async function readRecipeLoginJson(
  recipeId: string,
  methodId?: string,
): Promise<string> {
  const { method } = resolveRecipeMethod(recipeId, methodId)
  const chain = Array.isArray(method.source) ? method.source : [method.source]
  const errors: string[] = []
  for (const spec of chain) {
    try {
      if ("file" in spec) {
        return await resolveCredential({ fromFile: spec.file })
      }
      if ("keychain" in spec) {
        return await resolveKeychain({ keychain: spec.keychain, ...(spec.account !== undefined ? { account: spec.account } : {}) })
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(
    `no login file for recipe '${recipeId}' method '${method.id}' (${errors.join("; ") || "only env/prompt sources declared"})`,
  )
}

/** Extract each dot-path of `fields` (AIP-19 `oauth` mapping) from one login
 *  document string, returning canonical JSON with the keys the shape names:
 *  `{accessToken, refreshToken?, expiresAt?}`. `expiresAt` normalizes — epoch
 *  milliseconds and numeric strings both become ISO strings — so a consumer
 *  never has to know which convention the CLI stored. Throws when a REQUIRED
 *  field is missing; an optional field missing is simply omitted. The result
 *  is sensitive: seal it immediately, never print it. */
export function extractOauthJson(doc: string, fields: OauthFieldMap): string {
  const parse = <T>(required: boolean, path: string): T | undefined => {
    let cur: unknown
    try {
      cur = JSON.parse(doc)
    } catch {
      throw new Error(`login document is not valid JSON`)
    }
    for (const part of path.split(".")) {
      if (cur == null || typeof cur !== "object") {
        throw new Error(`field '${path}' not found in login document`)
      }
      cur = (cur as Record<string, unknown>)[part]
    }
    if (typeof cur === "string" && cur.length === 0) {
      if (required) throw new Error(`field '${path}' is empty`)
      cur = undefined
    }
    if (required && (typeof cur !== "string" || cur.length === 0) && typeof cur !== "number") {
      throw new Error(`field '${path}' is not a non-empty string or number`)
    }
    return cur as T
  }

  const accessToken = parse<string>(true, fields.accessToken)
  const refreshToken = fields.refreshToken
    ? parse<string>(false, fields.refreshToken)
    : undefined
  const rawExpires = fields.expiresAt
    ? parse<number>(false, fields.expiresAt)
    : undefined
  // Millisecond epochs (Claude Code) or numeric strings both land as ISO.
  const expiresAt = rawExpires !== undefined ? normalizeExpires(rawExpires) : undefined

  return JSON.stringify({
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }) as string
}

/** Epoch-ms number or numeric string → ISO string; anything else (already an
 *  ISO string) passes through untouched. */
function normalizeExpires(raw: number | string): string {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 100_000_000_000) {
    return new Date(raw).toISOString()
  }
  if (typeof raw === "string" && /^\d{13}$/.test(raw)) {
    return new Date(Number(raw)).toISOString()
  }
  return String(raw)
}

/**
 * Read a method's login document through its `oauth` field map and return the
 * FULL AIP-19 oauth value shape as canonical JSON — the capture command's
 * input, unlike {@link readRecipeLoginJson} which returns the raw document or
 * {@link resolveSourceSpec} which extracts one string field. Requires the
 * method to declare an `oauth` map (builtins: `claude-code-oauth`,
 * `codex`/`oauth-subscription`); if the source chain has several documents,
 * the first that RESOLVES wins and every path reads from that one document —
 * the CLIs store access + refresh + expiry together. Env/prompt sources can't
 * produce the shape and fail the chain. The result is sensitive: seal it
 * immediately, never print it.
 */
export async function readRecipeOauthJson(
  recipeId: string,
  methodId?: string,
): Promise<string> {
  const { method } = resolveRecipeMethod(recipeId, methodId)
  if (!method.oauth) {
    throw new Error(
      `recipe '${recipeId}' method '${method.id}' declares no oauth field map — it resolves an opaque credential, not the {accessToken, refreshToken, expiresAt} shape`,
    )
  }
  const chain = Array.isArray(method.source) ? method.source : [method.source]
  const errors: string[] = []
  for (const spec of chain) {
    try {
      if ("file" in spec) {
        return extractOauthJson(await resolveCredential({ fromFile: spec.file }), method.oauth)
      }
      if ("keychain" in spec) {
        return extractOauthJson(
          await resolveKeychain({
            keychain: spec.keychain,
            ...(spec.account !== undefined ? { account: spec.account } : {}),
          }),
          method.oauth,
        )
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(
    `no login file for recipe '${recipeId}' method '${method.id}' (${errors.join("; ") || "only env/prompt sources declared"})`,
  )
}
