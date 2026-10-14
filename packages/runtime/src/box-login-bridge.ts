/**
 * BOX LOGIN BRIDGE (phase 1: codex + opencode) — pure derivation of the login
 * file a HOST hands to a sandbox BOX.
 *
 * A box boots with a fresh filesystem, so a FILE-BASED ("external") login the
 * host verifies fail-loud (`verifyLocalLoginPresent`) is simply absent there:
 * the box re-verifies its OWN `~/.codex/auth.json` / `~/.local/share/opencode/
 * auth.json` and refuses to spawn. This module builds the REDACTED copy the
 * host uploads before `host.start()`, and NOTHING else — no I/O, no recipe
 * reads (the raw JSON is a parameter), so every rule here is unit-testable
 * against plain strings.
 *
 * The rules, in order:
 *   1. **Keep-list** — only the adapter-declared dotted paths survive
 *      (`boxLogin.keep`), so a copy never carries the host's other accounts,
 *      API keys, or provider entries the spawn does not bill through.
 *   2. **UNCONDITIONAL deny** — a refresh-like key never carries material into
 *      the box, even when the keep-list names it: an exact-kept refresh key
 *      survives as an EMPTY STRING (codex's parser requires the field to
 *      exist; `""` parses and the CLI then fails loud), and everything else
 *      refresh-shaped is dropped — including from kept SUBTREES, so
 *      `keep: ["tokens"]` still yields no refresh material.
 *   3. **Home-relative destination** — the box path is derived from the
 *      recipe's own `~/…` file (or an explicit `file`), validated to be
 *      home-relative: absolute paths and `..` segments are rejected rather
 *      than written outside the box's home.
 *   4. **Expiry** — `expiresPath` is parsed (epoch seconds/ms or a date
 *      string); an already-expired login is refused so a dead copy is never
 *      mistaken for a working one.
 *   5. **Digest** — sha256 of the exact body, the change gate the refresh path
 *      compares against before re-uploading.
 *
 * A failed result DEGRADES to today's behaviour (no copy written ⇒ the box's
 * own fail-loud verify runs) — never a silent unauthenticated spawn. No result
 * ever contains a token: messages name the FILE only.
 */

import { createHash } from "node:crypto"
import { getRecipe, resolveRecipeMethod } from "@agentproto/secrets/provision/recipe"

/** The adapter's `authSubscription.boxLogin` declaration — which recipe holds
 *  the host's login, which method selects its surface, and what survives into
 *  the copy. Carried across the driver manifest → runtime descriptor boundary
 *  by SHAPE (each package owns its own copy — see the driver's mirror in
 *  `AgentCliAuthSubscription`). */
export interface BoxLoginDecl {
  /** Provision-recipe id whose source is the login file (`"codex"`,
   *  `"opencode"`, …). Also the source of the destination path when
   *  {@link file} is absent. */
  recipe: string
  /** Recipe method selecting the SURFACE for a multi-login adapter
   *  (opencode: `anthropic-oauth` / `openai-oauth`). Falls back to the
   *  recipe's default (first) method. */
  methodId?: string
  /** Dotted paths of the raw JSON that survive into the copy — the whole
   *  allowlist; everything else is dropped. A path naming a deny-listed key
   *  (or leading to a subtree that contains one) still loses that key. */
  keep: string[]
  /** Dotted path of the login's expiry inside the raw JSON (epoch seconds,
   *  epoch millis, or a date string). Absent ⇒ no expiry gate. */
  expiresPath?: string
  /** Home-relative destination inside the box (`.codex/auth.json`). Absent ⇒
   *  derived from the recipe method's own `file` source. */
  file?: string
}

export type BoxLoginCopyFailure =
  /** No destination: `file` absent and the recipe method declares no `file`
   *  source (env/keychain-only) — nothing to write. */
  | "no_path"
  /** Destination is absolute or escapes the box home (`..`, drive letter, …). */
  | "bad_path"
  /** Raw source is not JSON. */
  | "unparseable"
  /** Parsed JSON is not an object (array/scalar) — there is no key space to
   *  keep/deny against. */
  | "not_object"
  /** Keep-list selected nothing (or only deny-listed keys) — an empty login
   *  file would fail the box's own verify anyway. */
  | "empty"
  /** `expiresPath` parsed and the login is already past it. */
  | "expired"

