import matter from "gray-matter"
import type { CompanyHandle } from "./types.js"

/** A company handle paired with its COMPANY.md body. */
export interface CompanyEntry {
  readonly company: CompanyHandle
  readonly body?: string | undefined
}

/**
 * Render a COMPANY.md (or OBJECTIVE.md) document. Writers emit the canonical
 * names only: `schema: company/v1`, `doctype`, `id`, never `kind` or `slug`;
 * and never the deprecated `structure.positions`, `structure.roles` or
 * `structure.reports_to` (AIP-6: seats and reporting lines live in the AIP-22
 * office). The handle's `warnings` are diagnostics, not frontmatter.
 */
export function renderCompanyMd(entry: CompanyEntry): string {
  const { company } = entry
  if (company.doctype === "role") {
    throw new Error(
      "renderCompanyMd (AIP-6): doctype 'role' moved to AIP-47: migrate the file to role/v1 and write it with the role verbs",
    )
  }
  const { schema: _schema, warnings: _warnings, doctype, id, ...fields } = company
  const data = JSON.parse(
    JSON.stringify({
      schema: "company/v1",
      doctype,
      id,
      ...fields,
    }),
  ) as Record<string, unknown>
  const structure = data.structure as Record<string, unknown> | undefined
  if (structure) {
    delete structure.positions
    delete structure.roles
    delete structure.reports_to
    if (Object.keys(structure).length === 0) delete data.structure
  }
  return matter.stringify(`\n${(entry.body ?? "").trim()}\n`, data)
}
