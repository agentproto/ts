/** Shared imports and the fixture loader of cases.test.ts. */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { loadBillingManifest } from "../manifest/index.js"

export * from "../index.js"

export const STRATEGIES = ["x-acme:org-kind", "x-acme:welcome-by-country", "x-acme:welcome-grant"]

/** Read a product file of the draft and load it. `edit` lets a test mutate the source first. */
export function loadBillingManifestForTest(name: string, edit?: (source: string) => string) {
  const src = readFileSync(fileURLToPath(new URL(`../__fixtures__/examples/${name}.BILLING.md`, import.meta.url)), "utf8")
  return loadBillingManifest(edit ? edit(src) : src, { strategies: STRATEGIES })
}
