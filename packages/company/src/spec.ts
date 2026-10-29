/**
 * AIP-6 doctype spec — fed to `@agentproto/manifest.createVerbs` to derive
 * create / load / list / update / resolve / delete in one place. A company
 * lives at `<dir>/companies/<id>/COMPANY.md`, its objectives at
 * `<dir>/objectives/<id>/OBJECTIVE.md`.
 */

import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import matter from "gray-matter"
import { defineCompany } from "./define-company.js"
import { parseCompanyManifest } from "./manifest/index.js"
import { renderCompanyMd } from "./render.js"
import type { CompanyDefinition, CompanyHandle } from "./types.js"

export const companySpec: DoctypeSpec<CompanyDefinition, CompanyHandle> = {
  name: "company",
  aip: 6,
  schemaLiteral: "company/v1",
  pathOf: (h) =>
    h.doctype === "objective"
      ? `objectives/${h.id}/OBJECTIVE.md`
      : h.doctype === "role"
        ? `roles/${h.id}/ROLE.md`
        : `companies/${h.id}/COMPANY.md`,
  define: defineCompany,
  render: (handle, body) => renderCompanyMd({ company: handle, body }),
  parse: (source) => {
    const m = parseCompanyManifest(source)
    // Validated above; the file's own fields come back, so an update does not
    // write schema defaults into a file that never carried them.
    return { frontmatter: structuredClone(matter(source).data), body: m.body }
  },
}

export const companyVerbs = createVerbs(companySpec)
