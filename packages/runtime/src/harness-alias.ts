/**
 * `harness` is the canonical name of the agent CLI a session runs (AIP-70
 * GLOSSARY); `adapter` is its deprecated alias. This module is the one place
 * that spells the deprecation, so every surface (MCP tool results, HTTP
 * bodies, CLI stderr, `session:harness-warning`) warns with the same text.
 *
 * Nothing here rejects the old name: it keeps working, and warns. The
 * removal is a later, major change.
 */

import type { ToolTransformer } from "@agentproto/tool"

/** The release the deprecated `adapter` names are removed in. */
export const HARNESS_ALIAS_REMOVAL = "the next major of @agentproto/runtime"

/**
 * The deprecation line for one old name and its canonical replacement, e.g.
 * `adapterDeprecation("adapter", "harness")` or
 * `adapterDeprecation("adapter_models", "harness_models")`.
 */
export function adapterDeprecation(oldName: string, newName: string): string {
  return `\`${oldName}\` is deprecated and will be removed in ${HARNESS_ALIAS_REMOVAL}; use \`${newName}\``
}

/** The warning for the `adapter` input field, the most common case. */
export const ADAPTER_FIELD_DEPRECATION = adapterDeprecation("adapter", "harness")

/**
 * Resolve the harness slug from an input that may carry the canonical
 * `harness`, the deprecated `adapter`, and an optional preset carrying either.
 * Resolution order: `harness ?? adapter ?? preset.harness ?? preset.adapter`.
 * A warning is returned whenever the caller sent the `adapter` key, even
 * alongside `harness`: every use of the old name warns.
 * A saved preset's `adapter` is stored data, not a call: it is read without
 * a warning (`normalizeUserPreset` already mirrors it into `harness`).
 */
export function resolveHarnessAlias(
  input: { harness?: string; adapter?: string },
  preset?: { harness?: string; adapter?: string },
): { harness: string | undefined; warnings: string[] } {
  const warnings = input.adapter !== undefined ? [ADAPTER_FIELD_DEPRECATION] : []
  return {
    harness: input.harness ?? input.adapter ?? preset?.harness ?? preset?.adapter,
    warnings,
  }
}

/** True when both keys are present and disagree: a caller bug worth naming. */
export function conflictingHarnessAlias(input: { harness?: string; adapter?: string }): boolean {
  return input.harness !== undefined && input.adapter !== undefined && input.harness !== input.adapter
}

interface TextResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/**
 * A tool transformer (sits between `catchErrors()` and `paginated()`) that
 * patches the JSON result of a list tool: duplicates the `from` wrapper key
 * under the deprecated `alias` key (e.g. `harnesses` mirrored as `adapters`)
 * and appends the `warnings` the input earns. Error results and non-JSON
 * text pass through untouched.
 */
export function patchListResult<TInput>(opts: {
  from?: string
  alias?: string
  warnings?: (input: TInput) => string[]
}): ToolTransformer<unknown, unknown, TextResult> {
  return {
    name: "patchListResult",
    wrapHandler: handler => async input => {
      const result = (await handler(input)) as TextResult
      if (result.isError) return result
      const text = result.content[0]?.text
      if (text === undefined) return result
      let body: Record<string, unknown>
      try {
        body = JSON.parse(text) as Record<string, unknown>
      } catch {
        return result
      }
      if (opts.from && opts.alias && Object.hasOwn(body, opts.from)) body[opts.alias] = body[opts.from]
      const warnings = opts.warnings?.((input ?? {}) as TInput) ?? []
      if (warnings.length > 0) {
        const prior = Array.isArray(body.warnings) ? (body.warnings as string[]) : []
        body.warnings = [...prior, ...warnings]
      }
      return { ...result, content: [{ type: "text", text: JSON.stringify(body) }] }
    },
  }
}

/**
 * Walk a completion-policy input (`gate`, then each chained `next`) and
 * return one deprecation warning when any judge gate names its harness with
 * the deprecated `judge.adapter` key.
 */
export function judgeGateAdapterWarnings(policy: unknown, tool: string): string[] {
  let node: unknown = policy
  const seen = new Set<unknown>()
  while (node !== null && typeof node === "object" && !seen.has(node)) {
    seen.add(node)
    const record = node as { gate?: unknown; verify?: unknown; next?: unknown }
    for (const gate of [record.gate, record.verify]) {
      const judge = gate !== null && typeof gate === "object" ? (gate as { judge?: unknown }).judge : undefined
      if (judge !== null && typeof judge === "object" && (judge as { adapter?: unknown }).adapter !== undefined) {
        return [`${tool}: ${adapterDeprecation("judge.adapter", "judge.harness")}`]
      }
    }
    node = record.next
  }
  return []
}
