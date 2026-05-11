/**
 * Sigil + substitution engine for `$$SECRET[NAME]$$` placeholders.
 *
 * Used by hosts that implement egress-time secret substitution (the
 * narrow case in `@agentproto/egress`'s cooperative mode), and any
 * other consumer that wants to materialize secrets only at the
 * boundary instead of in agent-process env.
 *
 * Sigil shape: `$$SECRET[<NAME>]$$` where `<NAME>` is `[A-Z_][A-Z0-9_]*`
 * (matches typical env-var naming). The double-`$$` boundary on both
 * sides plus the bracketed name means a single regex pass can extract
 * names without false positives on strings that happen to contain `$$`
 * elsewhere.
 *
 * # Security
 * Resolved values get a sanity check before substitution:
 *   - Reject CR (`\r`), LF (`\n`), NUL (`\0`) — header injection
 *   - Reject empty strings — degenerate, almost always a bug
 *
 * Hosts that need stricter validation (length caps, charset narrowing)
 * wrap the resolver passed in; this layer only enforces the universal
 * "won't break the wire" guarantees.
 */

/**
 * Match a single `$$SECRET[NAME]$$` placeholder. Capture group 1 is
 * the name. Use the global flag (`g`) when scanning a longer string;
 * the constant here is non-global so callers can `.exec()` reliably.
 *
 * Exported because some consumers (e.g. the host-side install form)
 * want to validate that a string contains no placeholder before
 * accepting user input — they can re-derive a global variant cheaply.
 */
export const SECRET_PLACEHOLDER_PATTERN = /\$\$SECRET\[([A-Z_][A-Z0-9_]*)\]\$\$/

/** Global variant — used internally for scanning + substitution. */
const SECRET_PLACEHOLDER_PATTERN_G = new RegExp(
  SECRET_PLACEHOLDER_PATTERN.source,
  "g"
)

/** Resolver function the substitution engine calls per-name. Returns
 *  the secret value or `null` when the name doesn't resolve. The
 *  engine treats null as "no substitution" (placeholder remains in
 *  the output). Hosts that prefer hard-fail-on-miss should throw from
 *  the resolver; the engine propagates. */
export type SecretResolver = (name: string) => Promise<string | null> | string | null

/** Outcome of a single substitution call. `replacements` includes one
 *  entry per matched placeholder, in the order they appeared. Useful
 *  for audit logs ("this call substituted OPENAI_API_KEY"). */
export interface SubstituteResult {
  output: string
  replacements: SubstitutionRecord[]
}

export interface SubstitutionRecord {
  name: string
  /** True when the resolver returned a non-null value. False when the
   *  resolver returned null (placeholder kept verbatim). */
  resolved: boolean
}

/**
 * Validate a resolved secret value before it's substituted. Throws
 * with a stable error code so hosts can map the failure to a 4xx
 * cleanly. Exported so resolvers that pre-fetch can run the same
 * check before handing values back.
 */
export function assertSafeSecretValue(name: string, value: string): void {
  if (value.length === 0) {
    throw new SecretSubstitutionError(
      "secret_value_empty",
      `Resolved value for '${name}' is empty.`
    )
  }
  // CR / LF / NUL break header framing and stdio respectively. Other
  // control chars are allowed — some legitimate tokens contain them
  // (rare, but a base64 with `\t` would be wrongly rejected by a
  // broader filter).
  if (/[\r\n\0]/.test(value)) {
    throw new SecretSubstitutionError(
      "secret_value_unsafe",
      `Resolved value for '${name}' contains forbidden control characters (CR/LF/NUL).`
    )
  }
}

/**
 * Substitute every `$$SECRET[NAME]$$` placeholder in `input` using
 * `resolver`. Returns the rewritten string + the list of names that
 * were touched (for audit).
 *
 * Async because resolvers usually decrypt or hit a vault. Even when
 * the resolver is synchronous, the result is a Promise — callers that
 * want the sync path can `await` it cheaply since the underlying work
 * is microtask-scheduled.
 *
 * Whole-string matches are NOT enforced — the placeholder may appear
 * anywhere inside the input (`Bearer $$SECRET[X]$$` is the common
 * case for HTTP Authorization headers). Hosts that want stricter
 * placement (e.g. body-substitution gated to specific JSON paths)
 * should pre-narrow the input before calling here.
 */
export async function substituteSecrets(
  input: string,
  resolver: SecretResolver
): Promise<SubstituteResult> {
  const replacements: SubstitutionRecord[] = []
  // Two-pass: first find all matches + resolve concurrently, then
  // rewrite. Lets parallel resolvers (multiple secrets) overlap their
  // decrypt cost.
  const matches: Array<{ name: string; start: number; end: number }> = []
  let m: RegExpExecArray | null
  const scan = new RegExp(
    SECRET_PLACEHOLDER_PATTERN_G.source,
    SECRET_PLACEHOLDER_PATTERN_G.flags
  )
  while ((m = scan.exec(input)) !== null) {
    matches.push({
      name: m[1]!,
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  if (matches.length === 0) {
    return { output: input, replacements: [] }
  }

  // Dedupe so multiple placeholders for the same name only resolve once.
  const uniqueNames = Array.from(new Set(matches.map((x) => x.name)))
  const resolved = new Map<string, string | null>()
  await Promise.all(
    uniqueNames.map(async (name) => {
      const value = await resolver(name)
      if (value !== null) assertSafeSecretValue(name, value)
      resolved.set(name, value)
    })
  )

  // Rewrite right-to-left so earlier substitutions don't shift
  // subsequent indices.
  let output = input
  for (let i = matches.length - 1; i >= 0; i--) {
    const { name, start, end } = matches[i]!
    const value = resolved.get(name) ?? null
    if (value !== null) {
      output = output.slice(0, start) + value + output.slice(end)
    }
    // Order-preserving record for audit (forward order).
  }
  for (const { name } of matches) {
    replacements.push({ name, resolved: resolved.get(name) !== null })
  }

  return { output, replacements }
}

/**
 * Convenience: format a placeholder string for a given name.
 * `formatPlaceholder("OPENAI_API_KEY") === "$$SECRET[OPENAI_API_KEY]$$"`
 *
 * Throws on invalid names so a bug in the host can't accidentally
 * inject a placeholder that won't round-trip through the regex.
 */
export function formatPlaceholder(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new SecretSubstitutionError(
      "invalid_placeholder_name",
      `Placeholder name '${name}' must match [A-Z_][A-Z0-9_]*`
    )
  }
  return `$$SECRET[${name}]$$`
}

/** Stable error class — hosts catch by `.code` to map to user-facing
 *  responses (typically 400 / 403 / 500). */
export class SecretSubstitutionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "SecretSubstitutionError"
  }
}