export type BoxLoginCopyResult =
  | {
      ok: true
      /** HOME-RELATIVE box path (never absolute) — join it onto the
       *  provider's `defaultCwd` at the call site. */
      path: string
      /** Exact file body (2-space JSON + trailing newline). */
      body: string
      /** sha256 of `body` — the refresh change gate. */
      digest: string
      /** ISO form of the parsed expiry, when one parsed. Non-secret. */
      expiresAt?: string
    }
  | { ok: false; reason: BoxLoginCopyFailure; message: string; expiresAt?: string }

/**
 * Keys that NEVER carry material into the box, whatever the keep-list says.
 *
 * Matched on the key with `-`/`_`/whitespace removed and lowercased: that
 * folds `refresh_token` / `refreshToken` / `refresh-token` / `refresh` (and
 * any `*_refresh_token` sibling) into one rule without a growing literal list.
 * The single exemption, `last_refresh`, is codex's own non-secret timestamp of
 * when IT last refreshed — copied verbatim as the host's value so the box's
 * codex sees a coherent file rather than a suspicious gap.
 *
 * A denied key is DROPPED — except when its exact dotted path is named in
 * `keep`, where it survives as an EMPTY STRING. Verified against codex
 * 0.162.1 in a clean box: its auth.json parser requires `tokens.refresh_token`
 * to exist as a string (`missing field` / `invalid type: null` both abort the
 * CLI before it ever runs), while `""` parses and the CLI then fails loud at
 * the network instead. Empty is the whole point — the field's SHAPE crosses
 * the boundary, never its material. A key kept only through a parent subtree
 * (`keep: ["tokens"]`) is NOT an exact match and is dropped outright.
 */
function isDeniedKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[-_\s]/g, "")
  if (norm === "lastrefresh") return false
  return norm.includes("refresh")
}

/** Recursively drop deny-listed keys, emptying the ones `keep` names exactly.
 *  `path` is the dotted path being visited so the exact-match test can see it. */
function stripDenied(value: unknown, path: string, keep: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => stripDenied(item, `${path}[${i}]`, keep))
  }
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(src)) {
      const childPath = path.length > 0 ? `${path}.${k}` : k
      if (isDeniedKey(k)) {
        if (keep.has(childPath)) out[k] = ""
        continue
      }
      out[k] = stripDenied(v, childPath, keep)
    }
    return out
  }
  return value
}

/** Drop objects/arrays that a deny-strip (or a missing keep path) left empty —
 *  an empty `{"tokens": {}}` is noise the CLI's own parser has no use for. */
function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const kept = value.map(pruneEmpty)
    return kept.length > 0 ? kept : undefined
  }
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(src)) {
      const pruned = pruneEmpty(v)
      if (pruned === undefined) continue
      out[k] = pruned
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return value
}

/** Read a dotted path out of `root`. Returns `undefined` when any segment is
 *  absent or traverses a non-object — a keep path naming a key the login does
 *  not have is simply not copied, never an error (login files differ across
 *  CLI versions). */
function pluck(root: Record<string, unknown>, path: string): { found: boolean; value?: unknown } {
  let cur: unknown = root
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return { found: false }
    const obj = cur as Record<string, unknown>
    if (!(part in obj)) return { found: false }
    cur = obj[part]
  }
  return { found: true, value: cur }
}

/** Assign `value` at a dotted path, rebuilding the object spine — so
 *  `tokens.access_token` copies as `{tokens: {access_token}}` rather than a
 *  flattened key. An existing non-object spine node is replaced. */
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".")
  let container = root
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!
    const next = container[part]
    if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {}
      container[part] = fresh
      container = fresh
    } else {
      container = next as Record<string, unknown>
    }
  }
  container[parts[parts.length - 1]!] = value
}

