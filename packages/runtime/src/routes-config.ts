/**
 * Load operator-declared custom routes from `~/.agentproto/routes.json`.
 *
 * The file is an OPTIONAL user config — missing is normal (no routes). Each
 * entry validates against the SAME `CustomRouteConfig` shape the catalog uses
 * for programmatic registration (`@agentproto/model-catalog/route-identity`),
 * so we do not maintain a parallel schema. Validation failures are logged
 * loudly with the offending route id and error; we never drop a malformed
 * entry silently.
 *
 * Security: `authEnv` is the NAME of an env var, never a value. If any value
 * in the file looks like a literal secret key (`sk-…`), the WHOLE file is
 * rejected with a clear error, because credentials must never live on disk
 * in a JSON config.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { z } from "zod"
import { CatalogProviderSchema } from "@agentproto/model-catalog"
import type { CustomRouteConfig } from "@agentproto/model-catalog/route-identity"

const routesFilePath = (): string => resolve(homedir(), ".agentproto", "routes.json")

const customRouteConfigSchema: z.ZodType<CustomRouteConfig> = z.object({
  label: z.string().optional(),
  flavor: z.string().optional(),
  baseUrl: z.string().optional(),
  authEnv: z.string().optional(),
  availability: z.enum(["available", "preview", "unavailable"]).optional(),
  limits: z
    .object({
      contextWindow: z.number().optional(),
      maxInputTokens: z.number().optional(),
      maxOutputTokens: z.number().optional(),
    })
    .optional(),
  pricing: z
    .object({
      inputPer1M: z.number().optional(),
      outputPer1M: z.number().optional(),
      overrideCreditInputPer1M: z.number().optional(),
      overrideCreditOutputPer1M: z.number().optional(),
      cacheReadMultiplier: z.number().optional(),
      cacheWriteMultiplier: z.number().optional(),
      provider: CatalogProviderSchema.optional(),
      vendor: z.string().optional(),
    })
    .optional(),
})

const routesFileSchema = z.record(z.string(), customRouteConfigSchema)

const LITERAL_SECRET_RE = /sk-[a-zA-Z0-9]/

function assertNoLiteralSecrets(raw: string): void {
  if (LITERAL_SECRET_RE.test(raw)) {
    throw new Error(
      `routes.json appears to contain a literal secret key. ` +
        `Store the key name in authEnv, never the key value.`,
    )
  }
}

export interface LoadedRoutesResult {
  routes: Record<string, CustomRouteConfig>
  errors: string[]
}

/**
 * Load and validate operator routes from `~/.agentproto/routes.json`.
 * Returns the loaded routes keyed by id and any validation errors. Never
 * throws: a missing file is `{ routes: {}, errors: [] }`.
 */
export async function loadOperatorRoutes(): Promise<LoadedRoutesResult> {
  const result: LoadedRoutesResult = { routes: {}, errors: [] }

  let raw: string
  try {
    raw = await readFile(routesFilePath(), "utf8")
  } catch {
    return result // ENOENT / unreadable → no routes
  }

  try {
    assertNoLiteralSecrets(raw)
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
    return result
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    result.errors.push(`routes.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    return result
  }

  const parseResult = routesFileSchema.safeParse(parsed)
  if (!parseResult.success) {
    const issues = parseResult.error.issues
    for (const issue of issues) {
      const routeId = issue.path.length > 0 ? String(issue.path[0]) : "<root>"
      result.errors.push(`route "${routeId}": ${issue.message}`)
    }
    return result
  }

  result.routes = parseResult.data
  return result
}
