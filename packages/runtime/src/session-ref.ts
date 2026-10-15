/**
 * Session addressing — the ONE resolver every session-addressing surface
 * uses to turn a caller-supplied handle into a session id.
 *
 * A client may address a session by:
 *   - `sessionId` — the canonical machine key (`sess_<hex>`),
 *   - `idOrName` — the legacy camelCase spelling many tools already take,
 *   - `slug`      — the human handle (see the session-addressing plan).
 *
 * Resolution order (frozen): exact id → exact slug → legacy `name`.
 * Ambiguity is a loud failure (`{ code: "ambiguous" }`), never a silent
 * first-match — the caller must say which session it meant.
 */

import { z } from "zod"
import type { SessionsRegistry } from "./sessions.js"
import { shortSessionId } from "./session-title.js"

/** An addressing request. All three keys are optional; exactly one is
 *  resolved, and any additional supplied key must agree with it. */
export interface SessionRef {
  sessionId?: string
  idOrName?: string
  slug?: string
}

/** Why an addressing request did not resolve to a session. */
export type SessionRefError =
  | { code: "required" }
  | { code: "not_found"; query: string }
  | { code: "ambiguous"; query: string; ids: string[] }

/** The outcome of {@link resolveSessionRef}. */
export type SessionRefResult =
  | { ok: true; id: string }
  | { ok: false; error: SessionRefError }

/** The structural slice of a session this resolver reads. Kept separate
 *  from `SessionDescriptor` so the resolver compiles before the `slug`
 *  field lands on the descriptor (WP-B1) — `slug` is simply absent until
 *  then and the `name` fallback carries resolution. */
type AddressableRow = {
  id: string
  name?: string
  slug?: string
}

function matchIds(rows: readonly AddressableRow[], query: string): string[] {
  return rows.filter(row => row.slug === query || row.name === query).map(row => row.id)
}

/** Resolve a single already-trimmed query against the registry. */
function resolveOne(
  registry: Pick<SessionsRegistry, "get" | "list">,
  query: string,
): SessionRefResult {
  // 1. exact id — the map key.
  const byId = registry.get(query) as AddressableRow | undefined
  if (byId) return { ok: true, id: byId.id }

  // 2. exact slug, then 3. legacy name — both drawn from the same row set.
  //    `list()` is the default (non-archived) view; callers that need the
  //    archived set (findByIdOrName) supply an adapter over it.
  const matches = matchIds(registry.list() as readonly AddressableRow[], query)
  const [only, ...rest] = matches
  if (only === undefined) return { ok: false, error: { code: "not_found", query } }
  if (rest.length > 0) {
    return { ok: false, error: { code: "ambiguous", query, ids: [...matches].sort() } }
  }
  return { ok: true, id: only }
}

/**
 * Resolve an addressing request to a session id.
 *
 * `{ code: "required" }` when none of `sessionId`/`idOrName`/`slug` is
 * supplied; `{ code: "not_found", query }` when nothing matches;
 * `{ code: "ambiguous", query, ids }` (ids sorted) when more than one
 * session matches — legacy `name` duplicates are the only way to reach it.
 */
export function resolveSessionRef(
  registry: Pick<SessionsRegistry, "get" | "list">,
  ref: SessionRef,
): SessionRefResult {
  const supplied: string[] = []
  if (ref.sessionId !== undefined) supplied.push(ref.sessionId.trim())
  if (ref.idOrName !== undefined) supplied.push(ref.idOrName.trim())
  if (ref.slug !== undefined) supplied.push(ref.slug.trim())

  if (supplied.length === 0) return { ok: false, error: { code: "required" } }

  const resolved: string[] = []
  for (const query of supplied) {
    const result = resolveOne(registry, query)
    if (!result.ok) return result
    resolved.push(result.id)
  }

  // More than one key supplied (defensive; clients send one): they must all
  // name the same session, else this is a `not_found` on the disagreement.
  const [first, ...others] = resolved
  if (first === undefined) return { ok: false, error: { code: "required" } }
  if (others.some(id => id !== first)) {
    return { ok: false, error: { code: "not_found", query: supplied[0] ?? "" } }
  }
  return { ok: true, id: first }
}

/**
 * The zod fragment every session-addressing tool spreads into its schema —
 * `sessionId` (canonical) plus `idOrName` and `slug` (aliases), all
 * optional strings.
 */
export function sessionRefSchema(z: typeof import("zod").z): {
  sessionId?: z.ZodOptional<z.ZodString>
  idOrName?: z.ZodOptional<z.ZodString>
  slug?: z.ZodOptional<z.ZodString>
} {
  return {
    sessionId: z.string().optional(),
    idOrName: z.string().optional(),
    slug: z.string().optional(),
  }
}

/** Lowercase, hyphen-separated, alphanumeric-only. Reduces every run of
 *  non-alphanumerics to a single `-` and trims the edges. */
function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Mint a unique slug from a desired string. Slugifies `desired`, then
 * appends `-2`, `-3`, … while `isTaken` reports the candidate as taken.
 * When `desired` slugifies to empty, falls back to `sess-<shortid>` (the
 * same short tail `sessionDisplayName` uses). Pure — de-dup is driven
 * entirely by the caller's `isTaken` predicate.
 */
export function mintSlug(
  desired: string,
  isTaken: (slug: string) => boolean,
  fallbackId: string,
): string {
  const base = slugify(desired) || `sess-${shortSessionId(fallbackId)}`
  if (!isTaken(base)) return base
  let n = 2
  while (isTaken(`${base}-${n}`)) n++
  return `${base}-${n}`
}