/**
 * Resolve the home-relative destination: an explicit `file` wins, else the
 * recipe method's own `file` source (its `~/.codex/auth.json` — the host path
 * and the box path are the SAME home-relative location, which is exactly why
 * one declaration covers both machines).
 */
function resolveHomeRelativePath(decl: BoxLoginDecl): { path: string } | { error: BoxLoginCopyFailure; message: string } {
  const declared = decl.file ?? recipeFileSource(decl.recipe, decl.methodId)
  if (declared === undefined) {
    return {
      error: "no_path",
      message: `box login bridge: recipe "${decl.recipe}" declares no login file to copy`,
    }
  }
  let rel = declared
  if (rel.startsWith("~")) {
    if (rel === "~") rel = ""
    else if (rel.startsWith("~/")) rel = rel.slice(2)
    else return { error: "bad_path", message: `box login bridge: login file "${declared}" is not home-relative` }
  }
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) {
    return { error: "bad_path", message: `box login bridge: login file "${declared}" is absolute — a box copy must be home-relative` }
  }
  const segments = rel.split("/")
  if (rel.length === 0 || segments.some(s => s === "" || s === "." || s === "..")) {
    return { error: "bad_path", message: `box login bridge: login file "${declared}" escapes the box home` }
  }
  if (rel.includes("\\") || rel.includes("\0")) {
    return { error: "bad_path", message: `box login bridge: login file "${declared}" is not a portable path` }
  }
  return { path: segments.join("/") }
}

/** The recipe method's `file` source (first in its fallback chain), or
 *  `undefined` when the method reads only from env/keychain/prompt. */
