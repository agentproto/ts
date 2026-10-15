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
 *  never has to know which convention the CLI stored. `accessToken` is
 *  required (must be a non-empty string); an OPTIONAL field whose path is
 *  missing — any absent segment, a null leaf or an empty string — is simply
 *  OMITTED from the output, never `null`, so a recipe whose optional refresh
 *  lives in a subtree the CLI omits degrades instead of breaking capture. The
 *  result is sensitive: seal it immediately, never print it. */
export function extractOauthJson(doc: string, fields: OauthFieldMap): string {
  const parse = (required: boolean, path: string): string | number | undefined => {
    let docVal: unknown
    try {
      docVal = JSON.parse(doc)
    } catch {
      throw new Error(`login document is not valid JSON`)
    }
    for (const part of path.split(".")) {
      if (docVal == null || typeof docVal !== "object") {
        if (required) throw new Error(`field '${path}' not found in login document`)
        return undefined
      }
      docVal = (docVal as Record<string, unknown>)[part]
    }
    docVal = normalizeLeaf(docVal)
    if (docVal === undefined) {
      if (required) {
        throw new Error(`field '${path}' is missing or empty in login document`)
      }
      return undefined
    }
    if (typeof docVal !== "string" && typeof docVal !== "number") {
      if (required) throw new Error(`field '${path}' is not a non-empty string`)
      return undefined
    }
    return docVal
  }

  /** null / empty-string leaves count as absent for OPTIONAL fields; absent
   *  leaves DO throw for required ones. */
  const normalizeLeaf = (v: unknown): string | number | undefined => {
    if (v === null || v === undefined) return undefined
    if (typeof v === "string" && v.length === 0) return undefined
    if (typeof v === "string" || typeof v === "number") return v
    return undefined
  }

  const accessToken = parse(true, fields.accessToken) as string
  if (typeof accessToken !== "string") {
    throw new Error(`field '${fields.accessToken}' is not a non-empty string`)
  }
  const refreshToken = fields.refreshToken
    ? (parse(false, fields.refreshToken) as string | undefined)
    : undefined
  if (refreshToken !== undefined && typeof refreshToken !== "string") {
    throw new Error(`field '${fields.refreshToken}' is not a non-empty string`)
  }
  const rawExpires = fields.expiresAt
    ? (parse(false, fields.expiresAt) as string | number | undefined)
    : undefined
  // Millisecond epochs (Claude Code) or numeric strings both land as ISO.
  const expiresAt = rawExpires !== undefined ? normalizeExpires(rawExpires) : undefined

  return JSON.stringify({
    accessToken,
    ...(typeof refreshToken === "string" ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  })
}

/** Epoch-ms number or numeric string → ISO string. Epoch SECONDS (10 digits)
 *  also converts, doubling as a sanity floor; anything else (already an ISO
 *  string — e.g. Codex's `last_refresh` convention) passes through untouched. */
function normalizeExpires(raw: number | string): string {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 100_000_000_000) {
    return new Date(raw).toISOString()
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1_000_000_000) {
    // Epoch seconds.
    return new Date(raw * 1000).toISOString()
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
