/**
 * Shared duration parser for every CLI flag that takes a time budget
 * (`--timeout`, `--gate-timeout`, `--judge-timeout`, `--timeout-ms`,
 * `--interval`, …).
 *
 * The incident this exists for: `agentproto sessions wait <id> --until
 * turn-end --timeout 3000` was meant as 3000 SECONDS. The flag is — and
 * always was — milliseconds, and the help text said so (`[--timeout <ms>]`),
 * but that didn't stop the wrong reading. A bare number carries no unit of
 * its own; the reader supplies one, and "3000" reads as seconds to anyone
 * who isn't staring at the help text at that exact moment.
 *
 * The fix is NOT to swap the bare-number contract to seconds — that would
 * be silent and 1000x in the other direction: every existing script's
 * `--timeout 30000` (30 real seconds today) would become 8.3 hours, with
 * nothing to notice at the call site. Back-compat here is a safety
 * property, not politeness. So: bare stays milliseconds, unchanged. The fix
 * is to give the caller an unambiguous way to say what they mean —
 * `500ms`, `30s`, `5m`, `2h` — so they never have to trust a bare number's
 * implied unit at all.
 *
 * A bare number under 1000 is rejected rather than silently accepted as
 * milliseconds: at that magnitude it is overwhelmingly more likely someone
 * meant seconds (`--timeout 30` for "30 seconds") than a genuine
 * sub-second budget. Sub-second values are still reachable — just say so
 * explicitly (`500ms`). Zero is rejected outright: none of these flags have
 * a sensible "wait/allow zero time" meaning, so treat it as the same units
 * slip rather than inventing a special no-op behaviour for it.
 */

export type ParsedDuration =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly error: string }

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
}

// Digits only — no sign, no decimal point. A leading "-" or a "." never
// matches, so negatives and float weirdness ("-5", "1.5s") fall straight
// through to the generic "invalid duration" branch below.
const DURATION_PATTERN = /^(\d+)(ms|s|m|h)?$/

export interface ParseDurationOptions {
  /**
   * The flag's own name already declares its unit (e.g. `--timeout-ms`).
   * Bare numbers are unambiguous there, so skip the sub-1000 units-slip
   * guard, and reject any suffix other than `ms` outright — a `30s` on a
   * flag whose name says milliseconds is a contradiction between the flag
   * name and the value, not a convenience worth silently resolving either
   * way.
   */
  readonly msOnly?: boolean
}

const EXAMPLES = "500ms, 30s, 5m, 2h (bare integer = milliseconds)"

/**
 * Parse a duration string as used by a CLI flag named `flagName` (e.g.
 * `"--timeout"`) — used verbatim in returned error messages, so pass the
 * flag spelling exactly as the user would type it.
 */
export function parseDuration(
  raw: string,
  flagName: string,
  options: ParseDurationOptions = {},
): ParsedDuration {
  const trimmed = raw.trim()
  if (trimmed === "") {
    return { ok: false, error: `${flagName} is empty. Examples: ${EXAMPLES}.` }
  }

  const match = DURATION_PATTERN.exec(trimmed)
  if (!match) {
    return {
      ok: false,
      error: `invalid ${flagName} "${raw}". Examples: ${EXAMPLES}.`,
    }
  }

  const amount = Number.parseInt(match[1]!, 10)
  const unit = match[2]
  if (!Number.isFinite(amount)) {
    return { ok: false, error: `invalid ${flagName} "${raw}": not a finite number.` }
  }
  if (amount === 0) {
    return {
      ok: false,
      error:
        `invalid ${flagName} "${raw}": 0 is never a real wait — ` +
        `omit the flag to use the default, or pass a positive duration.`,
    }
  }

  if (options.msOnly) {
    if (unit !== undefined && unit !== "ms") {
      return {
        ok: false,
        error:
          `invalid ${flagName} "${raw}": this flag's name already declares milliseconds — ` +
          `pass a bare integer (e.g. ${amount}) or an explicit \`ms\` suffix (e.g. ${amount}ms), not "${unit}".`,
      }
    }
    return { ok: true, ms: amount }
  }

  if (unit === undefined) {
    if (amount < 1000) {
      return {
        ok: false,
        error:
          `${flagName} ${raw}: ${amount}ms is almost certainly not what you meant.\n` +
          `  Pass \`${amount}s\` for ${amount} seconds, or \`${amount}ms\` if you really meant ${amount} milliseconds.`,
      }
    }
    return { ok: true, ms: amount }
  }

  return { ok: true, ms: amount * UNIT_MS[unit]! }
}

/** Human-readable rendering of a resolved duration, for echoing back what
 *  was actually parsed (e.g. a timeout error saying what it timed out
 *  after) — so a wrong unit is obvious the moment it bites instead of
 *  looking like a broken session. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}
