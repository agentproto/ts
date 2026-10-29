/**
 * AIP-6 CompanyDefinition + CompanyHandle.
 *
 * Hand-maintained over `resources/aip-6/draft/COMPANY.schema.json` (the zod in
 * `./schema.ts` is the generated half). The input type accepts the permanent
 * aliases `kind` (for `doctype`) and `slug` (for `id`); the handle carries the
 * canonical names only. `doctype: role` is the legacy role form that AIP-47
 * took over: still readable, with a `doctype_moved` warning.
 */

export type CompanySchemaTag = "company/v1" | "agentcompanies/v1"

interface CompanyBase {
  /** Writers emit `company/v1`; `agentcompanies/v1` is the accepted legacy tag. */
  schema: CompanySchemaTag
  /** Spec version of THIS file. */
  version?: string
  name?: string
  description?: string
  tags?: string[]
  /** Vendor extensions under namespaced keys. Readers tolerate unknown keys. */
  metadata?: { [k: string]: unknown }
}

/** `doctype`, or its alias `kind`; a file MUST carry one of them. */
type Discriminator<D extends string> =
  | { doctype: D; kind?: D }
  | { kind: D; doctype?: D }

/** `id`, or its alias `slug`; a file MUST carry one of them. */
type Identifier = { id: string; slug?: string } | { slug: string; id?: string }

export interface CompanyStructure {
  /** @deprecated Seats live in the AIP-22 office. Accepted, never written. */
  positions?: string[]
  /** @deprecated Alias of `positions`. Accepted, never written. */
  roles?: string[]
  /** Slugs of top-level objectives under `objectives/<slug>/OBJECTIVE.md`. */
  objectives?: string[]
  /** @deprecated Reporting lines live in the AIP-22 office. Accepted, never written. */
  reports_to?: { [k: string]: string | undefined }
}

export interface CompanyFields {
  mission: string
  values?: string[]
  structure?: CompanyStructure
  imports?: Import[]
}

export interface Import {
  /** `<registry>/<package>@<version>` or a relative path. */
  from: string
  as: "role" | "objective"
  id?: string
  alias?: string
}

export interface ObjectiveFields {
  statement: string
  owner?: string
  horizon?: "sprint" | "quarter" | "year" | "ongoing"
  status?: "proposed" | "active" | "paused" | "achieved" | "abandoned"
  key_results?: { id: string; statement: string; target?: string; progress?: number }[]
  parent?: string
  children?: string[]
  depends_on?: string[]
}

/** The pre-AIP-47 role form (`doctype: role`). Read with a `doctype_moved` warning. */
export interface LegacyRoleFields {
  mandate: string
  reports_to?: string
  scope?: { owns?: string[]; capabilities?: string[] }
  objectives?: string[]
  tools?: string[]
  workflows?: string[]
}

export type CompanyDefinition = CompanyBase &
  Identifier &
  (
    | (Discriminator<"company"> & CompanyFields)
    | (Discriminator<"objective"> & ObjectiveFields)
    | (Discriminator<"role"> & LegacyRoleFields)
  )

export type CompanyWarning = {
  code: "doctype_moved"
  message: string
}

export type CompanyHandle = Readonly<
  CompanyBase & { id: string } & (
      | ({ doctype: "company" } & CompanyFields)
      | ({ doctype: "objective" } & ObjectiveFields)
      | ({ doctype: "role" } & LegacyRoleFields)
    ) & { warnings: readonly CompanyWarning[] }
>
