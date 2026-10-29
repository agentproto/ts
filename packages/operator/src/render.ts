import matter from "gray-matter"
import type { OperatorHandle } from "./types.js"

/** An operator handle paired with its OPERATOR.md body. */
export interface OperatorRenderInput {
  readonly operator: OperatorHandle
  readonly body?: string | undefined
}

/**
 * Render an OPERATOR.md in canonical fields only. The handle's `warnings` and
 * `legacy` are diagnostics, not frontmatter. Deprecated forms were already
 * folded into their replacements when the handle was built (`company` into
 * `home`, `profile.voice` into `persona`, ...), and `runtime.session` is not
 * written. Fields the handle filled with an empty default are left out; a
 * reader fills them again. A role that is only a ref is written as the bare
 * string.
 */
export function renderOperatorMd(input: OperatorRenderInput): string {
  const { warnings: _warnings, legacy: _legacy, ...fields } = input.operator
  const data = JSON.parse(
    JSON.stringify({ schema: "operator/v1", ...fields }),
  ) as Record<string, unknown>

  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) ? value.length === 0 : isEmptyObject(value)) delete data[key]
  }

  const participation = data.participation as Record<string, unknown> | undefined
  if (
    participation &&
    participation.mode === "mention-only" &&
    participation.reactions === false &&
    Object.keys(participation).length === 2
  ) {
    delete data.participation
  }

  const runtime = data.runtime as Record<string, unknown> | undefined
  if (runtime) delete runtime.session

  const role = data.role as Record<string, unknown> | undefined
  if (role && Object.keys(role).length === 1) data.role = role.ref

  return matter.stringify(`\n${(input.body ?? "").trim()}\n`, data)
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}
