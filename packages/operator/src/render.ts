import matter from "gray-matter"
import type { OperatorHandle } from "./types.js"

/** An operator handle paired with its OPERATOR.md body. */
export interface OperatorRenderInput {
  readonly operator: OperatorHandle
  readonly body?: string | undefined
}

/**
 * Raised when the canonical writer cannot express a legacy field the handle
 * still carries. Writing anyway would drop it silently, and a dropped policy
 * ref can drop a deny, so the write is refused and the file is left alone.
 */
export class OperatorLegacyFieldError extends Error {
  readonly code = "legacy_field_unwritable"
  readonly fields: readonly string[]
  readonly migration: string

  constructor(id: string, fields: readonly string[], migration: string) {
    super(
      `renderOperatorMd (AIP-9): id='${id}' carries legacy ${fields.join(", ")} that the canonical writer cannot express; refusing to write it without them. Migrate first: ${migration}`,
    )
    this.name = "OperatorLegacyFieldError"
    this.fields = fields
    this.migration = migration
  }
}

const GOVERNANCE_MIGRATION =
  "move governance.policies and governance.audit_log to `policy` and the AIP-7 `governance` ref; governance.autonomy is already read as `autonomy` (gated 0, supervised 5, autonomous 10)"
const MEMORY_MIGRATION =
  "move memory.share_with to AIP-38 read grants and express the rest as the AGENT memory config (scope, store)"

function assertWritable(operator: OperatorHandle): void {
  const governance = operator.legacy?.governance
  if (governance) {
    const fields = ["governance.audit_log"]
    if (governance.policies?.length) fields.unshift("governance.policies")
    throw new OperatorLegacyFieldError(operator.id, fields, GOVERNANCE_MIGRATION)
  }
  const memory = operator.legacy?.memory
  if (memory) {
    const fields: string[] = []
    if (memory.share_with?.length) fields.push("memory.share_with")
    if (memory.policy !== undefined) fields.push("memory.policy")
    if (memory.external?.namespace !== undefined) fields.push("memory.external.namespace")
    if (memory.kind === "operator-context") fields.push("memory.kind")
    if (fields.length > 0) throw new OperatorLegacyFieldError(operator.id, fields, MEMORY_MIGRATION)
  }
}

/**
 * Render an OPERATOR.md in canonical fields only. The handle's `warnings` and
 * `legacy` are diagnostics, not frontmatter. Deprecated forms were already
 * folded into their replacements when the handle was built (`company` into
 * `home`, `profile.voice` into `persona`, ...), and `runtime.session` is not
 * written. Fields the handle filled with an empty default are left out; a
 * reader fills them again. A role that is only a ref is written as the bare
 * string. A handle that still carries a legacy governance object, or legacy
 * memory fields with no canonical form, is refused with
 * {@link OperatorLegacyFieldError} rather than rewritten without them.
 */
export function renderOperatorMd(input: OperatorRenderInput): string {
  assertWritable(input.operator)
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