function recipeFileSource(recipeId: string, methodId: string | undefined): string | undefined {
  try {
    if (getRecipe(recipeId) === undefined) return undefined
    const { method } = resolveRecipeMethod(recipeId, methodId)
    const chain = Array.isArray(method.source) ? method.source : [method.source]
    for (const spec of chain) {
      if ("file" in spec) return spec.file
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Parse an expiry value: epoch seconds, epoch millis, or a date string.
 *  Returns `undefined` when the value carries no parseable instant — an
 *  unparseable expiry is NOT a failure (the box's CLI still fails loud on a
 *  dead token; refusing the copy here would only refuse a LIVE login whose
 *  field shape this host doesn't recognize). */
function parseExpiry(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch seconds (< 1e12 ⇒ ~2001) vs epoch millis.
    return new Date(value < 1e12 ? value * 1000 : value)
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const asNum = Number(value)
    if (Number.isFinite(asNum) && /^-?\d+(\.\d+)?$/.test(value.trim())) {
      return parseExpiry(asNum)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed)
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>
    for (const key of ["expires_at", "expiresAt", "expires"]) {
      if (key in obj) {
        const inner = parseExpiry(obj[key])
        if (inner) return inner
      }
    }
  }
  return undefined
}

/**
 * Build the redacted login copy for `decl` out of `rawJson` (the recipe's
 * full login-file JSON, read by `readRecipeLoginJson`). See the module doc for
 * the rule order. Never throws for bad input — every bad input is a
 * `{ok: false}` result the caller degrades on.
 */
export function buildLoginCopy(decl: BoxLoginDecl, rawJson: string): BoxLoginCopyResult {
  const dest = resolveHomeRelativePath(decl)
  if ("error" in dest) return { ok: false, reason: dest.error, message: dest.message }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return {
      ok: false,
      reason: "unparseable",
      message: `box login bridge: login file "${dest.path}" is not valid JSON`,
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "not_object",
      message: `box login bridge: login file "${dest.path}" is not a JSON object`,
    }
  }
  const root = parsed as Record<string, unknown>

  // Expiry is read from the RAW JSON, not the copy: `expiresPath` may name a
  // key the keep-list itself drops, and the gate must answer "is this login
  // alive", not "did the copy keep the timestamp".
  let expiresAt: string | undefined
  if (decl.expiresPath) {
    const exp = pluck(root, decl.expiresPath)
    if (exp.found) {
      const when = parseExpiry(exp.value)
      if (when !== undefined) {
        expiresAt = when.toISOString()
        if (when.getTime() <= Date.now()) {
          return {
            ok: false,
            reason: "expired",
            message: `box login bridge: login file "${dest.path}" is expired`,
            expiresAt,
          }
        }
      }
    }
  }

  // 1. Keep-list. A deny-listed leaf is emptied (not dropped) when its exact
  //    path is named — see `isDeniedKey`.
  const keepSet = new Set(decl.keep)
  const kept: Record<string, unknown> = {}
  for (const path of decl.keep) {
    const hit = pluck(root, path)
    const lastSegment = path.split(".").pop()!
    if (!hit.found) {
      // A keep-listed refresh placeholder is synthesized even when the host
      // file has no such key: the CLI's parser needs the FIELD to exist (a
      // missing `tokens.refresh_token` aborts codex before it starts).
      if (!isDeniedKey(lastSegment)) continue
      setPath(kept, path, "")
      continue
    }
    setPath(kept, path, hit.value)
  }

  // 2. Unconditional deny — over the kept values, so a keep path naming (or
  //    containing) a refresh key never lets its MATERIAL through.
  const denied = stripDenied(kept, "", keepSet) as Record<string, unknown>

  // 3. Prune what the deny emptied, then reject an empty result.
  const pruned = pruneEmpty(denied)
  if (pruned === undefined || typeof pruned !== "object" || Array.isArray(pruned)) {
    return {
      ok: false,
      reason: "empty",
      message: `box login bridge: keep-list for "${dest.path}" retained no usable login data`,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    }
  }

  const body = JSON.stringify(pruned, null, 2) + "\n"
  return {
    ok: true,
    path: dest.path,
    body,
    digest: createHash("sha256").update(body).digest("hex"),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

/** Outcome of ONE login-file refresh attempt — see {@link createBoxLoginRefresher}. */
export type BoxLoginRefreshOutcome =
  /** A changed copy was re-uploaded into the box. */
  | "written"
  /** The box's copy already matches the host's login — nothing to do. */
  | "unchanged"
  /** The host login is gone/expired/unreadable, so nothing was re-uploaded;
   *  the box keeps whatever copy it already has. Never a throw: a refresh
   *  miss must not fail the turn that triggered it. */
  | "unavailable"

export interface BoxLoginRefresherInput {
  decl: BoxLoginDecl
  /** ABSOLUTE path INSIDE the box — `join(providerDefaultCwd, copy.path)`. */
  path: string
  /** Re-reads the HOST's raw login JSON. Injected (the bridge itself does no
   *  I/O) so tests pass a fake; the production caller passes
   *  `readRecipeLoginJson(decl.recipe, decl.methodId)`. */
  read: () => Promise<string>
  /** Uploads the body into the box — the provider host's `writeFile`. */
  write: (path: string, data: Uint8Array) => Promise<void>
  /** Digest of the copy the boot-time upload put in the box — the starting
   *  point of the change gate. */
  digest: string
}

/**
 * Build the refresh closure the sandbox proxy calls beside `renewBoxLifetime`
 * while a session is actively working: re-read the host's login, rebuild the
 * copy, and re-upload ONLY when its digest differs from what the box already
 * holds (the box's login file can change under us — a re-login on the host —
 * and an unchanged file is never rewritten). Callers own the throttle and the
 * closed/detached gate; this owns the digest gate. I/O errors PROPAGATE (the
 * caller logs them, naming the file), an unusable login does not.
 */
export function createBoxLoginRefresher(
  input: BoxLoginRefresherInput,
): () => Promise<BoxLoginRefreshOutcome> {
  let digest = input.digest
  return async () => {
    const raw = await input.read()
    const copy = buildLoginCopy(input.decl, raw)
    if (!copy.ok) return "unavailable"
    if (copy.digest === digest) return "unchanged"
    await input.write(input.path, new TextEncoder().encode(copy.body))
    digest = copy.digest
    return "written"
  }
}
