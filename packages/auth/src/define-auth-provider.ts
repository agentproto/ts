/**
 * `defineAuthProvider` — TS-literal authoring path for an auth-provider.
 *
 * Built on `createDoctype` so it gets the cross-AIP invariants: id-pattern,
 * ≤2000-char description, frozen handle, canonical error prefix. Field-level
 * validation uses the shared Zod from `./schema.ts`, so a malformed literal
 * fails with the same diagnostic as a malformed `.md`.
 */

import { createDoctype } from "@agentproto/define-doctype"
import { authProviderFrontmatterSchema } from "./schema.js"
import type { AuthProviderDefinition, AuthProviderHandle } from "./types.js"

export const defineAuthProvider = createDoctype<
  AuthProviderDefinition,
  AuthProviderHandle
>({
  aip: 50,
  name: "authProvider",
  validate(def) {
    const result = authProviderFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineAuthProvider (AIP-50): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
  },
  build(def) {
    return {
      ...def,
      auth: Object.freeze({ ...def.auth }),
      install: def.install ? Object.freeze({ ...def.install }) : undefined,
    }
  },
})
