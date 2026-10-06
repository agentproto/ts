/**
 * Catalog-entry construction for the publishing pipeline (`app pack
 * --release --entry`). Pure and testable: no fs, no network. The schema is
 * the runtime's `AppCatalogEntrySchema` -- never duplicated here.
 */

import { AppCatalogEntrySchema, type AppCatalogEntry } from "@agentproto/runtime/app-catalog"

/** Base URL of the public `agentproto/apps` GitHub Releases. */
export const APP_RELEASES_BASE = "https://github.com/agentproto/apps/releases/download"

/** `<slug>` = last path segment of the appId without scope:
 *  `@agentik/session-chat` -> `session-chat`, `job-hunter` -> `job-hunter`. */
export function catalogSlug(appId: string): string {
  return appId.split("/").pop() ?? appId
}

/** Asset URL for a published bundle: tag `<slug>@<version>` (`@` encoded
 *  `%40`), asset `<slug>-<version>.agentapp`. */
export function bundleReleaseAssetUrl(slug: string, version: string): string {
  return `${APP_RELEASES_BASE}/${encodeURIComponent(`${slug}@${version}`)}/${slug}-${version}.agentapp`
}

export interface CatalogEntryInput {
  appId: string
  name?: string
  description?: string
  category?: string
  icon?: string
  placement?: AppCatalogEntry["placement"]
  version: string
  publisher?: string
  /** URL of the published `.agentapp` (GitHub Releases by default). */
  url: string
  /** Aggregate SHA-256 of the bundle, as verified by `unpackApp` /
   *  `app_install {sha256}` -- the bundle manifest's `sha256`. */
  sha256: string
  /** Size in bytes of the `.agentapp` file. */
  size: number
}

/**
 * Build + validate a bundle-tier `AppCatalogEntry` for a published
 * `.agentapp`. Throws when the resulting entry fails
 * `AppCatalogEntrySchema` (so callers can never persist an invalid entry).
 */
export function buildCatalogEntry(input: CatalogEntryInput): AppCatalogEntry {
  const entry: AppCatalogEntry = {
    appId: input.appId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.icon !== undefined ? { icon: input.icon } : {}),
    version: input.version,
    tier: "bundle",
    ...(input.placement !== undefined ? { placement: input.placement } : {}),
    ...(input.publisher !== undefined ? { publisher: input.publisher } : {}),
    license: { kind: "free" },
    source: {
      kind: "agentapp",
      url: input.url,
      sha256: input.sha256,
      version: input.version,
      size: input.size,
    },
  }
  const parsed = AppCatalogEntrySchema.safeParse(entry)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
      .join("; ")
    throw new Error(`invalid catalog entry for ${input.appId}: ${detail}`)
  }
  return parsed.data
}
