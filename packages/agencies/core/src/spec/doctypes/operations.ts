import { z } from "zod"
import { authorshipFields, envelope } from "./_common.js"

/**
 * agentagencies/v1 — `OPERATIONS.md` doctype.
 *
 * Root file for **external** operations packages — used when ops live in a
 * separate package from the company package, referenced via `includes[]`
 * from `COMPANY.md` or `AGENCY.md`. Analog of `COMPANY.md` (companies.sh)
 * but scoped to operations only.
 *
 * A holding company with multiple agency divisions might have:
 *   big-corp/COMPANY.md  → includes: [../plumbing-ops, ../design-ops]
 *   plumbing-ops/OPERATIONS.md
 *   design-ops/OPERATIONS.md
 */

export const operationsFrontmatterSchema = z.object({
  ...envelope("operations"),
  ...authorshipFields,

  /** External package paths or registry shortnames this OPERATIONS.md pulls in. */
  includes: z.array(z.string()).default([]),

  /** License (matches agentcompanies/v1 conventions). */
  license: z.string().optional(),
})
export type OperationsFrontmatter = z.infer<typeof operationsFrontmatterSchema>

export interface Operations {
  frontmatter: OperationsFrontmatter
  body: string
}

export const OPERATIONS_FILENAME = "OPERATIONS.md" as const
